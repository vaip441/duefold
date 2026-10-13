/**
 * What a viewer grant reaches beyond the document itself: authorizer reachability, folder
 * descriptions in search, a reopened preview, and the caches a revocation re-checks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  readViewerStructure,
  searchViewerStructure,
} from '../../modules/rooms-documents/src/viewer-discovery.ts';
import {
  migrationPool,
  runtimePool,
  workerPool,
  roomId,
  versionId,
  freshOidcAt,
  viewerIdentity,
  audit,
  roomRevision,
  addViewer,
  grant,
  managerId,
  nestedFolderId,
  documentId,
  closeParticipantGrantPools,
  seedParticipantGrants,
} from './support/participant-grants-fixture.ts';

beforeAll(seedParticipantGrants);
afterAll(closeParticipantGrantPools);

describe('viewer authorizers taking a caller-supplied identity', () => {
  it('keeps caller-supplied-identity viewer authorizers out of reach of the web role', async () => {
    for (const signature of [
      'viewer_can_preview_document(text,text,text,text)',
      'authorize_viewer_published_room(text,text,text)',
      'read_viewer_document_download_policy(text,text,text,text)',
    ])
      expect(
        (
          await migrationPool.query<{ allowed: boolean }>(
            "SELECT has_function_privilege('duefold_runtime',$1,'EXECUTE') allowed",
            [signature],
          )
        ).rows[0]?.allowed,
        signature,
      ).toBe(false);
    expect(
      (
        await migrationPool.query<{ fn: string | null }>(
          "SELECT to_regprocedure('record_preview_page(text,text,text,integer)')::text fn",
        )
      ).rows[0]?.fn,
    ).toBeNull();
  });
});

describe('viewer search over path-only folders', () => {
  it('does not match words of a folder description the viewer cannot open', async () => {
    const pathOnlyViewer = createOpaqueId(),
      folderViewer = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,'path.only@example.com','path.only@example.com','active',$2),($3,'folder.granted@example.com','folder.granted@example.com','active',$4)",
      [pathOnlyViewer, createOpaqueId(), folderViewer, createOpaqueId()],
    );
    await addViewer(pathOnlyViewer);
    await addViewer(folderViewer);
    await grant({
      id: createOpaqueId(),
      granteeKind: 'viewer',
      viewerId: pathOnlyViewer,
      targetKind: 'document',
      documentId,
    });
    await grant({
      id: createOpaqueId(),
      granteeKind: 'viewer',
      viewerId: folderViewer,
      targetKind: 'folder',
      folderId: nestedFolderId,
    });
    await migrationPool.query(
      "UPDATE published_structure_entry SET description='Bluebird merger terms' WHERE room_id=$1 AND resource_id=$2",
      [roomId, nestedFolderId],
    );
    try {
      const search = (viewer: string) =>
        searchViewerStructure({
          pool: runtimePool,
          identity: viewerIdentity(viewer),
          roomId,
          query: 'Bluebird',
          limit: 10,
        });
      expect(
        await readViewerStructure({
          pool: runtimePool,
          identity: viewerIdentity(pathOnlyViewer),
          roomId,
        }),
      ).toContainEqual(
        expect.objectContaining({ resourceId: nestedFolderId, description: '' }),
      );
      expect(await search(pathOnlyViewer)).toEqual([]);
      expect(await search(folderViewer)).toEqual([
        expect.objectContaining({
          resourceId: nestedFolderId,
          description: 'Bluebird merger terms',
        }),
      ]);
    } finally {
      await migrationPool.query(
        "UPDATE published_structure_entry SET description='' WHERE room_id=$1 AND resource_id=$2",
        [roomId, nestedFolderId],
      );
    }
  });
});

describe('Preview lifecycle and grant-revocation cache scope', () => {
  async function grantedViewer(email: string): Promise<{ id: string; grantId: string }> {
    const id = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,$2,$2,'active',$3)",
      [id, email, createOpaqueId()],
    );
    await addViewer(id);
    const grantId = createOpaqueId();
    await grant({
      id: grantId,
      granteeKind: 'viewer',
      viewerId: id,
      targetKind: 'document',
      documentId,
    });
    return { id, grantId };
  }
  async function leaseFinalizer(activityId: string) {
    const owner = createOpaqueId(),
      token = createOpaqueId();
    const job = (
      await migrationPool.query<{ id: string }>(
        `UPDATE job_queue SET state='running',attempts=attempts+1,lease_owner=$2,lease_token=$3,
           lease_expires_at=statement_timestamp()+interval '2 minutes'
         WHERE job_type='preview.inactivity.finalize' AND payload->>'activityId'=$1 AND state='pending'
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

  it('summarizes a reopened activity whose earlier finalizer already ended', async () => {
    const viewer = await grantedViewer('reopen-viewer@example.com');
    const identity = viewerIdentity(viewer.id);
    const begin = async () =>
      (
        await runtimePool.query<{ id: string }>(
          'SELECT begin_preview_activity($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) id',
          [
            createOpaqueId(),
            identity.sessionProof,
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
      ).rows[0]?.id;
    const activityId = await begin();
    if (activityId === undefined) throw new Error('ACTIVITY_ABSENT');
    await runtimePool.query('SELECT summarize_preview($1,$2,$3,$4)', [
      activityId,
      identity.sessionProof,
      'closed',
      createOpaqueId(),
    ]);
    expect(await leaseFinalizer(activityId)).toBe('already-final');
    expect(await begin()).toBe(activityId);
    await migrationPool.query(
      "UPDATE preview_activity SET heartbeat_at=statement_timestamp()-interval '3 minutes' WHERE id=$1",
      [activityId],
    );
    expect(await leaseFinalizer(activityId)).toBe('summarized');
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM preview_activity WHERE id=$1',
          [activityId],
        )
      ).rows[0]?.state,
    ).toBe('inactive');
  });

  it('re-checks only the revoked grantee caches when a grant is revoked', async () => {
    const revoked = await grantedViewer('revoked-cache@example.com');
    const bystander = await grantedViewer('bystander-cache@example.com');
    const derivativeId = (
      await migrationPool.query<{ id: string }>(
        'SELECT id FROM document_derivative WHERE version_id=$1 AND page_number=1',
        [versionId],
      )
    ).rows[0]?.id;
    const cache = async (viewer: string): Promise<string> => {
      const id = createOpaqueId();
      await migrationPool.query(
        `INSERT INTO watermark_cache(id,viewer_id,session_id,room_id,document_id,version_id,derivative_id,
           page_number,object_key,media_type,state,access_date,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,'image/png','active',current_date,statement_timestamp()+interval '1 hour')`,
        [
          id,
          viewer,
          viewerIdentity(viewer).sessionId,
          roomId,
          documentId,
          versionId,
          derivativeId,
          `watermarks/${createOpaqueId()}/${createOpaqueId()}`,
        ],
      );
      return id;
    };
    const revokedCache = await cache(revoked.id);
    const bystanderCache = await cache(bystander.id);
    // An idle-expired session fails the re-check without any revocation, so only
    // the trigger's grantee scope keeps the bystander's cache out of this revoke.
    await migrationPool.query(
      'UPDATE session SET idle_expires_at=statement_timestamp() WHERE id=$1',
      [viewerIdentity(bystander.id).sessionId],
    );
    const args = [
      managerId,
      roomId,
      'revoke',
      revoked.grantId,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ];
    const impact = (
      await runtimePool.query<{ dry_run_grant_change: { confirmation: string } }>(
        'SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        args,
      )
    ).rows[0]?.dry_run_grant_change;
    if (!impact) throw new Error('REVOKE_IMPACT_ABSENT');
    await runtimePool.query(
      'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [...args, await roomRevision(), freshOidcAt, impact.confirmation, ...audit()],
    );
    const states = await migrationPool.query<{ id: string; state: string }>(
      'SELECT id,state FROM watermark_cache WHERE id=ANY($1)',
      [[revokedCache, bystanderCache]],
    );
    expect(Object.fromEntries(states.rows.map((row) => [row.id, row.state]))).toEqual({
      [revokedCache]: 'deletion_pending',
      [bystanderCache]: 'active',
    });
  });
});
