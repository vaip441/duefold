/**
 * The populated room the participant-grant suites share: members, viewers, counterparties,
 * a published structure with a ready and an unready document, and two grants.
 */
import { Pool } from 'pg';
import { createCorrelationId, createOpaqueId, createOpaqueSecret } from '@duefold/shared/ids';
import { digestSecret } from '../../../modules/core-security/src/sessions.ts';
import { generatedMigrations } from '../../../.duefold/generated/migrations.ts';
import { migrate } from '../../../modules/core-security/src/db/migrate.ts';

const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
});
export const migrationPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
});
export const runtimePool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_DATABASE_URL'],
});
const authPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_AUTH_DATABASE_URL'],
});
export const workerPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_WORKER_DATABASE_URL'],
});

export const ownerId = createOpaqueId(),
  managerId = createOpaqueId(),
  contributorId = createOpaqueId();
export const roomId = createOpaqueId(),
  otherRoomId = createOpaqueId();
export const viewerId = createOpaqueId(),
  directViewerId = createOpaqueId(),
  deniedViewerId = createOpaqueId();
export const counterpartyId = createOpaqueId(),
  secondCounterpartyId = createOpaqueId();
export const folderId = createOpaqueId(),
  nestedFolderId = createOpaqueId(),
  hiddenFolderId = createOpaqueId(),
  documentId = createOpaqueId(),
  unreadyDocumentId = createOpaqueId();
export const versionId = createOpaqueId(),
  unreadyVersionId = createOpaqueId();
export const counterpartyGrantId = createOpaqueId(),
  directGrantId = createOpaqueId();
const viewerSessions = new Map<string, { readonly id: string; readonly proof: string }>();
export const freshOidcAt = new Date();

export function viewerIdentity(id: string) {
  const session = viewerSessions.get(id);
  if (session === undefined) throw new Error('VIEWER_SESSION_FIXTURE_ABSENT');
  return { kind: 'viewer' as const, id, sessionId: session.id, sessionProof: session.proof };
}
export async function createViewerSession(viewer: string): Promise<string> {
  const sessionId = createOpaqueId();
  const secret = createOpaqueSecret();
  const proof = digestSecret(secret);
  await authPool.query(
    `INSERT INTO session(id,secret_digest,csrf_digest,principal_kind,viewer_id,family_id,
       state,idle_expires_at,absolute_expires_at)
     VALUES($1,$2,$3,'viewer',$4,$5,'active',statement_timestamp()+interval '1 hour',
       statement_timestamp()+interval '2 hours')`,
    [sessionId, proof, createOpaqueId().padEnd(64, 'c'), viewer, createOpaqueId()],
  );
  viewerSessions.set(viewer, { id: sessionId, proof });
  return sessionId;
}

