import {
  renderRoomSecurityNotice,
  SECURITY_EVENT_CLASSES,
} from '../../modules/core-security/src/auth/mail.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { createOpaqueId, createCorrelationId } from '@duefold/shared/ids';
import { createHandler as createRoomPurgeHandler } from '../../modules/rooms-documents/src/jobs/room-purge.ts';
import type { WorkerStorage } from '../../modules/rooms-documents/src/storage/s3-compatible.ts';
import {
  assertExternalEnablementAllowed,
  backupStatus,
  createSupportBundle,
  reconcileDeletionMarker,
  localRestoreDrillChecks,
  restoreDrill,
} from '../../apps/cli/src/lifecycle.ts';

const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
});
const migrationPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
});
const runtimePool = new Pool({ connectionString: process.env['DUEFOLD_TEST_DATABASE_URL'] });
const workerPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_WORKER_DATABASE_URL'],
});
const ownerId = createOpaqueId();
const adminId = createOpaqueId();
const retentionRoomId = createOpaqueId();
const purgeRoomId = createOpaqueId();
const viewerId = createOpaqueId();
const documentId = createOpaqueId();
const versionId = createOpaqueId();
const derivativeId = createOpaqueId();
const entryId = createOpaqueId();
const directGrantId = createOpaqueId();
const distinctiveRoom = 'PURGE_SECRET_ROOM_91D';
const distinctiveEmail = 'purge-secret-91d@example.com';
const distinctiveFilename = 'PURGE_SECRET_FILE_91D.pdf';
const sourceKey = `quarantine/${createOpaqueId()}/${createOpaqueId()}`;
const derivativeKey = `derivatives/${createOpaqueId()}/${createOpaqueId()}`;

