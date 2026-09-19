import { createHandler as createRequiredMailHandler } from '../../modules/core-security/src/jobs/required-mail-delivery.ts';
import type {
  OutboundMail,
  RequiredMailer,
} from '../../modules/core-security/src/auth/mail.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { createOpaqueSecret } from '@duefold/shared/ids';
import { digestSecret } from '../../modules/core-security/src/sessions.ts';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import {
  authorizeViewerPublishedRoom,
  canViewerPreviewDocument,
} from '../../modules/rooms-documents/src/viewer-authorization.ts';
import { createDownloadLease } from '../../modules/rooms-documents/src/downloads.ts';
import { readProtectedTextLayer } from '../../modules/rooms-documents/src/protected-delivery.ts';
import {
  readViewerDocumentMetadata,
  readViewerRooms,
  readViewerStructure,
  searchViewerStructure,
} from '../../modules/rooms-documents/src/viewer-discovery.ts';
import {
  readEffectivePermissionPreview,
  resolveDocumentDownloadPolicy,
} from '../../modules/participants-access/src/grant-model.ts';
import { createHandler as createParticipantListHandler } from '../../modules/participants-access/src/routes/participant-list.ts';
import { createHandler as createInviteHandler } from '../../modules/participants-access/src/routes/participant-invite.ts';
import { createHandler as createGrantRouteHandler } from '../../modules/participants-access/src/routes/grant-change.ts';
import { FixedClock } from '@duefold/shared/clock';
import { testWebRuntime } from '../support/web-runtime.ts';

const bootstrapPool = new Pool({
  host: '/var/run/postgresql',
  database: 'duefold_test',
});
const migrationPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
});
const runtimePool = new Pool({ connectionString: process.env['DUEFOLD_TEST_DATABASE_URL'] });
const authPool = new Pool({ connectionString: process.env['DUEFOLD_TEST_AUTH_DATABASE_URL'] });
const workerPool = new Pool({
  connectionString: process.env['DUEFOLD_TEST_WORKER_DATABASE_URL'],
});

const ownerId = createOpaqueId(),
  managerId = createOpaqueId(),
  contributorId = createOpaqueId();
const roomId = createOpaqueId(),
  otherRoomId = createOpaqueId();
const viewerId = createOpaqueId(),
  directViewerId = createOpaqueId(),
  deniedViewerId = createOpaqueId();
const counterpartyId = createOpaqueId(),
  secondCounterpartyId = createOpaqueId();
const folderId = createOpaqueId(),
  nestedFolderId = createOpaqueId(),
  hiddenFolderId = createOpaqueId(),
  documentId = createOpaqueId(),
  unreadyDocumentId = createOpaqueId();
const versionId = createOpaqueId(),
  unreadyVersionId = createOpaqueId();
const counterpartyGrantId = createOpaqueId(),
  directGrantId = createOpaqueId();
const viewerSessions = new Map<string, { readonly id: string; readonly proof: string }>();
const freshOidcAt = new Date();

