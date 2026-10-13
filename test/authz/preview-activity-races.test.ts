/**
 * Preview activity rows under concurrent opens and closely spaced heartbeats: one row
 * and one preview.start event per viewer/session/version, and a finalizer chain that
 * never ends while the activity is still open.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createCorrelationId, createOpaqueId, createOpaqueSecret } from '@duefold/shared/ids';
import { digestSecret } from '../../modules/core-security/src/sessions.ts';
import {
  bootstrapPool,
  closePools,
  databasePool,
  migrationPool,
  workerPool,
} from './support/database.ts';
import { resetRoomSchema, seedRoom, seedViewerWithRoomGrant } from './support/room-fixture.ts';

let roomId = '';
let viewerId = '';
const documentId = createOpaqueId(),
  versionId = createOpaqueId();

async function viewerSession(): Promise<{ readonly id: string; readonly proof: string }> {
  const id = createOpaqueId();
  const proof = digestSecret(createOpaqueSecret());
  await migrationPool.query(
    `INSERT INTO session(id,secret_digest,csrf_digest,principal_kind,viewer_id,family_id,
       state,idle_expires_at,absolute_expires_at)
     VALUES($1,$2,$3,'viewer',$4,$5,'active',statement_timestamp()+interval '1 hour',
       statement_timestamp()+interval '2 hours')`,
    [id, proof, createOpaqueId().padEnd(64, 'c'), viewerId, createOpaqueId()],
  );
  return { id, proof };
}
async function begin(client: Pool | PoolClient, proof: string): Promise<string | undefined> {
  return (
    (
      await client.query<{ id: string | null }>(
        'SELECT begin_preview_activity($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) id',
        [
          createOpaqueId(),
          proof,
          roomId,
          documentId,
          versionId,
          createCorrelationId(),
          '2026-10',
          'b'.repeat(64),
          'chromium',
          'linux',
          'desktop',
          createOpaqueId(),
        ],
      )
    ).rows[0]?.id ?? undefined
  );
}
async function waitUntilBlocked(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const row = (
      await bootstrapPool.query<{ wait_event_type: string | null }>(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',
        [pid],
      )
    ).rows[0];
    if (row?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('SECOND_OPEN_NEVER_BLOCKED');
}
async function finalizerJobs(activityId: string, state?: string): Promise<number> {
  const row = (
    await migrationPool.query<{ n: number }>(
      `SELECT count(*)::int n FROM job_queue WHERE job_type='preview.inactivity.finalize'
         AND payload->>'activityId'=$1 AND ($2::text IS NULL OR state=$2)`,
      [activityId, state ?? null],
    )
  ).rows[0];
  return row?.n ?? 0;
}
async function runFinalizer(activityId: string): Promise<string | undefined> {
  const owner = createOpaqueId(),
    token = createOpaqueId();
  const job = (
    await migrationPool.query<{ id: string }>(
      `UPDATE job_queue SET state='running',attempts=attempts+1,lease_owner=$2,lease_token=$3,
         lease_expires_at=statement_timestamp()+interval '2 minutes'
       WHERE id=(SELECT id FROM job_queue WHERE job_type='preview.inactivity.finalize'
         AND payload->>'activityId'=$1 AND state='pending' ORDER BY available_at LIMIT 1)
       RETURNING id`,
      [activityId, owner, token],
    )
  ).rows[0];
  if (job === undefined) throw new Error('FINALIZER_ABSENT');
  const result = (
    await workerPool.query<{ r: string }>(
      'SELECT finalize_or_reschedule_preview($1,$2,$3,$4,$5) r',
      [activityId, job.id, owner, token, createOpaqueId()],
    )
  ).rows[0]?.r;
  await migrationPool.query(
    "UPDATE job_queue SET state='succeeded',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1",
    [job.id],
  );
  return result;
}

beforeAll(async () => {
  const ownerId = await resetRoomSchema('Preview races');
  roomId = await seedRoom(ownerId, 'Preview race room');
  viewerId = await seedViewerWithRoomGrant(roomId, ownerId, 'race.viewer');
  const jobId = createOpaqueId(),
    token = createOpaqueId();
  await migrationPool.query(
    "INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,'Race model',$3)",
    [documentId, roomId, ownerId],
  );
  await migrationPool.query(
    `INSERT INTO job_queue(id,job_type,idempotency_key,payload,state,attempts,lease_owner,lease_token,lease_expires_at)
     VALUES($1,'document.source.validate',$2,jsonb_build_object('versionId',$3::text),'running',1,$4,$5,
       transaction_timestamp()+interval '1 hour')`,
    [jobId, createOpaqueId(), versionId, createOpaqueId(), token],
  );
  await migrationPool.query(
    `INSERT INTO document_version(id,document_id,original_filename,object_key,declared_media_type,
       detected_media_type,size_bytes,sha256,state,scan_signature_version)
     VALUES($1,$2,'model.pdf',$3,'application/pdf','application/pdf',10,$4,'ready_for_review','1')`,
    [
      versionId,
      documentId,
      `quarantine/${createOpaqueId()}/${createOpaqueId()}`,
      'a'.repeat(64),
    ],
  );
  await migrationPool.query(
    `INSERT INTO document_scan_evidence(version_id,job_id,lease_token,signature_version,signatures_published_at)
     VALUES($1,$2,$3,'1',transaction_timestamp())`,
    [versionId, jobId, token],
  );
  await migrationPool.query(
    `INSERT INTO document_derivative(id,version_id,page_number,object_key,media_type,size_bytes,sha256,width,height,accessible_label)
     VALUES($1,$2,1,$3,'image/png',10,$4,100,100,'Page 1')`,
    [
      createOpaqueId(),
      versionId,
      `derivatives/${versionId}/${createOpaqueId()}`,
      'b'.repeat(64),
    ],
  );
  await migrationPool.query(
    `INSERT INTO published_structure_entry(room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,order_key,source_revision,published_version_id)
     VALUES($1,$2,'document',$3,NULL,'Race model','',1000,1,$4)`,
    [roomId, createOpaqueId(), documentId, versionId],
  );
  await migrationPool.query(
    "UPDATE room SET state='published',published_revision=1,published_at=transaction_timestamp() WHERE id=$1",
    [roomId],
  );
});

afterAll(closePools);

describe('preview activity races', () => {
  it('lets two tabs opening a document at once share one activity and one start event', async () => {
    const session = await viewerSession();
    const first = await databasePool.connect();
    const second = await databasePool.connect();
    try {
      await first.query('BEGIN');
      const firstId = await begin(first, session.proof);
      if (firstId === undefined) throw new Error('ACTIVITY_ABSENT');
      const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]
        ?.pid;
      if (pid === undefined) throw new Error('PID_ABSENT');
      const secondOpen = begin(second, session.proof);
      await waitUntilBlocked(pid);
      await first.query('COMMIT');
      expect(await secondOpen).toBe(firstId);
      expect(
        (
          await migrationPool.query<{ n: number }>(
            "SELECT count(*)::int n FROM audit_event WHERE event_type='preview.start' AND subject_id=$1",
            [session.id],
          )
        ).rows[0]?.n,
      ).toBe(1);
      expect(await finalizerJobs(firstId)).toBe(1);
    } finally {
      first.release();
      second.release();
    }
  });

  it('queues a successor when the heartbeat moved within the running finalizer key second', async () => {
    const session = await viewerSession();
    const activityId = await begin(databasePool, session.proof);
    if (activityId === undefined) throw new Error('ACTIVITY_ABSENT');
    await migrationPool.query(
      "UPDATE preview_activity SET heartbeat_at=statement_timestamp()-interval '1 minute' WHERE id=$1",
      [activityId],
    );
    expect(await runFinalizer(activityId)).toBe('rescheduled');
    // The successor's key is derived from that heartbeat; a later one a microsecond on
    // must still produce a distinct key, not the running job's own.
    await migrationPool.query(
      "UPDATE preview_activity SET heartbeat_at=heartbeat_at+interval '1 microsecond' WHERE id=$1",
      [activityId],
    );
    expect(await runFinalizer(activityId)).toBe('rescheduled');
    expect(await finalizerJobs(activityId, 'pending')).toBe(1);
  });
});