export function audit(): readonly [string, string] {
  return [createOpaqueId(), createCorrelationId()];
}
// The caller-supplied-identity authorizer is reachable only by its owner and the
// digest-bound SECURITY DEFINER entry points, so fixtures call it as the owner.
interface FixtureViewer {
  readonly id: string;
  readonly sessionId: string;
}
export async function canViewerPreviewDocument(identity: FixtureViewer): Promise<boolean> {
  const result = await migrationPool.query<{ allowed: boolean }>(
    'SELECT viewer_can_preview_document($1,$2,$3,$4) allowed',
    [identity.id, identity.sessionId, roomId, documentId],
  );
  return result.rows[0]?.allowed === true;
}
export async function roomRevision(id = roomId): Promise<number> {
  const row = (
    await migrationPool.query<{ revision: number }>('SELECT revision FROM room WHERE id=$1', [
      id,
    ])
  ).rows[0];
  if (!row) throw new Error('ROOM_ABSENT');
  return row.revision;
}
export async function createCounterparty(
  id: string,
  room: string,
  name: string,
): Promise<void> {
  await runtimePool.query('SELECT create_counterparty($1,$2,$3,$4,$5,$6,$7)', [
    id,
    room,
    name,
    managerId,
    await roomRevision(room),
    ...audit(),
  ]);
}
export async function addViewer(viewer: string, room = roomId): Promise<void> {
  await runtimePool.query('SELECT add_viewer_to_room($1,$2,$3,$4,$5,$6,$7)', [
    createOpaqueId(),
    viewer,
    room,
    managerId,
    await roomRevision(room),
    ...audit(),
  ]);
  if (!viewerSessions.has(viewer)) await createViewerSession(viewer);
}
export async function assign(
  counterparty: string,
  viewer: string,
  room = roomId,
): Promise<void> {
  await runtimePool.query('SELECT assign_viewer_counterparty($1,$2,$3,$4,$5,$6,$7,$8)', [
    createOpaqueId(),
    counterparty,
    viewer,
    room,
    managerId,
    await roomRevision(room),
    ...audit(),
  ]);
}
interface GrantInput {
  readonly id: string;
  readonly granteeKind: 'viewer' | 'counterparty';
  readonly viewerId?: string;
  readonly counterpartyId?: string;
  readonly targetKind: 'room' | 'folder' | 'document';
  readonly folderId?: string;
  readonly documentId?: string;
  readonly expiresAt?: Date;
}
type GrantChange = readonly [
  action: 'grant' | 'revoke' | 'expiry',
  grantId: string,
  granteeKind: GrantInput['granteeKind'] | null,
  viewerId: string | null,
  counterpartyId: string | null,
  targetKind: GrantInput['targetKind'] | null,
  folderId: string | null,
  documentId: string | null,
  expiresAt: Date | null,
];
/** Dry-runs and applies one manager grant change, returning its impact and audit id. */
export async function changeGrant(change: GrantChange): Promise<{
  readonly impact: { readonly resolvedExpiresAt: string | null };
  readonly auditId: string;
}> {
  const args = [managerId, roomId, ...change];
  const impact = (
    await runtimePool.query<{
      dry_run_grant_change: { confirmation: string; resolvedExpiresAt: string | null };
    }>('SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', args)
  ).rows[0]?.dry_run_grant_change;
  if (!impact) throw new Error('GRANT_IMPACT_ABSENT');
  const [auditId, correlationId] = audit();
  await runtimePool.query(
    'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
    [...args, await roomRevision(), freshOidcAt, impact.confirmation, auditId, correlationId],
  );
  return { impact, auditId };
}
export async function grant(input: GrantInput): Promise<{ resolvedExpiresAt: string | null }> {
  return (
    await changeGrant([
      'grant',
      input.id,
      input.granteeKind,
      input.viewerId ?? null,
      input.counterpartyId ?? null,
      input.targetKind,
      input.folderId ?? null,
      input.documentId ?? null,
      input.expiresAt ?? null,
    ])
  ).impact;
}