function viewerIdentity(id: string) {
  const session = viewerSessions.get(id);
  if (session === undefined) throw new Error('VIEWER_SESSION_FIXTURE_ABSENT');
  return { kind: 'viewer' as const, id, sessionId: session.id, sessionProof: session.proof };
}
async function createViewerSession(viewer: string): Promise<string> {
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

function audit(): readonly [string, string] {
  return [createOpaqueId(), createCorrelationId()];
}
async function roomRevision(id = roomId): Promise<number> {
  const row = (
    await migrationPool.query<{ revision: number }>('SELECT revision FROM room WHERE id=$1', [
      id,
    ])
  ).rows[0];
  if (!row) throw new Error('ROOM_ABSENT');
  return row.revision;
}
async function createCounterparty(id: string, room: string, name: string): Promise<void> {
  await runtimePool.query('SELECT create_counterparty($1,$2,$3,$4,$5,$6,$7)', [
    id,
    room,
    name,
    managerId,
    await roomRevision(room),
    ...audit(),
  ]);
}
async function addViewer(viewer: string, room = roomId): Promise<void> {
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
async function assign(counterparty: string, viewer: string, room = roomId): Promise<void> {
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
async function grant(input: GrantInput): Promise<{ resolvedExpiresAt: string | null }> {
  const args = [
    managerId,
    roomId,
    'grant',
    input.id,
    input.granteeKind,
    input.viewerId ?? null,
    input.counterpartyId ?? null,
    input.targetKind,
    input.folderId ?? null,
    input.documentId ?? null,
    input.expiresAt ?? null,
  ];
  const impact = (
    await runtimePool.query<{
      dry_run_grant_change: { confirmation: string; resolvedExpiresAt: string | null };
    }>('SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', args)
  ).rows[0]?.dry_run_grant_change;
  if (!impact) throw new Error('GRANT_IMPACT_ABSENT');
  await runtimePool.query(
    'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
    [...args, await roomRevision(), freshOidcAt, impact.confirmation, ...audit()],
  );
  return impact;
}

beforeAll(async () => {
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
  await runtimePool.query(
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
});

afterAll(async () => {
  await authPool.end();
  await runtimePool.end();
  await workerPool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

describe('Participant HTTP contracts', () => {
  const runtime = testWebRuntime({
    pool: runtimePool,
    clock: new FixedClock(freshOidcAt),
  });
  const manager = {
    kind: 'member' as const,
    id: managerId,
    globalRole: 'member' as const,
    roomRoles: { [roomId]: 'manager' as const },
    oidcAuthenticatedAt: freshOidcAt,
  };
  const contributor = {
    ...manager,
    id: contributorId,
    roomRoles: { [roomId]: 'contributor' as const },
  };

  it('lists populated participants and grants for Manager while Contributor and another room are refused', async () => {
    const allowed = await createParticipantListHandler(
      runtime,
      manager,
    )({ query: { roomId } } as never);
    expect(allowed.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          viewerId,
          grants: expect.arrayContaining([
            expect.objectContaining({ grantId: counterpartyGrantId, effective: true }),
          ]) as unknown,
        }),
      ]),
    );
    expect(
      allowed.participants.find((participant) => participant.viewerId === deniedViewerId)
        ?.grants,
    ).toEqual([]);
    await migrationPool.query(
      "UPDATE access_grant SET expires_at=statement_timestamp()-interval '1 second' WHERE id=$1",
      [directGrantId],
    );
    const withExpired = await createParticipantListHandler(
      runtime,
      manager,
    )({ query: { roomId } } as never);
    expect(
      withExpired.participants
        .flatMap((participant) => participant.grants)
        .find((item) => item.grantId === directGrantId),
    ).toMatchObject({ effective: false });
    await migrationPool.query('UPDATE access_grant SET expires_at=NULL WHERE id=$1', [
      directGrantId,
    ]);
    await expect(
      createParticipantListHandler(runtime, contributor)({ query: { roomId } } as never),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      createParticipantListHandler(
        runtime,
        contributor,
      )({ query: { roomId: otherRoomId } } as never),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('invites a viewer through the route and refuses the same populated room to Contributor', async () => {
    const revision = await roomRevision();
    const reply = { code: () => reply };
    const invited = await createInviteHandler(runtime, manager)(
      {
        body: {
          roomId,
          email: 'new-viewer@example.com',
          expectedRoomRevision: revision,
        },
      } as never,
      reply as never,
    );
    expect(invited.roomRevision).toBe(revision + 1);
    expect(invited.expiresAt).toMatch(/Z$/u);
    await expect(
      createInviteHandler(runtime, contributor)(
        {
          body: {
            roomId,
            email: 'forbidden-viewer@example.com',
            expectedRoomRevision: await roomRevision(),
          },
        } as never,
        reply as never,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('dry-runs and applies a legitimate document grant, while stale OIDC blocks broad grant and broad revoke', async () => {
    const route = createGrantRouteHandler(runtime, manager);
    const common = {
      roomId,
      changeAction: 'grant' as const,
      granteeKind: 'viewer' as const,
      viewerId: deniedViewerId,
      counterpartyId: null,
      targetKind: 'document' as const,
      folderId: null,
      documentId,
      expiresAt: null,
    };
    const dry = await route({ body: { action: 'dry-run', ...common } } as never);
    expect(dry).toMatchObject({ action: 'grant', affectedCount: 1 });
    await expect(
      createGrantRouteHandler(
        runtime,
        contributor,
      )({
        body: { action: 'dry-run', ...common },
      } as never),
    ).rejects.toMatchObject({ code: '42501' });
    const applied = await route({
      body: {
        action: 'apply',
        ...common,
        grantId: dry.grantId,
        expectedRoomRevision: await roomRevision(),
        confirmation: dry.confirmation,
      },
    } as never);
    expect(applied).toHaveProperty('roomRevision', await roomRevision());

    const expiresAt = '2027-01-01T00:00:00.000Z';
    const expiry = await route({
      body: {
        action: 'dry-run',
        roomId,
        changeAction: 'expiry',
        grantId: dry.grantId,
        granteeKind: null,
        viewerId: null,
        counterpartyId: null,
        targetKind: null,
        folderId: null,
        documentId: null,
        expiresAt,
      },
    } as never);
    const expiryApplied = await route({
      body: {
        action: 'apply',
        roomId,
        changeAction: 'expiry',
        grantId: dry.grantId,
        granteeKind: null,
        viewerId: null,
        counterpartyId: null,
        targetKind: null,
        folderId: null,
        documentId: null,
        expiresAt,
        expectedRoomRevision: await roomRevision(),
        confirmation: expiry.confirmation,
      },
    } as never);
    expect(new Date(expiryApplied.resolvedExpiresAt ?? '').toISOString()).toBe(expiresAt);

    const cleanup = await route({
      body: {
        action: 'dry-run',
        roomId,
        changeAction: 'revoke',
        grantId: dry.grantId,
        granteeKind: null,
        viewerId: null,
        counterpartyId: null,
        targetKind: null,
        folderId: null,
        documentId: null,
        expiresAt: null,
      },
    } as never);
    await route({
      body: {
        action: 'apply',
        roomId,
        changeAction: 'revoke',
        grantId: dry.grantId,
        granteeKind: null,
        viewerId: null,
        counterpartyId: null,
        targetKind: null,
        folderId: null,
        documentId: null,
        expiresAt: null,
        expectedRoomRevision: await roomRevision(),
        confirmation: cleanup.confirmation,
      },
    } as never);

    const broad = await route({
      body: {
        action: 'dry-run',
        ...common,
        targetKind: 'room',
        documentId: null,
        viewerId: directViewerId,
      },
    } as never);
    const stale = { ...manager, oidcAuthenticatedAt: new Date('2020-01-01T00:00:00Z') };
    await expect(
      createGrantRouteHandler(
        runtime,
        stale,
      )({
        body: {
          action: 'apply',
          ...common,
          targetKind: 'room',
          documentId: null,
          viewerId: directViewerId,
          grantId: broad.grantId,
          expectedRoomRevision: await roomRevision(),
          confirmation: broad.confirmation,
        },
      } as never),
    ).rejects.toThrow('FRESH_OIDC_REQUIRED');
    const broadRevoke = await createGrantRouteHandler(
      runtime,
      stale,
    )({
      body: {
        action: 'dry-run',
        roomId,
        changeAction: 'revoke',
        grantId: counterpartyGrantId,
        granteeKind: null,
        viewerId: null,
        counterpartyId: null,
        targetKind: null,
        folderId: null,
        documentId: null,
        expiresAt: null,
      },
    } as never);
    await expect(
      createGrantRouteHandler(
        runtime,
        stale,
      )({
        body: {
          action: 'apply',
          roomId,
          changeAction: 'revoke',
          grantId: counterpartyGrantId,
          granteeKind: null,
          viewerId: null,
          counterpartyId: null,
          targetKind: null,
          folderId: null,
          documentId: null,
          expiresAt: null,
          expectedRoomRevision: await roomRevision(),
          confirmation: broadRevoke.confirmation,
        },
      } as never),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('Participant and allow-only grant boundary', () => {
  it('discovers only granted published rooms, structure, search, and document metadata through the presented session', async () => {
    const granted = viewerIdentity(viewerId);
    const denied = viewerIdentity(deniedViewerId);

    // Same populated room and published document in every call: only the grant differs.
    const [grantedRooms, deniedRooms] = await Promise.all([
      readViewerRooms({ pool: runtimePool, identity: granted }),
      readViewerRooms({ pool: runtimePool, identity: denied }),
    ]);
    expect(grantedRooms).toContainEqual({
      roomId,
      title: 'Published grants room',
      description: '',
    });
    expect(deniedRooms).not.toContainEqual(expect.objectContaining({ roomId }));

    const [grantedStructure, deniedStructure] = await Promise.all([
      readViewerStructure({ pool: runtimePool, identity: granted, roomId }),
      readViewerStructure({ pool: runtimePool, identity: denied, roomId }),
    ]);
    expect(grantedStructure).toContainEqual(
      expect.objectContaining({ resourceId: documentId, displayName: 'Investor model' }),
    );
    expect(deniedStructure).toEqual([]);

    const [grantedSearch, deniedSearch] = await Promise.all([
      searchViewerStructure({
        pool: runtimePool,
        identity: granted,
        roomId,
        query: 'Investor',
        limit: 10,
      }),
      searchViewerStructure({
        pool: runtimePool,
        identity: denied,
        roomId,
        query: 'Investor',
        limit: 10,
      }),
    ]);
    expect(grantedSearch).toEqual([
      expect.objectContaining({ resourceId: documentId, displayName: 'Investor model' }),
    ]);
    expect(deniedSearch).toEqual([]);

    const [grantedDocument, deniedDocument] = await Promise.all([
      readViewerDocumentMetadata({ pool: runtimePool, identity: granted, roomId, documentId }),
      readViewerDocumentMetadata({ pool: runtimePool, identity: denied, roomId, documentId }),
    ]);
    expect(grantedDocument).toEqual({
      documentId,
      displayTitle: 'Investor model',
      publishedVersionId: versionId,
      pageCount: 1,
      downloadPolicy: 'deny',
    });
    expect(deniedDocument).toBeNull();
    // The same granted viewer and published room cannot discover a published
    // entry whose version lacks clean-scan and derivative publication evidence.
    expect(
      await readViewerDocumentMetadata({
        pool: runtimePool,
        identity: granted,
        roomId,
        documentId: unreadyDocumentId,
      }),
    ).toBeNull();
    expect(grantedStructure.map((entry) => entry.resourceId)).not.toContain(unreadyDocumentId);

    await migrationPool.query("UPDATE room SET state='draft' WHERE id=$1", [roomId]);
    try {
      expect(await readViewerRooms({ pool: runtimePool, identity: granted })).toEqual([]);
      expect(
        await readViewerStructure({ pool: runtimePool, identity: granted, roomId }),
      ).toEqual([]);
      expect(
        await searchViewerStructure({
          pool: runtimePool,
          identity: granted,
          roomId,
          query: 'Investor',
          limit: 10,
        }),
      ).toEqual([]);
      expect(
        await readViewerDocumentMetadata({
          pool: runtimePool,
          identity: granted,
          roomId,
          documentId,
        }),
      ).toBeNull();
    } finally {
      await migrationPool.query("UPDATE room SET state='published' WHERE id=$1", [roomId]);
    }

    const serialized = JSON.stringify({
      grantedRooms,
      grantedStructure,
      grantedSearch,
      grantedDocument,
    });
    expect(serialized).not.toContain('model.pdf');
    expect(serialized).not.toContain('quarantine/');
    expect(serialized).not.toContain('derivatives/');
    expect(serialized).not.toContain('orderKey');
    expect(serialized).not.toContain('createdBy');
  });

  it('hides a room whose only granted document has no publication evidence, while a ready grant in the same room still lists it', async () => {
    /*
     * Room visibility must come from the same evidence-filtered projection as the
     * structure, not from the mere existence of a grant. Retargeting the grant at
     * the unready document leaves the grant, membership, publication, and room
     * title all present -- so a leak here is specifically the missing evidence
     * check, not an empty room. The positive arm below re-targets the same grant
     * at the ready document in the same room and call.
     */
    const granted = viewerIdentity(directViewerId);
    const before = await readViewerRooms({ pool: runtimePool, identity: granted });
    expect(before.map((room) => room.roomId)).toContain(roomId);
    const retarget = await migrationPool.query(
      "UPDATE access_grant SET document_id=$1 WHERE id=$2 AND state='active'",
      [unreadyDocumentId, directGrantId],
    );
    expect(retarget.rowCount).toBe(1);
    try {
      expect(
        (await readViewerRooms({ pool: runtimePool, identity: granted })).map(
          (room) => room.roomId,
        ),
      ).not.toContain(roomId);
      expect(
        JSON.stringify(await readViewerRooms({ pool: runtimePool, identity: granted })),
      ).not.toContain('Investor');
    } finally {
      await migrationPool.query('UPDATE access_grant SET document_id=$1 WHERE id=$2', [
        documentId,
        directGrantId,
      ]);
    }
    expect(
      (await readViewerRooms({ pool: runtimePool, identity: granted })).map(
        (room) => room.roomId,
      ),
    ).toContain(roomId);
  });

  it('unions direct and counterparty grants and mints the published-room witness only after real authorization', async () => {
    const counterpartyIdentity = viewerIdentity(viewerId);
    const directIdentity = viewerIdentity(directViewerId);
    const deniedIdentity = viewerIdentity(deniedViewerId);
    const allowed = await authorizeViewerPublishedRoom({
      pool: runtimePool,
      identity: counterpartyIdentity,
      roomId,
    });
    expect(allowed).toBe(true);
    expect(
      (
        await readViewerStructure({
          pool: runtimePool,
          identity: counterpartyIdentity,
          roomId,
        })
      ).map((row) => row.displayName),
    ).toContain('Investor model');
    expect(
      await canViewerPreviewDocument({
        pool: runtimePool,
        identity: counterpartyIdentity,
        roomId,
        documentId,
      }),
    ).toBe(true);
    expect(
      await canViewerPreviewDocument({
        pool: runtimePool,
        identity: directIdentity,
        roomId,
        documentId,
      }),
    ).toBe(true);
    // Same populated room and document: no effective grant denies discovery/preview.
    expect(
      await canViewerPreviewDocument({
        pool: runtimePool,
        identity: deniedIdentity,
        roomId,
        documentId,
      }),
    ).toBe(false);
    // Same populated room and published rows: only session-checked discovery is
    // exposed to the web role; a viewer without a grant receives no rows.
    expect(
      await readViewerStructure({
        pool: runtimePool,
        identity: deniedIdentity,
        roomId,
      }),
    ).toEqual([]);
    expect(
      await authorizeViewerPublishedRoom({
        pool: runtimePool,
        identity: directIdentity,
        roomId,
      }),
    ).toBe(false);
    expect(
      await authorizeViewerPublishedRoom({
        pool: runtimePool,
        identity: deniedIdentity,
        roomId,
      }),
    ).toBe(false);
  });

  it('explains source and marks document-level exceptions without exposing the preview to Contributors', async () => {
    const manager = {
      kind: 'member' as const,
      id: managerId,
      globalRole: 'member' as const,
      roomRoles: { [roomId]: 'manager' as const },
    };
    const rows = await readEffectivePermissionPreview({
      pool: runtimePool,
      identity: manager,
      viewerId,
      roomId,
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'counterparty',
          targetKind: 'room',
          documentLevelException: false,
        }),
      ]),
    );
    const direct = await readEffectivePermissionPreview({
      pool: runtimePool,
      identity: manager,
      viewerId: directViewerId,
      roomId,
    });
    expect(direct).toEqual([
      expect.objectContaining({
        source: 'direct',
        targetKind: 'document',
        documentLevelException: true,
        path: 'Data room / Finantsid 財務 / Investor model',
      }),
    ]);
    await expect(
      runtimePool.query('SELECT * FROM read_effective_permission_preview($1,$2,$3)', [
        contributorId,
        viewerId,
        roomId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('enforces one active counterparty per viewer per room in the database while allowing another room', async () => {
    await expect(
      migrationPool.query(
        'INSERT INTO counterparty_viewer(id,counterparty_id,room_id,viewer_id) VALUES($1,$2,$3,$4)',
        [createOpaqueId(), secondCounterpartyId, roomId, viewerId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    const otherCounterparty = createOpaqueId();
    await createCounterparty(otherCounterparty, otherRoomId, 'Другой контрагент');
    await addViewer(viewerId, otherRoomId);
    await assign(otherCounterparty, viewerId, otherRoomId);
    expect(
      (
        await migrationPool.query(
          "SELECT 1 FROM counterparty_viewer WHERE viewer_id=$1 AND state='active'",
          [viewerId],
        )
      ).rowCount,
    ).toBe(2);
  });

  it('supports room, folder-subtree, and document targets while enforcing exactly one target', async () => {
    const folderViewer = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,$2,$2,'active',$3)",
      [folderViewer, 'folder-grant@example.com', createOpaqueId()],
    );
    await addViewer(folderViewer);
    await grant({
      id: createOpaqueId(),
      granteeKind: 'viewer',
      viewerId: folderViewer,
      targetKind: 'folder',
      folderId,
    });
    const identity = viewerIdentity(folderViewer);
    // The document sits two levels under folderId: this proves subtree, not only
    // an immediate-child special case.
    expect(
      await canViewerPreviewDocument({ pool: runtimePool, identity, roomId, documentId }),
    ).toBe(true);
    expect(await authorizeViewerPublishedRoom({ pool: runtimePool, identity, roomId })).toBe(
      false,
    );

    const documentProjection = await readViewerStructure({
      pool: runtimePool,
      identity,
      roomId,
    });
    await migrationPool.query(
      "UPDATE working_structure_entry SET display_name='Working-only staged title' WHERE document_id=$1",
      [documentId],
    );
    const afterWorkingChange = await readViewerStructure({
      pool: runtimePool,
      identity,
      roomId,
    });
    expect(afterWorkingChange).toEqual(documentProjection);
    await migrationPool.query(
      "UPDATE working_structure_entry SET display_name='Investor model' WHERE document_id=$1",
      [documentId],
    );
    expect(documentProjection.map((row) => row.displayName)).toEqual([
      'Data room',
      'Finantsid 財務',
      'Investor model',
    ]);
    expect(JSON.stringify(documentProjection)).not.toContain('Hidden acquisition sibling');
    expect(JSON.stringify(documentProjection)).not.toContain('Unpublished acquisition secret');

    const directProjection = await readViewerStructure({
      pool: runtimePool,
      identity: viewerIdentity(directViewerId),
      roomId,
    });
    expect(directProjection.map((row) => row.displayName)).toEqual([
      'Data room',
      'Finantsid 財務',
      'Investor model',
    ]);
    expect(JSON.stringify(directProjection)).not.toContain('Hidden acquisition sibling');
    expect(JSON.stringify(directProjection)).not.toContain('Unready quarterly model');

    const search = await searchViewerStructure({
      pool: runtimePool,
      identity,
      roomId,
      query: 'Investor',
      limit: 10,
    });
    expect(search).toEqual([
      expect.objectContaining({
        displayName: 'Investor model',
        path: 'Data room / Finantsid 財務 / Investor model',
      }),
    ]);
    const hiddenSearch = await searchViewerStructure({
      pool: runtimePool,
      identity,
      roomId,
      query: 'acquisition',
      limit: 10,
    });
    expect(hiddenSearch).toEqual([]);

    const planClient = await migrationPool.connect();
    const searchPlan = await (async (): Promise<string> => {
      try {
        await planClient.query('BEGIN');
        await planClient.query('SET LOCAL enable_seqscan=off');
        const functionSource = (
          await planClient.query<{ source: string }>(
            `SELECT p.prosrc source FROM pg_proc p
           WHERE p.oid='read_viewer_published_search(text,text,text,text,integer)'::regprocedure`,
          )
        ).rows[0]?.source;
        if (functionSource === undefined) throw new Error('VIEWER_SEARCH_SOURCE_ABSENT');
        const explainable = functionSource
          .slice(functionSource.indexOf('WITH RECURSIVE'), functionSource.lastIndexOf(';'))
          .replace(/\bp_viewer_id\b/gu, '$1')
          .replace(/\bp_session_id\b/gu, '$2')
          .replace(/\bp_room_id\b/gu, '$3')
          .replace(/\bp_query\b/gu, '$4')
          .replace(/\bp_limit\b/gu, '$5');
        return (
          await planClient.query<{ 'QUERY PLAN': string }>(
            `EXPLAIN (COSTS OFF) ${explainable}`,
            [identity.id, identity.sessionId, roomId, 'Investor', 10],
          )
        ).rows
          .map((row) => row['QUERY PLAN'])
          .join('\n');
      } finally {
        await planClient.query('ROLLBACK');
        planClient.release();
      }
    })();
    expect(searchPlan).toMatch(/published_metadata_search/u);
    expect(searchPlan).not.toMatch(/Seq Scan on published_structure_entry\b/u);

    // This probe supplies real same-room folder and document targets, so the
    // integrity trigger accepts it and the named cardinality CHECK is the only
    // failing mechanism. A missing document-id probe would be intercepted first
    // by the room-integrity trigger and would therefore be vacuous here.
    await expect(
      migrationPool.query(
        `INSERT INTO access_grant(id,room_id,grantee_kind,viewer_id,target_kind,folder_id,document_id,created_by)
         VALUES($1,$2,'viewer',$3,'folder',$4,$5,$6)`,
        [createOpaqueId(), roomId, folderViewer, folderId, documentId, managerId],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'access_grant_target_cardinality',
    });
  });

  it('fails closed at exact expiry in a later statement of the same transaction and preserves future UTC access in a non-UTC zone', async () => {
    const expiringViewer = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,$2,$2,'active',$3)",
      [expiringViewer, 'expiring@example.com', createOpaqueId()],
    );
    await addViewer(expiringViewer);
    const expiresAt = new Date(Date.now() + 700);
    await grant({
      id: createOpaqueId(),
      granteeKind: 'viewer',
      viewerId: expiringViewer,
      targetKind: 'document',
      documentId,
      expiresAt,
    });
    const identity = viewerIdentity(expiringViewer);
    const client = await runtimePool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL TimeZone='Pacific/Kiritimati'");
      const before = (
        await client.query<{ allowed: boolean }>(
          'SELECT viewer_can_preview_document($1,$2,$3,$4) allowed',
          [identity.id, identity.sessionId, roomId, documentId],
        )
      ).rows[0]?.allowed;
      expect(before).toBe(true);
      expect(
        (
          await client.query(
            'SELECT 1 FROM read_presented_viewer_document_metadata($1,$2,$3)',
            [identity.sessionProof, roomId, documentId],
          )
        ).rowCount,
      ).toBe(1);
      await client.query('SELECT pg_sleep(0.8)');
      // A later statement in the SAME transaction must not inherit BEGIN time.
      const after = (
        await client.query<{ allowed: boolean }>(
          'SELECT viewer_can_preview_document($1,$2,$3,$4) allowed',
          [identity.id, identity.sessionId, roomId, documentId],
        )
      ).rows[0]?.allowed;
      expect(after).toBe(false);
      expect(
        (
          await client.query(
            'SELECT 1 FROM read_presented_viewer_document_metadata($1,$2,$3)',
            [identity.sessionProof, roomId, documentId],
          )
        ).rowCount,
      ).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const futureViewer = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,$2,$2,'active',$3)",
      [futureViewer, 'future-zone@example.com', createOpaqueId()],
    );
    await addViewer(futureViewer);
    await grant({
      id: createOpaqueId(),
      granteeKind: 'viewer',
      viewerId: futureViewer,
      targetKind: 'document',
      documentId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const zoneClient = await runtimePool.connect();
    try {
      await zoneClient.query("SET TimeZone='America/Anchorage'");
      const accepted = (
        await zoneClient.query<{ allowed: boolean }>(
          'SELECT viewer_can_preview_document($1,$2,$3,$4) allowed',
          [
            viewerIdentity(futureViewer).id,
            viewerIdentity(futureViewer).sessionId,
            roomId,
            documentId,
          ],
        )
      ).rows[0]?.allowed;
      expect(accepted).toBe(true);
      expect(
        (
          await zoneClient.query(
            'SELECT 1 FROM read_presented_viewer_document_metadata($1,$2,$3)',
            [viewerIdentity(futureViewer).sessionProof, roomId, documentId],
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      zoneClient.release();
    }
  });

  it('requires fresh OIDC for a broad grant and accepts the same populated target when fresh', async () => {
    const broadViewer = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,$2,$2,'active',$3)",
      [broadViewer, 'broad-grant@example.com', createOpaqueId()],
    );
    await addViewer(broadViewer);
    const grantId = createOpaqueId();
    const args = [
      managerId,
      roomId,
      'grant',
      grantId,
      'viewer',
      broadViewer,
      null,
      'room',
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
    if (!impact) throw new Error('BROAD_GRANT_IMPACT_ABSENT');
    const staleAudit = audit();
    await expect(
      runtimePool.query(
        'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
        [
          ...args,
          await roomRevision(),
          new Date(Date.now() - 16 * 60_000),
          impact.confirmation,
          ...staleAudit,
        ],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    /*
     * The refusal message is what lets the HTTP layer tell a stale-OIDC 403 apart
     * from an ordinary one. The client must NOT infer the cause from which
     * operation it called: doing so told members to sign in again when the real
     * cause was a revoked role. Pin the message so the mapping cannot silently
     * stop matching and quietly turn every broad refusal back into a generic one.
     */
    await expect(
      runtimePool.query(
        'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
        [
          ...args,
          await roomRevision(),
          new Date(Date.now() - 16 * 60_000),
          impact.confirmation,
          ...audit(),
        ],
      ),
    ).rejects.toThrow(/fresh OIDC required/u);
    expect(
      (await migrationPool.query('SELECT 1 FROM access_grant WHERE id=$1', [grantId])).rowCount,
    ).toBe(0);
    expect(
      (await migrationPool.query('SELECT 1 FROM audit_event WHERE id=$1', [staleAudit[0]]))
        .rowCount,
    ).toBe(0);
    await runtimePool.query(
      'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [...args, await roomRevision(), new Date(), impact.confirmation, ...audit()],
    );
    expect(
      (
        await migrationPool.query("SELECT 1 FROM access_grant WHERE id=$1 AND state='active'", [
          grantId,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it('allows a Manager to create an audited viewer invitation and denies a Contributor on the same target', async () => {
    const invitationId = createOpaqueId();
    const invitedViewerId = createOpaqueId();
    const membershipId = createOpaqueId();
    const invitationAudit = audit();
    const args = [
      invitationId,
      invitedViewerId,
      membershipId,
      'new.viewer@example.com',
      'New.Viewer@example.com',
      roomId,
      contributorId,
      await roomRevision(),
      createOpaqueId(),
      ...invitationAudit,
    ];
    await expect(
      runtimePool.query(
        'SELECT * FROM create_viewer_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        args,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (await migrationPool.query('SELECT 1 FROM invitation WHERE id=$1', [invitationId]))
        .rowCount,
    ).toBe(0);
    expect(
      (await migrationPool.query('SELECT 1 FROM audit_event WHERE id=$1', [invitationAudit[0]]))
        .rowCount,
    ).toBe(0);
    const result = await runtimePool.query<{ room_revision: number }>(
      'SELECT * FROM create_viewer_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        invitationId,
        invitedViewerId,
        membershipId,
        args[3],
        args[4],
        roomId,
        managerId,
        await roomRevision(),
        createOpaqueId(),
        ...invitationAudit,
      ],
    );
    expect(result.rows[0]?.room_revision).toBeGreaterThan(1);
    expect(
      (
        await migrationPool.query(
          "SELECT 1 FROM invitation WHERE id=$1 AND kind='viewer' AND state='pending'",
          [invitationId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await migrationPool.query(
          "SELECT 1 FROM viewer_room_membership WHERE viewer_id=$1 AND room_id=$2 AND state='active'",
          [invitedViewerId, roomId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await migrationPool.query(
          "SELECT 1 FROM audit_event WHERE id=$1 AND reason_code='VIEWER_INVITED'",
          [invitationAudit[0]],
        )
      ).rowCount,
    ).toBe(1);
    const leaseOwner = 'mail-proof-worker';
    const leaseToken = 'M'.repeat(32);
    const queued = (
      await migrationPool.query<{ id: string; payload: Readonly<Record<string, unknown>> }>(
        `UPDATE job_queue SET state='running',attempts=attempts+1,lease_owner=$2,lease_token=$3,
          lease_expires_at=statement_timestamp()+interval '2 minutes'
         WHERE job_type='mail.viewer_invitation' AND payload->>'invitationId'=$1
         RETURNING id,payload`,
        [invitationId, leaseOwner, leaseToken],
      )
    ).rows[0];
    expect(queued).toBeDefined();
    const delivered: OutboundMail[] = [];
    const mailer: RequiredMailer = {
      deliver: () => Promise.reject(new Error('OTP_NOT_EXPECTED')),
      deliverInvitation(message) {
        delivered.push({
          to: message.emailDisplay,
          from: 'mail@example.test',
          subject: 'Viewer invitation',
          text: `${message.roomAlias}\n${message.authenticatedLink}`,
        });
        return Promise.resolve();
      },
      deliverOnboarding: () => Promise.reject(new Error('ONBOARDING_NOT_EXPECTED')),
      deliverSecurityNotice: () => Promise.reject(new Error('NOTICE_NOT_EXPECTED')),
      close: () => undefined,
    };
    await createRequiredMailHandler({
      pool: workerPool,
      mailer,
      publicUrl: 'https://duefold.example/',
    })(
      {
        id: queued?.id ?? '',
        job_type: 'mail.viewer_invitation',
        payload: queued?.payload ?? {},
        attempts: 1,
        max_attempts: 5,
        lease_token: leaseToken,
      },
      {
        leaseOwner,
        signal: new AbortController().signal,
        assertLease: () => Promise.resolve(),
      },
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ to: 'New.Viewer@example.com' });
    expect(delivered[0]?.text).toContain('ROOM-');
    expect(delivered[0]?.text).toContain('https://duefold.example/read');
    expect(
      (
        await migrationPool.query<{ allowed: boolean }>(
          "SELECT has_table_privilege('duefold_runtime','invitation','INSERT') allowed",
        )
      ).rows[0]?.allowed,
    ).toBe(false);
  });

  it('requires explicit publication in addition to an effective grant', async () => {
    const identity = viewerIdentity(viewerId);
    expect(
      await canViewerPreviewDocument({ pool: runtimePool, identity, roomId, documentId }),
    ).toBe(true);
    await migrationPool.query("UPDATE room SET state='draft' WHERE id=$1", [roomId]);
    try {
      expect(
        await canViewerPreviewDocument({ pool: runtimePool, identity, roomId, documentId }),
      ).toBe(false);
      expect(await authorizeViewerPublishedRoom({ pool: runtimePool, identity, roomId })).toBe(
        false,
      );
    } finally {
      await migrationPool.query("UPDATE room SET state='published' WHERE id=$1", [roomId]);
    }
    expect(
      await canViewerPreviewDocument({ pool: runtimePool, identity, roomId, documentId }),
    ).toBe(true);
  });

  it('shows the exact inherited room default before confirmation and audits the committed grant atomically', async () => {
    const inherited = new Date(Date.now() + 86_400_000);
    const revision = await roomRevision();
    const preview = (
      await runtimePool.query<{
        dry_run_room_default_expiry: { confirmation: string; resolvedExpiresAt: string };
      }>('SELECT dry_run_room_default_expiry($1,$2,$3)', [managerId, roomId, inherited])
    ).rows[0]?.dry_run_room_default_expiry;
    if (!preview) throw new Error('DEFAULT_EXPIRY_PREVIEW_ABSENT');
    expect(new Date(preview.resolvedExpiresAt).toISOString()).toBe(inherited.toISOString());
    await runtimePool.query('SELECT apply_room_default_expiry($1,$2,$3,$4,$5,$6,$7)', [
      managerId,
      roomId,
      inherited,
      revision,
      preview.confirmation,
      ...audit(),
    ]);
    const inheritedViewer = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,$2,$2,'active',$3)",
      [inheritedViewer, 'inherited@example.com', createOpaqueId()],
    );
    await addViewer(inheritedViewer);
    const newGrant = createOpaqueId();
    const impact = await grant({
      id: newGrant,
      granteeKind: 'viewer',
      viewerId: inheritedViewer,
      targetKind: 'document',
      documentId,
    });
    expect(new Date(impact.resolvedExpiresAt ?? '').toISOString()).toBe(
      inherited.toISOString(),
    );
    expect(
      (
        await migrationPool.query(
          "SELECT 1 FROM audit_event WHERE resource_id=$1 AND reason_code='GRANT_APPLIED'",
          [newGrant],
        )
      ).rowCount,
    ).toBe(1);
  });

  it('applies expiry and revoke with typed confirmation, optimistic concurrency, and atomic audit', async () => {
    const viewer = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,$2,$2,'active',$3)",
      [viewer, 'change-grant@example.com', createOpaqueId()],
    );
    await addViewer(viewer);
    const id = createOpaqueId();
    await grant({
      id,
      granteeKind: 'viewer',
      viewerId: viewer,
      targetKind: 'document',
      documentId,
    });
    const identity = viewerIdentity(viewer);
    expect(
      await canViewerPreviewDocument({ pool: runtimePool, identity, roomId, documentId }),
    ).toBe(true);

    const expiry = new Date(Date.now() + 86_400_000);
    const expiryArgs = [
      managerId,
      roomId,
      'expiry',
      id,
      null,
      null,
      null,
      null,
      null,
      null,
      expiry,
    ];
    const expiryImpact = (
      await runtimePool.query<{ dry_run_grant_change: { confirmation: string } }>(
        'SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        expiryArgs,
      )
    ).rows[0]?.dry_run_grant_change;
    if (!expiryImpact) throw new Error('EXPIRY_IMPACT_ABSENT');
    const expiryAudit = audit();
    await expect(
      runtimePool.query(
        'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
        [
          ...expiryArgs,
          (await roomRevision()) - 1,
          freshOidcAt,
          expiryImpact.confirmation,
          ...expiryAudit,
        ],
      ),
    ).rejects.toMatchObject({ code: '40001' });
    expect(
      (await migrationPool.query('SELECT 1 FROM audit_event WHERE id=$1', [expiryAudit[0]]))
        .rowCount,
    ).toBe(0);
    await expect(
      runtimePool.query(
        'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
        [
          ...expiryArgs,
          await roomRevision(),
          freshOidcAt,
          'CHANGE ACCESS SILENTLY',
          ...audit(),
        ],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await runtimePool.query(
      'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [...expiryArgs, await roomRevision(), freshOidcAt, expiryImpact.confirmation, ...audit()],
    );
    expect(
      (
        await migrationPool.query<{ expires_at: Date }>(
          'SELECT expires_at FROM access_grant WHERE id=$1',
          [id],
        )
      ).rows[0]?.expires_at.toISOString(),
    ).toBe(expiry.toISOString());

    const revokeArgs = [
      managerId,
      roomId,
      'revoke',
      id,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ];
    const revokeImpact = (
      await runtimePool.query<{ dry_run_grant_change: { confirmation: string } }>(
        'SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        revokeArgs,
      )
    ).rows[0]?.dry_run_grant_change;
    if (!revokeImpact) throw new Error('REVOKE_IMPACT_ABSENT');
    await runtimePool.query(
      'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [...revokeArgs, await roomRevision(), freshOidcAt, revokeImpact.confirmation, ...audit()],
    );
    expect(
      await canViewerPreviewDocument({ pool: runtimePool, identity, roomId, documentId }),
    ).toBe(false);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM audit_event WHERE resource_id=$1 AND reason_code IN ('EXPIRY_APPLIED','REVOKE_APPLIED')",
          [id],
        )
      ).rows[0]?.n,
    ).toBe(2);
  });

  it('denies Contributor grant changes on the same populated target a Manager can preview', async () => {
    const id = createOpaqueId();
    const args = [
      contributorId,
      roomId,
      'grant',
      id,
      'viewer',
      deniedViewerId,
      null,
      'document',
      null,
      documentId,
      null,
    ];
    await expect(
      runtimePool.query(
        'SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        args,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const allowed = (
      await runtimePool.query<{
        dry_run_grant_change: { affectedCount: number; paths: string[] };
      }>('SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
        managerId,
        ...args.slice(1),
      ])
    ).rows[0]?.dry_run_grant_change;
    expect(allowed).toMatchObject({
      affectedCount: 1,
      paths: ['Data room / Finantsid 財務 / Investor model'],
    });
  });

  it('resolves one uniform installation-room-document download policy independent of viewer', async () => {
    const policy = (viewer: string) =>
      resolveDocumentDownloadPolicy({
        pool: runtimePool,
        viewerId: viewer,
        sessionId: viewerIdentity(viewer).sessionId,
        roomId,
        documentId,
      });
    expect(await policy(viewerId)).toBe('deny');
    expect(await policy(directViewerId)).toBe('deny');
    // The same populated document remains undiscoverable through policy lookup to
    // a viewer with no grant.
    await expect(policy(deniedViewerId)).rejects.toThrow('DOWNLOAD_POLICY_UNAVAILABLE');
    // Contributor is denied on the same populated room/document; Manager then
    // performs the exact mutation successfully and emits its audit row.
    await expect(
      runtimePool.query('SELECT set_room_download_policy($1,$2,$3,$4,$5,$6)', [
        contributorId,
        roomId,
        'allow',
        await roomRevision(),
        ...audit(),
      ]),
    ).rejects.toMatchObject({ code: '40001' });
    const roomPolicyAudit = audit();
    await runtimePool.query('SELECT set_room_download_policy($1,$2,$3,$4,$5,$6)', [
      managerId,
      roomId,
      'allow',
      await roomRevision(),
      ...roomPolicyAudit,
    ]);
    expect(await policy(viewerId)).toBe('allow');
    expect(await policy(directViewerId)).toBe('allow');
    const documentRevision = (
      await migrationPool.query<{ revision: number }>(
        'SELECT revision FROM document WHERE id=$1',
        [documentId],
      )
    ).rows[0]?.revision;
    await runtimePool.query('SELECT set_document_download_policy($1,$2,$3,$4,$5,$6)', [
      managerId,
      documentId,
      'deny',
      documentRevision,
      ...audit(),
    ]);
    expect(await policy(viewerId)).toBe('deny');
    expect(await policy(directViewerId)).toBe('deny');
    expect(
      (await migrationPool.query('SELECT 1 FROM audit_event WHERE id=$1', [roomPolicyAudit[0]]))
        .rowCount,
    ).toBe(1);
    const args = (
      await migrationPool.query<{ args: string }>(
        "SELECT pg_get_function_arguments('resolve_document_download_policy(text)'::regprocedure) args",
      )
    ).rows[0]?.args;
    expect(args).toBe('p_document_id text');
    expect(
      (
        await migrationPool.query<{ allowed: boolean }>(
          "SELECT has_function_privilege('duefold_runtime','resolve_document_download_policy(text)','EXECUTE') allowed",
        )
      ).rows[0]?.allowed,
    ).toBe(false);
  });

  it('protects page/text/cache/lease boundaries with populated granted and denied arms', async () => {
    const granted = viewerIdentity(viewerId);
    const denied = viewerIdentity(deniedViewerId);
    const text = await readProtectedTextLayer({
      pool: runtimePool,
      identity: granted,
      roomId,
      documentId,
      pageNumber: 1,
    });
    expect(text).toMatchObject({ versionId, accessibleLabel: 'Page 1', items: [] });
    await expect(
      readProtectedTextLayer({
        pool: runtimePool,
        identity: denied,
        roomId,
        documentId,
        pageNumber: 1,
      }),
    ).rejects.toThrow('PROTECTED_PAGE_UNAVAILABLE');

    const allowedCache = createOpaqueId();
    const allowedKey = `watermarks/${createOpaqueId()}/${createOpaqueId()}`;
    expect(
      (
        await runtimePool.query('SELECT * FROM begin_watermark_cache($1,$2,$3,$4,$5,$6)', [
          allowedCache,
          granted.sessionProof,
          roomId,
          documentId,
          1,
          allowedKey,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await runtimePool.query('SELECT * FROM begin_watermark_cache($1,$2,$3,$4,$5,$6)', [
          createOpaqueId(),
          denied.sessionProof,
          roomId,
          documentId,
          1,
          `watermarks/${createOpaqueId()}/${createOpaqueId()}`,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          'SELECT count(*)::int n FROM watermark_cache WHERE viewer_id=$1',
          [denied.id],
        )
      ).rows[0]?.n,
    ).toBe(0);

    const deniedByPolicyLease = createOpaqueId();
    expect(
      (
        await runtimePool.query('SELECT * FROM create_download_lease($1,$2,$3,$4,$5)', [
          deniedByPolicyLease,
          granted.sessionProof,
          roomId,
          documentId,
          createCorrelationId(),
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          'SELECT count(*)::int n FROM download_lease WHERE id=$1',
          [deniedByPolicyLease],
        )
      ).rows[0]?.n,
    ).toBe(0);

    await migrationPool.query("UPDATE document SET download_policy='allow' WHERE id=$1", [
      documentId,
    ]);
    const allowedLease = await createDownloadLease({
      pool: runtimePool,
      identity: granted,
      roomId,
      documentId,
    });
    expect(allowedLease.versionId).toBe(versionId);
    expect(allowedLease.filename).toBe('Investor model.pdf');
    expect(allowedLease.filename).not.toBe('model.pdf');
    await expect(
      createDownloadLease({ pool: runtimePool, identity: denied, roomId, documentId }),
    ).rejects.toThrow('DOWNLOAD_UNAVAILABLE');
    expect(
      (
        await migrationPool.query<{ n: number }>(
          'SELECT count(*)::int n FROM download_lease WHERE viewer_id=$1',
          [denied.id],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });

  it('requires publication and ready evidence in addition to an effective grant', async () => {
    const identity = viewerIdentity(viewerId);
    expect(
      await canViewerPreviewDocument({ pool: runtimePool, identity, roomId, documentId }),
    ).toBe(true);
    const published = (
      await migrationPool.query<{
        room_id: string;
        entry_id: string;
        resource_kind: string;
        resource_id: string;
        parent_folder_id: string | null;
        display_name: string;
        description: string;
        order_key: string;
        source_revision: number;
        published_version_id: string | null;
      }>(
        "SELECT room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,order_key::text,source_revision,published_version_id FROM published_structure_entry WHERE room_id=$1 AND resource_kind='document' AND resource_id=$2",
        [roomId, documentId],
      )
    ).rows[0];
    if (!published) throw new Error('PUBLISHED_FIXTURE_ABSENT');
    await migrationPool.query(
      "DELETE FROM published_structure_entry WHERE room_id=$1 AND resource_kind='document' AND resource_id=$2",
      [roomId, documentId],
    );
    try {
      await expect(
        readProtectedTextLayer({
          pool: runtimePool,
          identity,
          roomId,
          documentId,
          pageNumber: 1,
        }),
      ).rejects.toThrow('PROTECTED_PAGE_UNAVAILABLE');
      await expect(
        createDownloadLease({ pool: runtimePool, identity, roomId, documentId }),
      ).rejects.toThrow('DOWNLOAD_UNAVAILABLE');
    } finally {
      await migrationPool.query(
        `INSERT INTO published_structure_entry(room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,order_key,source_revision,published_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          published.room_id,
          published.entry_id,
          published.resource_kind,
          published.resource_id,
          published.parent_folder_id,
          published.display_name,
          published.description,
          published.order_key,
          published.source_revision,
          published.published_version_id,
        ],
      );
    }
  });

  it('records one preview start and one summary while keeping delivery telemetry separately purgeable', async () => {
    const identity = viewerIdentity(viewerId);
    const activityId = createOpaqueId(),
      correlation = createCorrelationId();
    const beginArgs = [
      activityId,
      identity.sessionProof,
      roomId,
      documentId,
      versionId,
      correlation,
      '2026-03',
      'a'.repeat(64),
      'chromium',
      'linux',
      'desktop',
      createOpaqueId(),
    ];
    expect(
      (
        await runtimePool.query<{ id: string }>(
          'SELECT begin_preview_activity($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) id',
          beginArgs,
        )
      ).rows[0]?.id,
    ).toBe(activityId);
    expect(
      (
        await runtimePool.query<{ id: string }>(
          'SELECT begin_preview_activity($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) id',
          [createOpaqueId(), ...beginArgs.slice(1, 11), createOpaqueId()],
        )
      ).rows[0]?.id,
    ).toBe(activityId);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='preview.start' AND actor_id=$1 AND subject_id=$2 AND resource_id=$3",
          [identity.id, identity.sessionId, versionId],
        )
      ).rows[0]?.n,
    ).toBe(1);
    const evidenceCacheId = createOpaqueId();
    await runtimePool.query('SELECT * FROM begin_watermark_cache($1,$2,$3,$4,$5,$6)', [
      evidenceCacheId,
      identity.sessionProof,
      roomId,
      documentId,
      1,
      `watermarks/${createOpaqueId()}/${createOpaqueId()}`,
    ]);
    expect(
      (
        await runtimePool.query<{ ok: boolean }>('SELECT finish_watermark_cache($1,$2) ok', [
          evidenceCacheId,
          identity.sessionProof,
        ])
      ).rows[0]?.ok,
    ).toBe(true);
    expect(
      (
        await runtimePool.query('SELECT * FROM authorize_watermark_delivery($1,$2,$3)', [
          evidenceCacheId,
          identity.sessionProof,
          activityId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await runtimePool.query<{ ok: boolean }>('SELECT heartbeat_preview($1,$2) ok', [
          activityId,
          identity.sessionProof,
        ])
      ).rows[0]?.ok,
    ).toBe(false);
    await migrationPool.query(
      "UPDATE preview_activity SET heartbeat_at=statement_timestamp()-interval '60 seconds' WHERE id=$1",
      [activityId],
    );
    expect(
      (
        await runtimePool.query<{ ok: boolean }>('SELECT heartbeat_preview($1,$2) ok', [
          activityId,
          identity.sessionProof,
        ])
      ).rows[0]?.ok,
    ).toBe(true);
    expect(
      (
        await runtimePool.query<{ ok: boolean }>('SELECT summarize_preview($1,$2,$3,$4) ok', [
          activityId,
          identity.sessionProof,
          'closed',
          createOpaqueId(),
        ])
      ).rows[0]?.ok,
    ).toBe(true);
    expect(
      (
        await runtimePool.query<{ ok: boolean }>('SELECT summarize_preview($1,$2,$3,$4) ok', [
          activityId,
          identity.sessionProof,
          'closed',
          createOpaqueId(),
        ])
      ).rows[0]?.ok,
    ).toBe(false);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='preview.summary' AND correlation_id=$1",
          [correlation],
        )
      ).rows[0]?.n,
    ).toBe(1);
    const summary = (
      await migrationPool.query<{ detail: Record<string, unknown> }>(
        "SELECT detail FROM audit_event WHERE event_type='preview.summary' AND correlation_id=$1",
        [correlation],
      )
    ).rows[0]?.detail;
    expect(summary).toEqual({ pageRanges: '{[1,2)}', status: 'closed' });
    for (const forbidden of ['dwell', 'completion', 'score', 'ranking', 'proof'])
      expect(JSON.stringify(summary).toLowerCase()).not.toContain(forbidden);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          'SELECT count(*)::int n FROM preview_delivery_telemetry WHERE activity_id=$1',
          [activityId],
        )
      ).rows[0]?.n,
    ).toBe(1);
    const storedNetwork = (
      await migrationPool.query<{ network_period: string; network_hmac: string }>(
        'SELECT network_period,network_hmac FROM preview_activity WHERE id=$1',
        [activityId],
      )
    ).rows[0];
    expect(storedNetwork).toEqual({ network_period: '2026-03', network_hmac: 'a'.repeat(64) });
    expect(Object.keys(storedNetwork ?? {})).toEqual(['network_period', 'network_hmac']);
    const privacyColumns = (
      await migrationPool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name='preview_activity' ORDER BY ordinal_position",
      )
    ).rows.map((row) => row.column_name);
    for (const prohibited of ['ip', 'user_agent', 'geolocation', 'network_key', 'hmac_key'])
      expect(privacyColumns).not.toContain(prohibited);
    await migrationPool.query(
      "UPDATE preview_delivery_telemetry SET expires_at=statement_timestamp()-interval '1 second' WHERE activity_id=$1",
      [activityId],
    );
    expect(
      (
        await migrationPool.query<{ n: number }>(
          'SELECT count(*)::int n FROM audit_event WHERE correlation_id=$1',
          [correlation],
        )
      ).rows[0]?.n,
    ).toBe(2);
    expect(
      (
        await workerPool.query<{ n: string }>(
          'SELECT purge_expired_preview_telemetry()::text n',
        )
      ).rows[0]?.n,
    ).toBe('1');
    expect(
      (
        await migrationPool.query<{ n: number }>(
          'SELECT count(*)::int n FROM audit_event WHERE correlation_id=$1',
          [correlation],
        )
      ).rows[0]?.n,
    ).toBe(2);
  });

  it('reactivates a summarized activity on reopen without writing a second immutable start', async () => {
    /*
     * Page delivery requires state='active', so handing back the closed row made
     * every reopened document render a broken page. Reactivation must keep the one
     * mutable row (UNIQUE viewer/session/version) and must NOT write a second
     * immutable preview.start, which is limited to one per triple.
     * A distinct correlation id keeps this arm from perturbing the summary counts
     * asserted by the neighbouring evidence test.
     */
    const identity = viewerIdentity(viewerId);
    const activityId = createOpaqueId();
    const beginArgs = [
      activityId,
      identity.sessionProof,
      roomId,
      documentId,
      versionId,
      createCorrelationId(),
      '2026-04',
      'b'.repeat(64),
      'chromium',
      'linux',
      'desktop',
      createOpaqueId(),
    ];
    const opened = (
      await runtimePool.query<{ id: string }>(
        'SELECT begin_preview_activity($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) id',
        beginArgs,
      )
    ).rows[0]?.id;
    expect(opened).not.toBeNull();
    const starts = async (): Promise<number | undefined> =>
      (
        await migrationPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='preview.start' AND actor_id=$1 AND subject_id=$2 AND resource_id=$3",
          [identity.id, identity.sessionId, versionId],
        )
      ).rows[0]?.n;
    const startsAfterOpen = await starts();
    await runtimePool.query('SELECT summarize_preview($1,$2,$3,$4)', [
      opened,
      identity.sessionProof,
      'closed',
      createOpaqueId(),
    ]);
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM preview_activity WHERE id=$1',
          [opened],
        )
      ).rows[0]?.state,
    ).toBe('closed');
    expect(
      (
        await runtimePool.query<{ id: string }>(
          'SELECT begin_preview_activity($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) id',
          [createOpaqueId(), ...beginArgs.slice(1, 11), createOpaqueId()],
        )
      ).rows[0]?.id,
    ).toBe(opened);
    expect(
      (
        await migrationPool.query<{ state: string; summarized_at: string | null }>(
          'SELECT state,summarized_at FROM preview_activity WHERE id=$1',
          [opened],
        )
      ).rows[0],
    ).toMatchObject({ state: 'active', summarized_at: null });
    expect(await starts()).toBe(startsAfterOpen);
  });

  it('supports range resume under one correlation and emits one summary, not one event per range', async () => {
    await migrationPool.query("UPDATE document SET download_policy='allow' WHERE id=$1", [
      documentId,
    ]);
    expect(
      (
        await migrationPool.query<{ policy: string }>(
          'SELECT resolve_document_download_policy($1) policy',
          [documentId],
        )
      ).rows[0]?.policy,
    ).toBe('allow');
    const identity = viewerIdentity(viewerId),
      leaseId = createOpaqueId(),
      correlation = createCorrelationId();
    expect(
      (
        await runtimePool.query('SELECT * FROM create_download_lease($1,$2,$3,$4,$5)', [
          leaseId,
          identity.sessionProof,
          roomId,
          documentId,
          correlation,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await runtimePool.query('SELECT * FROM authorize_download_range($1,$2,$3)', [
          leaseId,
          identity.sessionProof,
          createOpaqueId(),
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await runtimePool.query<{ ok: boolean }>(
          'SELECT record_download_range($1,$2,$3,$4,$5,$6) ok',
          [leaseId, identity.sessionProof, 0, 5, 5, createOpaqueId()],
        )
      ).rows[0]?.ok,
    ).toBe(true);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='download.summary' AND correlation_id=$1",
          [correlation],
        )
      ).rows[0]?.n,
    ).toBe(0);
    expect(
      (
        await runtimePool.query<{ ok: boolean }>(
          'SELECT record_download_range($1,$2,$3,$4,$5,$6) ok',
          [leaseId, identity.sessionProof, 5, 10, 5, createOpaqueId()],
        )
      ).rows[0]?.ok,
    ).toBe(true);
    const events = await migrationPool.query<{
      detail: { bytesServed: number; versionId: string };
    }>(
      "SELECT detail FROM audit_event WHERE event_type='download.summary' AND correlation_id=$1",
      [correlation],
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0]?.detail).toMatchObject({ bytesServed: 10, versionId });
    expect(
      (
        await runtimePool.query('SELECT * FROM authorize_download_range($1,$2,$3)', [
          leaseId,
          identity.sessionProof,
          createOpaqueId(),
        ])
      ).rowCount,
    ).toBe(0);

    const expired = createOpaqueId(),
      expiredCorrelation = createCorrelationId();
    await runtimePool.query('SELECT * FROM create_download_lease($1,$2,$3,$4,$5)', [
      expired,
      identity.sessionProof,
      roomId,
      documentId,
      expiredCorrelation,
    ]);
    await migrationPool.query(
      "UPDATE download_lease SET created_at=statement_timestamp()-interval '16 minutes',expires_at=statement_timestamp()-interval '1 minute' WHERE id=$1",
      [expired],
    );
    expect(
      (
        await runtimePool.query('SELECT * FROM authorize_download_range($1,$2,$3)', [
          expired,
          identity.sessionProof,
          createOpaqueId(),
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='download.summary' AND correlation_id=$1 AND reason_code='DOWNLOAD_LEASE_EXPIRED'",
          [expiredCorrelation],
        )
      ).rows[0]?.n,
    ).toBe(1);

    const revokedViewer = createOpaqueId();
    await migrationPool.query(
      "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,$2,$2,'active',$3)",
      [revokedViewer, `${revokedViewer.toLowerCase()}@example.com`, createOpaqueId()],
    );
    await addViewer(revokedViewer);
    const revokedGrant = createOpaqueId();
    await grant({
      id: revokedGrant,
      granteeKind: 'viewer',
      viewerId: revokedViewer,
      targetKind: 'document',
      documentId,
    });
    const revokedIdentity = viewerIdentity(revokedViewer);
    const revokedLease = createOpaqueId();
    const revokedCorrelation = createCorrelationId();
    expect(
      (
        await runtimePool.query('SELECT * FROM create_download_lease($1,$2,$3,$4,$5)', [
          revokedLease,
          revokedIdentity.sessionProof,
          roomId,
          documentId,
          revokedCorrelation,
        ])
      ).rowCount,
    ).toBe(1);
    const revokeArgs = [
      managerId,
      roomId,
      'revoke',
      revokedGrant,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ];
    const revokeImpact = (
      await runtimePool.query<{ dry_run_grant_change: { confirmation: string } }>(
        'SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        revokeArgs,
      )
    ).rows[0]?.dry_run_grant_change;
    if (revokeImpact === undefined) throw new Error('REVOKE_IMPACT_ABSENT');
    await runtimePool.query(
      'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [...revokeArgs, await roomRevision(), freshOidcAt, revokeImpact.confirmation, ...audit()],
    );
    expect(
      (
        await runtimePool.query('SELECT * FROM authorize_download_range($1,$2,$3)', [
          revokedLease,
          revokedIdentity.sessionProof,
          createOpaqueId(),
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='download.summary' AND correlation_id=$1 AND reason_code='DOWNLOAD_AUTHORIZATION_REVOKED'",
          [revokedCorrelation],
        )
      ).rows[0]?.n,
    ).toBe(1);
  });

  it('binds a warm watermark cache to viewer/session and revokes next delivery immediately', async () => {
    const identity = viewerIdentity(directViewerId);
    const cacheId = createOpaqueId();
    await runtimePool.query('SELECT * FROM begin_watermark_cache($1,$2,$3,$4,$5,$6)', [
      cacheId,
      identity.sessionProof,
      roomId,
      documentId,
      1,
      `watermarks/${createOpaqueId()}/${createOpaqueId()}`,
    ]);
    expect(
      (
        await runtimePool.query<{ ok: boolean }>('SELECT finish_watermark_cache($1,$2) ok', [
          cacheId,
          identity.sessionProof,
        ])
      ).rows[0]?.ok,
    ).toBe(true);
    const activityId = createOpaqueId();
    await runtimePool.query(
      'SELECT begin_preview_activity($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [
        activityId,
        identity.sessionProof,
        roomId,
        documentId,
        versionId,
        createCorrelationId(),
        '2026-03',
        'b'.repeat(64),
        'chromium',
        'linux',
        'desktop',
        createOpaqueId(),
      ],
    );
    expect(
      (
        await runtimePool.query('SELECT * FROM authorize_watermark_delivery($1,$2,$3)', [
          cacheId,
          identity.sessionProof,
          activityId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await runtimePool.query('SELECT * FROM authorize_watermark_delivery($1,$2,$3)', [
          cacheId,
          viewerIdentity(viewerId).sessionProof,
          activityId,
        ])
      ).rowCount,
    ).toBe(0);
    await createViewerSession(directViewerId);
    expect(
      (
        await runtimePool.query('SELECT * FROM authorize_watermark_delivery($1,$2,$3)', [
          cacheId,
          viewerIdentity(directViewerId).sessionProof,
          activityId,
        ])
      ).rowCount,
    ).toBe(0);
    const args = [
      managerId,
      roomId,
      'revoke',
      directGrantId,
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
    expect(
      (
        await runtimePool.query('SELECT * FROM authorize_watermark_delivery($1,$2,$3)', [
          cacheId,
          identity.sessionProof,
          activityId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await migrationPool.query<{ state: string }>(
          'SELECT state FROM watermark_cache WHERE id=$1',
          [cacheId],
        )
      ).rows[0]?.state,
    ).toBe('deletion_pending');
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM job_queue WHERE job_type='document.watermark.delete' AND payload->>'cacheId'=$1",
          [cacheId],
        )
      ).rows[0]?.n,
    ).toBe(1);
  });

  it('denies runtime session forgery while a real authenticated viewer still previews the same published version', async () => {
    const identity = viewerIdentity(viewerId);
    await expect(
      runtimePool.query(
        `INSERT INTO session(id,secret_digest,csrf_digest,principal_kind,viewer_id,family_id,
          idle_expires_at,absolute_expires_at)
         VALUES($1,$2,$3,'viewer',$4,$5,statement_timestamp()+interval '1 hour',
           statement_timestamp()+interval '8 hours')`,
        [createOpaqueId(), 'f'.repeat(64), 'e'.repeat(64), viewerId, createOpaqueId()],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const text = await readProtectedTextLayer({
      pool: runtimePool,
      identity,
      roomId,
      documentId,
      pageNumber: 1,
    });
    expect(text).toMatchObject({ versionId, accessibleLabel: 'Page 1' });
  });

  it('keeps protected delivery tables private and preserves least privilege', async () => {
    for (const table of [
      'counterparty',
      'viewer_room_membership',
      'counterparty_viewer',
      'access_grant',
      'room',
      'folder',
      'working_structure_entry',
      'published_structure_entry',
      'room_trash',
      'watermark_cache',
      'preview_activity',
      'preview_delivery_telemetry',
      'download_lease',
    ])
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        expect(
          (
            await migrationPool.query<{ allowed: boolean }>(
              'SELECT has_table_privilege($1,$2,$3) allowed',
              ['duefold_runtime', table, privilege],
            )
          ).rows[0]?.allowed,
          `${privilege} ${table}`,
        ).toBe(false);
    for (const functionName of [
      'begin_watermark_cache(text,text,text,text,integer,text)',
      'create_download_lease(text,text,text,text,text)',
      'authorize_download_range(text,text,text)',
      'read_presented_viewer_rooms(text)',
      'read_presented_viewer_structure(text,text)',
      'search_presented_viewer_structure(text,text,text,integer)',
      'read_presented_viewer_document_metadata(text,text,text)',
    ])
      expect(
        (
          await migrationPool.query<{ allowed: boolean }>(
            'SELECT has_function_privilege($1,$2,$3) allowed',
            ['duefold_authenticator', functionName, 'EXECUTE'],
          )
        ).rows[0]?.allowed,
        `authenticator EXECUTE ${functionName}`,
      ).toBe(false);
    for (const functionName of [
      'read_viewer_published_structure(text,text,text)',
      'read_viewer_published_search(text,text,text,text,integer)',
    ])
      expect(
        (
          await migrationPool.query<{ allowed: boolean }>(
            'SELECT has_function_privilege($1,$2,$3) allowed',
            ['duefold_runtime', functionName, 'EXECUTE'],
          )
        ).rows[0]?.allowed,
        `runtime caller-ID projection EXECUTE ${functionName}`,
      ).toBe(false);
    expect(
      (
        await migrationPool.query<{ allowed: boolean }>(
          "SELECT has_table_privilege('duefold_runtime','session','INSERT') allowed",
        )
      ).rows[0]?.allowed,
    ).toBe(false);
    /*
     * Identity mutation must not be reachable with the shared web credential.
     * Direct DML on member/viewer let the web role change a viewer's state or
     * escalate a global role with no audit row in the same transaction, which
     * breaks the transactional audit invariant even once session forgery is
     * blocked. The web role authorizes requests, so it keeps SELECT; every
     * mutation belongs to an audited path or the authenticator pool.
     */
    for (const [table, privilege, allowed] of [
      ['member', 'SELECT', true],
      ['member', 'INSERT', false],
      ['member', 'UPDATE', false],
      ['member', 'DELETE', false],
      ['viewer', 'SELECT', true],
      ['viewer', 'INSERT', false],
      ['viewer', 'UPDATE', false],
      ['viewer', 'DELETE', false],
      ['document_derivative', 'SELECT', false],
      ['document_version', 'SELECT', false],
      ['otp_challenge', 'SELECT', false],
      ['oidc_transaction', 'SELECT', false],
    ] as const)
      expect(
        (
          await migrationPool.query<{ allowed: boolean }>(
            'SELECT has_table_privilege($1,$2,$3) allowed',
            ['duefold_runtime', table, privilege],
          )
        ).rows[0]?.allowed,
        `runtime ${privilege} ${table}`,
      ).toBe(allowed);
  });
});
