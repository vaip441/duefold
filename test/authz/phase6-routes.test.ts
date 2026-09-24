import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { createHandler as createExportListHandler } from '../../modules/rooms-documents/src/routes/export-list.ts';
import { createHandler as createProcessingStateHandler } from '../../modules/rooms-documents/src/routes/processing-state.ts';
import { createHandler as createBrandingHandler } from '../../modules/branding-notifications/src/routes/branding-configuration.ts';
import { createHandler as createSupportHandler } from '../../modules/branding-notifications/src/routes/support-contact.ts';
import { createHandler as createPublicBrandingHandler } from '../../modules/branding-notifications/src/routes/public-branding.ts';
import { createHandler as createViewerIntroductionHandler } from '../../modules/branding-notifications/src/routes/viewer-introduction.ts';
import { createHandler as createAssetDeliveryHandler } from '../../modules/branding-notifications/src/routes/branding-asset-delivery.ts';
import { createHandler as createAssetDeleteHandler } from '../../modules/branding-notifications/src/routes/branding-asset-delete.ts';
import { createHandler as createBrandingUploadHandler } from '../../modules/branding-notifications/src/routes/branding-upload.ts';
import { buildTestWebApp } from '../support/web-runtime.ts';
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
  otherRoomId = createOpaqueId(),
  documentId = createOpaqueId(),
  versionId = createOpaqueId();
const runtime = testWebRuntime({ pool: runtimePool, authPool });
const manager = {
  kind: 'member' as const,
  id: managerId,
  globalRole: 'member' as const,
  roomRoles: { [roomId]: 'manager' as const },
  oidcAuthenticatedAt: new Date(),
};
const contributor = {
  ...manager,
  id: contributorId,
  roomRoles: { [roomId]: 'contributor' as const },
};
const administrator = {
  kind: 'member' as const,
  id: ownerId,
  globalRole: 'owner' as const,
  roomRoles: {},
  oidcAuthenticatedAt: new Date(),
};
function audit(): readonly [string, string] {
  return [createOpaqueId(), createCorrelationId()];
}

beforeAll(async () => {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const identityClient = await migrationPool.connect();
  try {
    await identityClient.query('BEGIN');
    for (const [id, email, role] of [
      [ownerId, 'route-owner@example.com', 'owner'],
      [managerId, 'route-manager@example.com', 'member'],
      [contributorId, 'route-contributor@example.com', 'member'],
    ] as const)
      await identityClient.query(
        "INSERT INTO member(id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state) VALUES($1,$2,$2,'https://issuer.example',$1,$3,'active')",
        [id, email, role],
      );
    await identityClient.query(
      "INSERT INTO organization(id,name) VALUES($1,'Route contracts')",
      [createOpaqueId()],
    );
    await identityClient.query('COMMIT');
  } catch (error) {
    await identityClient.query('ROLLBACK');
    throw error;
  } finally {
    identityClient.release();
  }
  for (const [id, title] of [
    [roomId, 'Populated route room'],
    [otherRoomId, 'Other populated room'],
  ] as const)
    await runtimePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
      id,
      title,
      '',
      ownerId,
      ...audit(),
    ]);
  /* Migration 017 revoked direct room_assignment DML from the runtime credential,
   * so this fixture uses the migration credential's schema authority. */
  await migrationPool.query(
    "INSERT INTO room_assignment(id,room_id,member_id,room_role) VALUES($1,$2,$3,'manager'),($4,$2,$5,'contributor')",
    [createOpaqueId(), roomId, managerId, createOpaqueId(), contributorId],
  );
  await migrationPool.query(
    "INSERT INTO document(id,room_id,display_title,description,created_by) VALUES($1,$2,'Processing document','',$3)",
    [documentId, roomId, contributorId],
  );
  await migrationPool.query(
    "INSERT INTO document_version(id,document_id,original_filename,object_key,declared_media_type,size_bytes,state) VALUES($1,$2,'private.pdf',$3,'application/pdf',10,'quarantine')",
    [versionId, documentId, `quarantine/${createOpaqueId()}/${createOpaqueId()}`],
  );
  await migrationPool.query('UPDATE document SET working_version_id=$1 WHERE id=$2', [
    versionId,
    documentId,
  ]);
  await migrationPool.query(
    "INSERT INTO export_request(id,room_id,created_by,preset,object_key,content_type,expires_at) VALUES($1,$2,$3,'participant-access',$4,'application/json',statement_timestamp()+interval '1 hour')",
    [createOpaqueId(), roomId, managerId, `exports/${createOpaqueId()}/${createOpaqueId()}`],
  );
});
afterAll(async () => {
  await runtimePool.end();
  await authPool.end();
  await workerPool.end();
  await migrationPool.end();
  await bootstrapPool.end();
});