/** Resets the schema and seeds the rooms, members, viewers, publication and grants. */
export async function seedParticipantGrants(): Promise<void> {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    for (const [id, email, role] of [
      [ownerId, 'grant-owner@example.com', 'owner'],
      [managerId, 'grant-manager@example.com', 'member'],
      [contributorId, 'grant-contributor@example.com', 'member'],
    ] as const)
      await client.query(
        "INSERT INTO member(id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES($1,$2,$2,'https://issuer.example',$1,$3,'active')",
        [id, email, role],
      );
    await client.query("INSERT INTO organization(id,name) VALUES($1,'Grant authz')", [
      createOpaqueId(),
    ]);
    for (const [id, email] of [
      [viewerId, 'αλέξανδρος@example.com'],
      [directViewerId, '投資家@example.com'],
      [deniedViewerId, 'denied@example.com'],
    ] as const)
      await client.query(
        "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,$2,$2,'active',$3)",
        [id, email, createOpaqueId()],
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await runtimePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
    roomId,
    'Published grants room',
    '',
    ownerId,
    ...audit(),
  ]);
  await runtimePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
    otherRoomId,
    'Other room',
    '',
    ownerId,
    ...audit(),
  ]);
  /* Migration 017 revoked direct room_assignment DML from the runtime credential,
   * so this fixture uses the migration credential's schema authority. */
  await migrationPool.query(
    "INSERT INTO room_assignment(id,room_id,member_id,room_role) VALUES($1,$2,$3,'manager'),($4,$2,$5,'contributor'),($6,$7,$3,'manager')",
    [
      createOpaqueId(),
      roomId,
      managerId,
      createOpaqueId(),
      contributorId,
      createOpaqueId(),
      otherRoomId,
    ],
  );
  await createCounterparty(counterpartyId, roomId, '有限会社 投資家 — Δοκιμή');
  await createCounterparty(secondCounterpartyId, roomId, 'Teine osapool');
  await addViewer(viewerId);
  await addViewer(directViewerId);
  await addViewer(deniedViewerId);
  await assign(counterpartyId, viewerId);

  // Migration-owner fixtures model the already-reviewed publication pipeline;
  // this suite tests the authorization boundary, not conversion mechanics.
  await migrationPool.query(
    "INSERT INTO folder(id,room_id,description,created_by) VALUES($1,$2,'',$3),($4,$2,'',$3),($5,$2,'',$3)",
    [folderId, roomId, contributorId, nestedFolderId, hiddenFolderId],
  );
  await migrationPool.query(
    "INSERT INTO document(id,room_id,display_title,description,created_by) VALUES($1,$2,'Investor model','',$3),($4,$2,'Unready quarterly model','',$3)",
    [documentId, roomId, contributorId, unreadyDocumentId],
  );
  const jobId = createOpaqueId(),
    token = createOpaqueId();
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
    `INSERT INTO document_version(id,document_id,original_filename,object_key,declared_media_type,
    detected_media_type,size_bytes,sha256,state,scan_signature_version)
    VALUES($1,$2,'unready.pdf',$3,'application/pdf','application/pdf',10,$4,'source_validated',NULL)`,
    [
      unreadyVersionId,
      unreadyDocumentId,
      `quarantine/${createOpaqueId()}/${createOpaqueId()}`,
      'b'.repeat(64),
    ],
  );
  await migrationPool.query(
    `INSERT INTO document_derivative(id,version_id,page_number,object_key,media_type,size_bytes,sha256,width,height,accessible_label)
     VALUES($1,$2,1,$3,'image/png',10,$4,100,100,'Unready page')`,
    [
      createOpaqueId(),
      unreadyVersionId,
      `derivatives/${createOpaqueId()}/${createOpaqueId()}`,
      'd'.repeat(64),
    ],
  );
  await migrationPool.query(
    `INSERT INTO document_scan_evidence(version_id,job_id,lease_token,signature_version,signatures_published_at)
    VALUES($1,$2,$3,'1',transaction_timestamp())`,
    [versionId, jobId, token],
  );
  await migrationPool.query(
    `INSERT INTO document_derivative(id,version_id,page_number,object_key,media_type,size_bytes,sha256,width,height,accessible_label)
    VALUES($1,$2,1,$3,'image/png',10,$4,1,1,'Page 1')`,
    [
      createOpaqueId(),
      versionId,
      `derivatives/${createOpaqueId()}/${createOpaqueId()}`,
      'b'.repeat(64),
    ],
  );
  await migrationPool.query(
    `INSERT INTO working_structure_entry(id,room_id,folder_id,document_id,parent_folder_id,display_name,order_key)
     VALUES($1,$2,$1,NULL,NULL,'Data room',1000),
       ($3,$2,$3,NULL,$1,'Finantsid 財務',2000),
       ($4,$2,NULL,$5,$3,'Investor model',3000),
       ($6,$2,$6,NULL,NULL,'Unpublished acquisition secret',4000)`,
    [folderId, roomId, nestedFolderId, createOpaqueId(), documentId, hiddenFolderId],
  );
  await migrationPool.query(
    `INSERT INTO published_structure_entry(room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,order_key,source_revision,published_version_id)
    VALUES($1,$2,'folder',$2,NULL,'Data room','',1000,1,NULL),
      ($1,$3,'folder',$3,$2,'Finantsid 財務','',2000,1,NULL),
      ($1,$4,'document',$5,$3,'Investor model','',3000,1,$6),
      ($1,$8,'document',$9,$3,'Unready quarterly model','',3500,1,$10),
      ($1,$7,'folder',$7,NULL,'Hidden acquisition sibling','',4000,1,NULL)`,
    [
      roomId,
      folderId,
      nestedFolderId,
      createOpaqueId(),
      documentId,
      versionId,
      hiddenFolderId,
      createOpaqueId(),
      unreadyDocumentId,
      unreadyVersionId,
    ],
  );
  await migrationPool.query(
    "UPDATE room SET state='published',published_revision=1,published_at=transaction_timestamp() WHERE id=$1",
    [roomId],
  );

  await grant({
    id: counterpartyGrantId,
    granteeKind: 'counterparty',
    counterpartyId,
    targetKind: 'room',
  });
  await grant({
    id: directGrantId,
    granteeKind: 'viewer',
    viewerId: directViewerId,
    targetKind: 'document',
    documentId,
  });
}

export async function closeParticipantGrantPools(): Promise<void> {
  await authPool.end();
  await runtimePool.end();
  await workerPool.end();
  await migrationPool.end();
  await bootstrapPool.end();
}