async function roomRevision(id: string): Promise<number> {
  const row = await migrationPool.query<{ revision: number }>(
    'SELECT revision FROM room WHERE id=$1',
    [id],
  );
  const revision = row.rows[0]?.revision;
  if (revision === undefined) throw new Error('fixture room absent');
  return revision;
}

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO member(id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
       VALUES($1,'owner@lifecycle.example','owner@lifecycle.example','https://issuer.example','owner-lifecycle','owner','active'),
             ($2,'admin@lifecycle.example','admin@lifecycle.example','https://issuer.example','admin-lifecycle','admin','active')`,
      [ownerId, adminId],
    );
    await client.query("INSERT INTO organization(id,name) VALUES($1,'Lifecycle')", [
      createOpaqueId(),
    ]);
    await client.query(
      `INSERT INTO room(id,title,state,description) VALUES
        ($1,'Retention room','draft',''),($2,$3,'archived','')`,
      [retentionRoomId, purgeRoomId, distinctiveRoom],
    );
    await client.query(
      `INSERT INTO viewer(id,email_key,email_display,state,session_family_id)
       VALUES($1,$2,$2,'active',$3)`,
      [viewerId, distinctiveEmail, createOpaqueId()],
    );
    await client.query(
      `INSERT INTO session(id,secret_digest,csrf_digest,principal_kind,viewer_id,family_id,
        idle_expires_at,absolute_expires_at)
       VALUES($1,$2,$3,'viewer',$4,$5,statement_timestamp()+interval '1 hour',
         statement_timestamp()+interval '8 hours')`,
      [createOpaqueId(), 'a'.repeat(64), 'b'.repeat(64), viewerId, createOpaqueId()],
    );
    await client.query(
      `INSERT INTO viewer_room_membership(id,viewer_id,room_id) VALUES($1,$2,$3)`,
      [createOpaqueId(), viewerId, purgeRoomId],
    );
    await client.query(
      `INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,'Visible document',$3)`,
      [documentId, purgeRoomId, ownerId],
    );
    await client.query(
      `INSERT INTO document_version(id,document_id,original_filename,object_key,declared_media_type,size_bytes,state)
       VALUES($1,$2,$3,$4,'application/pdf',10,'quarantine')`,
      [versionId, documentId, distinctiveFilename, sourceKey],
    );
    await client.query(
      `INSERT INTO document_derivative(id,version_id,page_number,object_key,media_type,size_bytes,
        sha256,width,height,accessible_label)
       VALUES($1,$2,1,$3,'image/png',10,$4,100,100,'Page 1')`,
      [derivativeId, versionId, derivativeKey, 'c'.repeat(64)],
    );
    await client.query(
      `INSERT INTO working_structure_entry(id,room_id,document_id,display_name,order_key)
       VALUES($1,$2,$3,'Published display name',1)`,
      [entryId, purgeRoomId, documentId],
    );
    await client.query(
      `INSERT INTO access_grant(id,room_id,grantee_kind,viewer_id,target_kind,document_id,created_by)
       VALUES($1,$2,'viewer',$3,'document',$4,$5)`,
      [directGrantId, purgeRoomId, viewerId, documentId, ownerId],
    );
    await client.query(
      `INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
        result,reason_code,correlation_id)
       VALUES($1,'viewer.access','viewer',$2,$3,'document',$4,'success','VIEWED',$5)`,
      [createOpaqueId(), viewerId, purgeRoomId, documentId, createCorrelationId()],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await workerPool.end();
  await runtimePool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

describe('retention and room lifecycle', () => {
  it('fails the migration-checksum check when the installed ledger diverges from the composed registry', async () => {
    /*
     * Counting ledger rows passed a corrupt, partial, reordered, or foreign
     * ledger, which is precisely the false restore evidence this drill exists to
     * prevent. Both arms run against the SAME fully migrated database: the
     * checksum matches first, then a single tampered checksum must fail.
     */
    const checks = localRestoreDrillChecks(migrationPool);
    expect(await checks.migrationChecksums()).toMatchObject({ status: 'passed' });
    const victim = (
      await migrationPool.query<{ id: string; checksum: string }>(
        'SELECT id,checksum FROM duefold_migration ORDER BY id LIMIT 1',
      )
    ).rows[0];
    if (victim === undefined) throw new Error('MIGRATION_LEDGER_EMPTY');
    await migrationPool.query('UPDATE duefold_migration SET checksum=$1 WHERE id=$2', [
      'f'.repeat(64),
      victim.id,
    ]);
    try {
      const tampered = await checks.migrationChecksums();
      expect(tampered.status).toBe('failed');
      expect(tampered.detail).toContain(victim.id);
      await migrationPool.query('DELETE FROM duefold_migration WHERE id=$1', [victim.id]);
      expect((await checks.migrationChecksums()).status).toBe('failed');
    } finally {
      await migrationPool.query(
        'INSERT INTO duefold_migration (id,checksum) VALUES ($1,$2)' +
          ' ON CONFLICT (id) DO UPDATE SET checksum=EXCLUDED.checksum',
        [victim.id, victim.checksum],
      );
    }
    expect(await checks.migrationChecksums()).toMatchObject({ status: 'passed' });
  });

  it('executes local restore checks but refuses to record passed when provider checks are undetermined', async () => {
    await expect(restoreDrill(migrationPool)).rejects.toThrow('RESTORE_DRILL_UNDETERMINED');
    const row = (
      await migrationPool.query<{ restore_drill_status: string; restore_drill_detail: string }>(
        'SELECT restore_drill_status,restore_drill_detail FROM operational_recovery_status WHERE singleton',
      )
    ).rows[0];
    expect(row?.restore_drill_status).toBe('failed');
    expect(row?.restore_drill_detail).toContain('undetermined');
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='recovery.restore_drill' AND result='failure'",
        )
      ).rows[0]?.n,
    ).toBeGreaterThan(0);
  });

  it('renders every security notice from the populated room alias without reachable PII or content metadata', async () => {
    for (const eventClass of SECURITY_EVENT_CLASSES) {
      const rendered = await renderRoomSecurityNotice({
        pool: migrationPool,
        roomId: purgeRoomId,
        eventClass,
        occurredAt: new Date('2027-04-05T06:07:08.000Z'),
        authenticatedLink: 'https://duefold.example/auth/events/event_123',
      });
      const output = `${rendered.subject}\n${rendered.text}`;
      expect(output).toContain('ROOM-');
      expect(output).toContain(eventClass);
      expect(output).toContain('2027-04-05T06:07:08.000Z');
      expect(output).toContain('https://duefold.example/auth/events/event_123');
      for (const secret of [distinctiveRoom, distinctiveEmail, distinctiveFilename, sourceKey])
        expect(output).not.toContain(secret);
    }
  });
  it('changes retention prospectively before publication and refuses the same room after publication', async () => {
    const oldAudit = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO audit_event(id,event_type,actor_kind,room_id,result,reason_code,correlation_id)
       VALUES($1,'room.created','member',$2,'success','CREATED',$3)`,
      [oldAudit, retentionRoomId, createCorrelationId()],
    );
    const before = await migrationPool.query<{ retain_until: Date }>(
      'SELECT retain_until FROM audit_event WHERE id=$1',
      [oldAudit],
    );
    const impact = (
      await runtimePool.query<{ dry_run_audit_retention: { confirmation: string } }>(
        'SELECT dry_run_audit_retention($1,$2,$3)',
        [ownerId, retentionRoomId, 3],
      )
    ).rows[0]?.dry_run_audit_retention;
    if (impact === undefined) throw new Error('retention impact absent');
    await runtimePool.query(
      'SELECT apply_audit_retention($1,$2,$3,statement_timestamp(),$4,$5,$6,$7)',
      [
        ownerId,
        retentionRoomId,
        3,
        await roomRevision(retentionRoomId),
        impact.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ],
    );
    const newAudit = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO audit_event(id,event_type,actor_kind,room_id,result,reason_code,correlation_id)
       VALUES($1,'room.metadata','member',$2,'success','UPDATED',$3)`,
      [newAudit, retentionRoomId, createCorrelationId()],
    );
    const retained = await migrationPool.query<{ id: string; years: number }>(
      `SELECT id,round(extract(epoch FROM (retain_until-occurred_at))/31557600)::int years
       FROM audit_event WHERE id=ANY($1::text[]) ORDER BY id`,
      [[oldAudit, newAudit]],
    );
    expect(new Map(retained.rows.map((row) => [row.id, row.years]))).toEqual(
      new Map([
        [oldAudit, 7],
        [newAudit, 3],
      ]),
    );
    expect(before.rows[0]?.retain_until.toISOString()).toBe(
      (
        await migrationPool.query<{ retain_until: Date }>(
          'SELECT retain_until FROM audit_event WHERE id=$1',
          [oldAudit],
        )
      ).rows[0]?.retain_until.toISOString(),
    );
    await migrationPool.query("UPDATE room SET state='published' WHERE id=$1", [
      retentionRoomId,
    ]);
    await expect(
      runtimePool.query('SELECT dry_run_audit_retention($1,$2,$3)', [
        ownerId,
        retentionRoomId,
        5,
      ]),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('requires Owner, fixes the cancellation interval at 30 days, and allows then closes cancellation', async () => {
    await expect(
      runtimePool.query('SELECT dry_run_room_purge($1,$2)', [adminId, purgeRoomId]),
    ).rejects.toMatchObject({ code: '42501' });
    const impact = (
      await runtimePool.query<{
        dry_run_room_purge: { confirmation: string; documentCount: number };
      }>('SELECT dry_run_room_purge($1,$2)', [ownerId, purgeRoomId])
    ).rows[0]?.dry_run_room_purge;
    expect(impact?.documentCount).toBe(1);
    const purgeId = createOpaqueId();
    const markerKey = `system/deletion-markers/v1/${purgeRoomId}/${purgeId}.json`;
    const result = (
      await runtimePool.query<{ schedule_room_purge: { purgeAfter: string } }>(
        'SELECT schedule_room_purge($1,$2,$3,statement_timestamp(),$4,$5,$6,$7,$8,$9)',
        [
          purgeId,
          ownerId,
          purgeRoomId,
          await roomRevision(purgeRoomId),
          impact?.confirmation,
          markerKey,
          createOpaqueId(),
          createOpaqueId(),
          createCorrelationId(),
        ],
      )
    ).rows[0]?.schedule_room_purge;
    expect(result).toBeDefined();
    expect(
      (
        await migrationPool.query<{ seconds: string }>(
          'SELECT extract(epoch FROM (purge_after-scheduled_at))::text seconds FROM room_purge WHERE id=$1',
          [purgeId],
        )
      ).rows[0]?.seconds,
    ).toBe('2592000.000000');
    await expect(
      runtimePool.query('SELECT cancel_room_purge($1,$2,$3,$4,$5)', [
        purgeId,
        ownerId,
        'WRONG',
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '22023' });
    await runtimePool.query('SELECT cancel_room_purge($1,$2,$3,$4,$5)', [
      purgeId,
      ownerId,
      'CANCEL ROOM PURGE',
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM room_purge WHERE id=$1',
          [purgeId],
        )
      ).rows[0]?.state,
    ).toBe('cancelled');
    await migrationPool.query('DELETE FROM room_purge WHERE id=$1', [purgeId]);
  });

  it('writes the marker before deleting objects, pseudonymizes PII, retains audit, and gates restore enablement', async () => {
    /* The bundle is generated while every distinctive secret is still present;
     * proving absence after purge would be vacuous. */
    const populatedBundle = JSON.stringify(await createSupportBundle(migrationPool));
    for (const protectedValue of [
      distinctiveRoom,
      distinctiveEmail,
      distinctiveFilename,
      sourceKey,
    ])
      expect(populatedBundle).not.toContain(protectedValue);
    expect(populatedBundle).toContain('migrationCount');
    expect(populatedBundle).toContain('jobCounts');
    const impact = (
      await runtimePool.query<{ dry_run_room_purge: { confirmation: string } }>(
        'SELECT dry_run_room_purge($1,$2)',
        [ownerId, purgeRoomId],
      )
    ).rows[0]?.dry_run_room_purge;
    if (impact === undefined) throw new Error('purge impact absent');
    const purgeId = createOpaqueId();
    const jobId = createOpaqueId();
    const markerKey = `system/deletion-markers/v1/${purgeRoomId}/${purgeId}.json`;
    await runtimePool.query(
      'SELECT schedule_room_purge($1,$2,$3,statement_timestamp(),$4,$5,$6,$7,$8,$9)',
      [
        purgeId,
        ownerId,
        purgeRoomId,
        await roomRevision(purgeRoomId),
        impact.confirmation,
        markerKey,
        jobId,
        createOpaqueId(),
        createCorrelationId(),
      ],
    );
    await migrationPool.query(
      `UPDATE room_purge SET scheduled_at=statement_timestamp()-interval '30 days',
        purge_after=statement_timestamp() WHERE id=$1`,
      [purgeId],
    );
    await expect(
      runtimePool.query('SELECT cancel_room_purge($1,$2,$3,$4,$5)', [
        purgeId,
        ownerId,
        'CANCEL ROOM PURGE',
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '55000' });
    const leaseOwner = createOpaqueId();
    const leaseToken = createOpaqueId();
    await migrationPool.query(
      `UPDATE job_queue SET state='running',attempts=1,lease_owner=$2,lease_token=$3,
        lease_expires_at=statement_timestamp()+interval '2 minutes' WHERE id=$1`,
      [jobId, leaseOwner, leaseToken],
    );
    const events: string[] = [];
    const storage = {
      checksumSupport: true,
      checkReady: () => Promise.resolve(),
      createMultipart: () => Promise.reject(new Error('UNUSED')),
      presignPart: () => Promise.reject(new Error('UNUSED')),
      completeMultipart: () => Promise.reject(new Error('UNUSED')),
      abortMultipart: () => Promise.reject(new Error('UNUSED')),
      headObject: () => Promise.reject(new Error('UNUSED')),
      getObjectBytes: () => Promise.reject(new Error('UNUSED')),
      streamObject: () => Promise.reject(new Error('UNUSED')),
      putExportStream: () => Promise.reject(new Error('UNUSED')),
      putBrandingAsset: () => Promise.reject(new Error('UNUSED')),
      putDerivative: () => Promise.reject(new Error('UNUSED')),
      putSystemDeletionMarker: (input: { readonly key: string }) => {
        events.push(`marker:${input.key}`);
        return Promise.resolve();
      },
      deleteObject: (key: string) => {
        events.push(`delete:${key}`);
        return Promise.resolve();
      },
    } satisfies WorkerStorage;
    const handler = createRoomPurgeHandler({
      pool: workerPool,
      storage,
      piiHmacKey: Buffer.alloc(32, 9).toString('base64url'),
    });
    await handler(
      {
        id: jobId,
        job_type: 'room.whole.purge',
        payload: { purgeId },
        attempts: 1,
        max_attempts: 10,
        lease_token: leaseToken,
      },
      {
        leaseOwner,
        signal: new AbortController().signal,
        assertLease: () => Promise.resolve(),
      },
    );
    expect(events[0]).toBe(`marker:${markerKey}`);
    expect(events).toContain(`delete:${sourceKey}`);
    expect(events).toContain(`delete:${derivativeKey}`);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          'SELECT count(*)::int n FROM room WHERE id=$1',
          [purgeRoomId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          'SELECT count(*)::int n FROM document_version WHERE id=$1',
          [versionId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    const viewer = (
      await migrationPool.query<{ state: string; email_key: string; email_display: string }>(
        'SELECT state,email_key,email_display FROM viewer WHERE id=$1',
        [viewerId],
      )
    ).rows[0];
    expect(viewer).toMatchObject({
      state: 'anonymized',
      email_display: 'anonymized@invalid.example',
    });
    expect(JSON.stringify(viewer)).not.toContain(distinctiveEmail);
    const evidence = (
      await migrationPool.query<{ evidence_reference: string }>(
        'SELECT evidence_reference FROM viewer_pseudonym WHERE viewer_id=$1 AND scope=$2',
        [viewerId, `room:${purgeRoomId}`],
      )
    ).rows[0]?.evidence_reference;
    expect(evidence).toMatch(/^vref_[a-f0-9]{64}$/u);
    const purgeAudit = (
      await migrationPool.query<{
        detail: { viewerEvidenceReferences: string[] };
        retain_until: Date;
      }>(
        "SELECT detail,retain_until FROM audit_event WHERE room_id=$1 AND reason_code='ROOM_PURGED'",
        [purgeRoomId],
      )
    ).rows[0];
    expect(purgeAudit?.detail.viewerEvidenceReferences).toContain(evidence);
    expect(purgeAudit?.retain_until.getTime()).toBeGreaterThan(Date.now());
    expect(
      (
        await migrationPool.query<{ n: number }>(
          'SELECT count(*)::int n FROM viewer_room_membership WHERE room_id=$1',
          [purgeRoomId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          'SELECT count(*)::int n FROM session WHERE viewer_id=$1',
          [viewerId],
        )
      ).rows[0]?.n,
    ).toBe(0);
    await expect(assertExternalEnablementAllowed(migrationPool)).rejects.toThrow(
      'EXTERNAL_ENABLEMENT_REFUSED_DELETION_MARKERS',
    );
    const markerDocument = Buffer.from(
      JSON.stringify({ version: 1, purgeId, roomId: purgeRoomId }),
      'utf8',
    );
    await reconcileDeletionMarker(
      migrationPool,
      {
        getObjectBytes(key) {
          expect(key).toBe(markerKey);
          return Promise.resolve(markerDocument);
        },
      },
      purgeId,
    );
    await expect(assertExternalEnablementAllowed(migrationPool)).resolves.toBeUndefined();

    const bundle = JSON.stringify(await createSupportBundle(migrationPool));
    expect(bundle).not.toContain(distinctiveRoom);
    expect(bundle).not.toContain(distinctiveEmail);
    expect(bundle).not.toContain(distinctiveFilename);
    expect(bundle).not.toContain(sourceKey);
    const status = await backupStatus(migrationPool);
    expect(status['backupStatus']).toBe('undetermined');
    expect(status['statement']).toBe(
      'Provider backup status cannot be determined locally; no recovery claim is made.',
    );
  });
});