describe('Member state and branding routes', () => {
  it('lists a populated processing state for Contributor but refuses an unrelated room', async () => {
    const allowed = await createProcessingStateHandler(
      runtime,
      contributor,
    )({ query: { roomId, limit: '50' } } as never);
    expect(allowed.versions).toContainEqual(
      expect.objectContaining({
        versionId,
        state: 'quarantine',
        displayTitle: 'Processing document',
      }),
    );
    await expect(
      createProcessingStateHandler(
        runtime,
        contributor,
      )({ query: { roomId: otherRoomId, limit: '50' } } as never),
    ).rejects.toMatchObject({ code: '42501' });
    expect(JSON.stringify(allowed)).not.toContain('private.pdf');
    expect(JSON.stringify(allowed)).not.toContain('quarantine/');
  });

  it('lists only the Manager creator export and refuses Contributor in the same populated room', async () => {
    const allowed = await createExportListHandler(
      runtime,
      manager,
    )({ query: { roomId, limit: '50' } } as never);
    expect(allowed.exports).toHaveLength(1);
    expect(allowed.exports[0]).toMatchObject({
      preset: 'participant-access',
      state: 'generating',
    });
    await expect(
      createExportListHandler(
        runtime,
        contributor,
      )({ query: { roomId, limit: '50' } } as never),
    ).rejects.toMatchObject({ code: '42501' });
    expect(JSON.stringify(allowed)).not.toContain('exports/');
  });

  it('binds branding multipart checksums and exposes processing state only to the creating administrator', async () => {
    const checksum = 'A'.repeat(43) + '=';
    let presignedChecksum: string | undefined;
    const uploadRuntime = {
      ...runtime,
      storage: {
        ...runtime.storage,
        checksumSupport: true,
        createMultipart: ({ key }: { readonly key: string }) =>
          Promise.resolve({ key, uploadId: 'brand-upload' }),
        presignPart: (input: { readonly checksumSha256?: string }) => {
          presignedChecksum = input.checksumSha256;
          return Promise.resolve('https://storage.example.test/part');
        },
      },
    };
    const owner = {
      kind: 'member' as const,
      id: ownerId,
      globalRole: 'owner' as const,
      roomRoles: {},
    };
    const reply = { code: () => reply };
    const created = await createBrandingUploadHandler(uploadRuntime, owner)(
      {
        body: {
          action: 'create',
          assetKind: 'logo',
          mediaType: 'image/png',
          size: 4,
          parts: [{ partNumber: 1, size: 4, checksumSha256: checksum }],
        },
      } as never,
      reply as never,
    );
    expect(presignedChecksum).toBe(checksum);
    const intentId = created.intentId;
    await expect(
      createBrandingUploadHandler(uploadRuntime, owner)(
        {
          body: {
            action: 'finalize',
            intentId,
            uploadId: 'brand-upload',
            parts: [
              { partNumber: 1, etag: 'a'.repeat(32), checksumSha256: 'B'.repeat(43) + '=' },
            ],
          },
        } as never,
        reply as never,
      ),
    ).rejects.toThrow('BRANDING_UPLOAD_PARTS_MISMATCH');
    await runtimePool.query('SELECT finalize_branding_upload($1,$2,$3,$4,$5,$6)', [
      intentId,
      ownerId,
      4,
      createOpaqueId(),
      ...audit(),
    ]);
    await expect(
      createBrandingUploadHandler(uploadRuntime, owner)(
        { body: { action: 'status', intentId } } as never,
        reply as never,
      ),
    ).resolves.toEqual({ intentId, state: 'processing' });
    await expect(
      createBrandingUploadHandler(uploadRuntime, contributor)(
        { body: { action: 'status', intentId } } as never,
        reply as never,
      ),
    ).rejects.toThrow('BRANDING_UPLOAD_FORBIDDEN');
  });

  it('accepts email and HTTPS support contacts, accepts absent, and rejects hostile schemes and controls', async () => {
    const route = createBrandingHandler(runtime, administrator);
    const current = await route({ body: { action: 'read' } } as never);
    // Branding is organization-wide: a Room Manager is refused like any member.
    await expect(
      createBrandingHandler(runtime, manager)({ body: { action: 'read' } } as never),
    ).rejects.toMatchObject({ code: '42501' });
    const update = async (supportContact: string | null, expectedRevision: number) =>
      route({
        body: {
          action: 'update',
          organizationName: 'North Star',
          accentColor: '#08766a',
          senderDisplayName: 'North Star Data Room',
          roomIntroduction: 'Review securely.',
          supportContact,
          expectedRevision,
        },
      } as never);
    const mailIdentity = async () =>
      (
        await workerPool.query<{ organization_name: string; sender_display_name: string }>(
          'SELECT * FROM read_mail_identity()',
        )
      ).rows[0];
    // An unsaved configuration still holds the column default, so mail uses the organization.
    expect(await mailIdentity()).toEqual({
      organization_name: current.organizationName,
      sender_display_name: current.organizationName,
    });
    const email = await update('support@example.com', current.revision);
    expect(await mailIdentity()).toEqual({
      organization_name: 'North Star',
      sender_display_name: 'North Star Data Room',
    });
    expect(email.supportContact).toBe('support@example.com');
    expect(await createSupportHandler(runtime)()).toStrictEqual({
      supportContact: { kind: 'email', value: 'support@example.com' },
    });
    const url = await update('https://support.example/help', email.revision);
    expect(url.supportContact).toBe('https://support.example/help');
    const absent = await update(null, url.revision);
    expect(absent.supportContact).toBeNull();
    expect(await createSupportHandler(runtime)()).toStrictEqual({ supportContact: null });
    for (const value of [
      'http://support.example',
      'javascript:alert(1)',
      'data:text/plain,help',
      'mailto:support@example.com?subject=x',
      'https://support.example/\nheader',
    ])
      await expect(update(value, absent.revision)).rejects.toThrow();
    await expect(
      runtimePool.query(
        'SELECT update_branding_configuration($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          ownerId,
          'North Star',
          '#ffffff',
          'North Star Data Room',
          'Review securely.',
          null,
          null,
          absent.revision,
          createOpaqueId(),
          createCorrelationId(),
        ],
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      createBrandingHandler(runtime, contributor)({ body: { action: 'read' } } as never),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      runtimePool.query("UPDATE organization SET name='Bypass'"),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (await migrationPool.query<{ name: string }>('SELECT name FROM organization')).rows[0]
        ?.name,
    ).toBe('North Star');
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='branding.configuration'",
        )
      ).rows[0]?.n,
    ).toBe(3);
  });

  it('serves effective public branding without leaking internal state, restricts asset mutation, and delivers only derivatives', async () => {
    // 1. Unauthenticated read of public branding
    const publicBrand = await createPublicBrandingHandler(runtime)();
    expect(publicBrand.organizationName).toBe('North Star');
    expect(publicBrand.accentColor).toBe('#08766a');
    expect(publicBrand).not.toHaveProperty('customized');
    expect(publicBrand).not.toHaveProperty('roomIntroduction');
    const viewerProof = 'b'.repeat(64);
    await migrationPool.query(
      "INSERT INTO viewer(id,email_key,email_display,state,session_family_id) VALUES($1,'intro@example.com','intro@example.com','active',$2)",
      [createOpaqueId(), createOpaqueId()],
    );
    const introViewer = (
      await migrationPool.query<{ id: string }>(
        "SELECT id FROM viewer WHERE email_key='intro@example.com'",
      )
    ).rows[0]?.id;
    if (introViewer === undefined) throw new Error('viewer seed failed');
    await migrationPool.query(
      "INSERT INTO viewer_room_membership(id,viewer_id,room_id,state) VALUES($1,$2,$3,'active')",
      [createOpaqueId(), introViewer, roomId],
    );
    await migrationPool.query(
      `INSERT INTO session(id,secret_digest,principal_kind,viewer_id,csrf_digest,family_id,idle_expires_at,absolute_expires_at,state)
       VALUES($1,$2,'viewer',$3,$4,$5,statement_timestamp()+interval '30 minutes',statement_timestamp()+interval '12 hours','active')`,
      [createOpaqueId(), viewerProof, introViewer, 'c'.repeat(64), createOpaqueId()],
    );
    await expect(
      createViewerIntroductionHandler(runtime, {
        kind: 'viewer',
        id: introViewer,
        sessionProof: viewerProof,
      })(),
    ).resolves.toEqual({ roomIntroduction: '' });

    const introDocumentId = createOpaqueId();
    const introVersionId = createOpaqueId();
    const introJobId = createOpaqueId();
    const introLeaseToken = createOpaqueId();
    await migrationPool.query(
      `INSERT INTO document(id,room_id,display_title,description,created_by)
       VALUES($1,$2,'Introduction evidence','',$3)`,
      [introDocumentId, roomId, managerId],
    );
    await migrationPool.query(
      `INSERT INTO job_queue(id,job_type,idempotency_key,payload,state,attempts,lease_owner,lease_token,lease_expires_at)
       VALUES($1,'document.source.validate',$2,jsonb_build_object('versionId',$3::text),'running',1,$4,$5,
         statement_timestamp()+interval '1 hour')`,
      [introJobId, createOpaqueId(), introVersionId, createOpaqueId(), introLeaseToken],
    );
    await migrationPool.query(
      `INSERT INTO document_version(id,document_id,original_filename,object_key,declared_media_type,
       detected_media_type,size_bytes,sha256,state,scan_signature_version)
       VALUES($1,$2,'introduction.pdf',$3,'application/pdf','application/pdf',10,$4,'ready_for_review','1')`,
      [
        introVersionId,
        introDocumentId,
        `quarantine/${createOpaqueId()}/${createOpaqueId()}`,
        'a'.repeat(64),
      ],
    );
    await migrationPool.query(
      `INSERT INTO document_scan_evidence(version_id,job_id,lease_token,signature_version,signatures_published_at)
       VALUES($1,$2,$3,'1',transaction_timestamp())`,
      [introVersionId, introJobId, introLeaseToken],
    );
    await migrationPool.query(
      `INSERT INTO document_derivative(id,version_id,page_number,object_key,media_type,size_bytes,sha256,width,height,accessible_label)
       VALUES($1,$2,1,$3,'image/png',10,$4,1,1,'Page 1')`,
      [
        createOpaqueId(),
        introVersionId,
        `derivatives/${createOpaqueId()}/${createOpaqueId()}`,
        'b'.repeat(64),
      ],
    );
    await migrationPool.query(
      `INSERT INTO published_structure_entry(room_id,entry_id,resource_kind,resource_id,parent_folder_id,
       display_name,description,order_key,source_revision,published_version_id)
       VALUES($1,$2,'document',$3,NULL,'Introduction evidence','',1000,1,$4)`,
      [roomId, createOpaqueId(), introDocumentId, introVersionId],
    );
    await migrationPool.query(
      "UPDATE room SET state='published',published_revision=1 WHERE id=$1",
      [roomId],
    );
    await migrationPool.query(
      `INSERT INTO access_grant(id,room_id,grantee_kind,viewer_id,target_kind,created_by)
       VALUES($1,$2,'viewer',$3,'room',$4)`,
      [createOpaqueId(), roomId, introViewer, managerId],
    );
    const introduction = createViewerIntroductionHandler(runtime, {
      kind: 'viewer',
      id: introViewer,
      sessionProof: viewerProof,
    });
    await expect(introduction()).resolves.toEqual({ roomIntroduction: 'Review securely.' });
    await migrationPool.query(
      "UPDATE viewer_room_membership SET state='revoked' WHERE viewer_id=$1 AND room_id=$2",
      [introViewer, roomId],
    );
    await expect(introduction()).resolves.toEqual({ roomIntroduction: '' });
    await migrationPool.query(
      "UPDATE viewer_room_membership SET state='active' WHERE viewer_id=$1 AND room_id=$2",
      [introViewer, roomId],
    );
    await migrationPool.query(
      "UPDATE session SET idle_expires_at=statement_timestamp()-interval '1 second' WHERE secret_digest=$1",
      [viewerProof],
    );
    await expect(introduction()).resolves.toEqual({ roomIntroduction: '' });
    expect(publicBrand.hasLogo).toBe(false);
    expect(publicBrand.hasSquareMark).toBe(false);
    // Leaks nothing about rooms, object keys, digests, or members
    const serialized = JSON.stringify(publicBrand);
    expect(serialized).not.toContain(roomId);
    expect(serialized).not.toContain(managerId);
    expect(serialized).not.toContain('branding/');

    // 2. Asset delivery returns 404 when asset does not exist
    let statusCode = 200;
    let deliveredBytes: Buffer | null = null;
    const mockReply = {
      code: (code: number) => {
        statusCode = code;
        return mockReply;
      },
      header: () => mockReply,
      send: (body: unknown) => {
        deliveredBytes = body as Buffer;
        return body;
      },
    };
    const missing = await createAssetDeliveryHandler(runtime)(
      { params: { kind: 'logo' } } as never,
      mockReply as never,
    );
    expect(statusCode).toBe(404);
    expect(missing).toEqual({ code: 'BRANDING_ASSET_NOT_FOUND' });

    // 3. Asset deletion authorization: a Room Manager is denied, an Owner allowed
    const deleteRoomManager = createAssetDeleteHandler(runtime, manager);
    await expect(
      deleteRoomManager({ body: { action: 'delete', assetKind: 'logo' } } as never),
    ).rejects.toMatchObject({ code: '42501' });

    // Seed a derivative asset in the database and provide storage delivery
    const testKey = `branding/${createOpaqueId()}/${createOpaqueId()}.png`;
    const testPngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    let deletedKey: string | null = null;
    const customRuntime = {
      ...runtime,
      deliveryStorage: {
        ...runtime.deliveryStorage,
        getObjectBytes: (key: string) => {
          if (key === testKey) return Promise.resolve(testPngBytes);
          return Promise.reject(new Error('not found'));
        },
      },
      storage: {
        ...runtime.storage,
        deleteObject: (key: string) => {
          deletedKey = key;
          return Promise.resolve();
        },
      },
    };

    await migrationPool.query(
      "INSERT INTO branding_asset(asset_kind, object_key, media_type, size_bytes, width, height) VALUES('logo', $1, 'image/png', 4, 100, 100) ON CONFLICT(asset_kind) DO UPDATE SET object_key=EXCLUDED.object_key",
      [testKey],
    );

    // Now public branding reflects hasLogo: true
    const updatedBrand = await createPublicBrandingHandler(runtime)();
    expect(updatedBrand.hasLogo).toBe(true);
    expect(updatedBrand).not.toHaveProperty('customized');

    // Deliver the seeded logo asset
    statusCode = 200;
    await createAssetDeliveryHandler(customRuntime)(
      { params: { kind: 'logo' } } as never,
      mockReply as never,
    );
    expect(statusCode).toBe(200);
    expect(deliveredBytes).toEqual(testPngBytes);

    const deleteAdministrator = createAssetDeleteHandler(customRuntime, administrator);
    const failingRuntime = {
      ...customRuntime,
      storage: {
        ...customRuntime.storage,
        deleteObject: () => Promise.reject(new Error('injected storage failure')),
      },
    };
    await expect(
      createAssetDeleteHandler(
        failingRuntime,
        administrator,
      )({
        body: { action: 'delete', assetKind: 'logo' },
      } as never),
    ).rejects.toThrow('injected storage failure');
    expect(
      (
        await migrationPool.query<{ object_key: string }>(
          "SELECT object_key FROM branding_asset WHERE asset_kind='logo'",
        )
      ).rows[0]?.object_key,
    ).toBe(testKey);

    const deleteResult = await deleteAdministrator({
      body: { action: 'delete', assetKind: 'logo' },
    } as never);
    expect(deleteResult).toEqual({ deleted: true });
    expect(deletedKey).toBe(testKey);

    // Now hasLogo is false again
    const restoredBrand = await createPublicBrandingHandler(runtime)();
    expect(restoredBrand.hasLogo).toBe(false);

    // Resetting branding configuration restores Duefold defaults
    const brandingRoute = createBrandingHandler(runtime, administrator);
    const currentConfig = await brandingRoute({ body: { action: 'read' } } as never);
    await brandingRoute({
      body: {
        action: 'update',
        organizationName: 'Duefold',
        accentColor: '#08766a',
        senderDisplayName: 'Duefold',
        roomIntroduction: '',
        supportContact: null,
        expectedRevision: currentConfig.revision,
      },
    } as never);

    const resetBrand = await createPublicBrandingHandler(runtime)();
    expect(resetBrand.organizationName).toBe('Duefold');
    expect(resetBrand.accentColor).toBe('#08766a');
    expect(resetBrand).not.toHaveProperty('customized');
    expect(resetBrand).not.toHaveProperty('roomIntroduction');
  });

  it('maps a database authorization refusal to a uniform 403 over the wire, not a 500', async () => {
    /*
     * Every handler and database error became HTTP 500, so a refused request was
     * indistinguishable from a crashed one: clients could not build the designed
     * denied state and real faults hid among expected refusals. The other tests
     * here call handlers directly and assert SQLSTATE, so none of them observes
     * the status code. This one goes over the wire.
     */
    const app = await buildTestWebApp({
      runtime,
      authenticate: () =>
        Promise.resolve({
          sessionId: createOpaqueId(),
          familyId: createOpaqueId(),
          csrfDigest: 'a'.repeat(64),
          principal: contributor,
        }),
    });
    try {
      const denied = await app.inject({
        method: 'GET',
        url: `/api/documents/processing?roomId=${otherRoomId}&limit=50`,
      });
      expect(denied.statusCode).toBe(403);
      const body = denied.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe('FORBIDDEN');
      // Non-enumerating: a denial must not disclose whether the room exists.
      expect(denied.body).not.toContain(otherRoomId);
      expect(denied.body).not.toContain('42501');
      expect(denied.body.toLowerCase()).not.toContain('room');
      // Positive arm, same app and same credential: the permitted room succeeds,
      // so the 403 above is a real decision rather than a broken route.
      const allowed = await app.inject({
        method: 'GET',
        url: `/api/documents/processing?roomId=${roomId}&limit=50`,
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.body).toContain('Processing document');
      // A malformed request is a 400, distinct from both denial and fault.
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/documents/processing?roomId=${roomId}&limit=nonsense`,
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('confines grant and branding mutation to audited definer functions, and records what audit INSERT does not prove', async () => {
    /*
     * The gate asked to revoke duefold_runtime's direct INSERT on audit_event,
     * arguing a forged success row breaks the audit invariant. The forgery is
     * real -- I reproduced it -- but revoking the grant is the wrong remedy and
     * would break OTP, session, OIDC, upload, and worker auditing, which
     * legitimately insert from TypeScript outside any definer function.
     *
     * What actually matters is that a SECURITY-STATE CHANGE cannot happen
     * without its audit row. That holds structurally: the runtime role has no
     * table privilege on access_grant, invitation, or branding_configuration, so
     * the only path to a grant is the definer function that writes audit in the
     * SAME transaction. A fabricated row is therefore audit NOISE, not an
     * unaudited mutation, and nothing authorizes off audit content.
     *
     * This test pins both halves so the distinction cannot quietly rot.
     */
    for (const table of ['access_grant', 'invitation', 'branding_configuration']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
        expect(
          (
            await migrationPool.query<{ allowed: boolean }>(
              'SELECT has_table_privilege($1,$2,$3) allowed',
              ['duefold_runtime', table, privilege],
            )
          ).rows[0]?.allowed,
          `${table} ${privilege}`,
        ).toBe(false);
      }
    }
    // Audit stays append-only for every non-migration role.
    for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      for (const role of ['duefold_runtime', 'duefold_authenticator', 'duefold_worker']) {
        expect(
          (
            await migrationPool.query<{ allowed: boolean }>(
              'SELECT has_table_privilege($1,$2,$3) allowed',
              [role, 'audit_event', privilege],
            )
          ).rows[0]?.allowed,
          `${role} ${privilege}`,
        ).toBe(false);
      }
    }
    // Every grant/branding mutation is SECURITY DEFINER and audits internally.
    const definers = await migrationPool.query<{ proname: string; prosecdef: boolean }>(
      `SELECT proname,prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public'
          AND proname IN ('apply_grant_change','update_branding_configuration')`,
    );
    expect(definers.rows.length).toBe(2);
    for (const row of definers.rows) expect(row.prosecdef, row.proname).toBe(true);
  });

  it('keeps protected tables private to runtime and authenticator roles', async () => {
    for (const table of [
      'document_version',
      'document_derivative',
      'access_grant',
      'viewer_room_membership',
      'export_request',
      'branding_configuration',
    ]) {
      expect(
        (
          await migrationPool.query<{ allowed: boolean }>(
            "SELECT has_table_privilege('duefold_runtime',$1,'SELECT') allowed",
            [table],
          )
        ).rows[0]?.allowed,
        table,
      ).toBe(false);
      expect(
        (
          await migrationPool.query<{ allowed: boolean }>(
            "SELECT has_table_privilege('duefold_authenticator',$1,'SELECT') allowed",
            [table],
          )
        ).rows[0]?.allowed,
        table,
      ).toBe(false);
    }
    for (const table of ['member', 'viewer', 'session', 'otp_challenge', 'oidc_transaction'])
      expect(
        (
          await migrationPool.query<{ allowed: boolean }>(
            "SELECT has_table_privilege('duefold_runtime',$1,'INSERT') allowed",
            [table],
          )
        ).rows[0]?.allowed,
        table,
      ).toBe(false);
  });
});
