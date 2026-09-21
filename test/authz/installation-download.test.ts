/**
 * The installation-wide download default: who may read and change it, what the review
 * counts, the asymmetric rules for allowing and denying, and the one-transaction audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { generatedRoutes } from '../../.duefold/generated/routes.ts';
import { closePools, databasePool, migrationPool } from './support/database.ts';
import { app, headers, memberSession } from './support/route-fixture.ts';
import { resetRoomSchema, seedMember, seedRoom, staffRoom } from './support/room-fixture.ts';

let ownerId = '';
let adminId = '';
let plainMemberId = '';
let managerId = '';
let contributorId = '';
let inheritingDocumentId = '';
let overriddenRoomDocumentId = '';

const fresh = () => new Date();
const stale = () => new Date(Date.now() - 20 * 60_000);

async function publishedDocument(roomId: string, override: 'allow' | 'deny' | null) {
  const documentId = createOpaqueId();
  const versionId = createOpaqueId();
  await migrationPool.query(
    'INSERT INTO document(id,room_id,display_title,created_by,download_policy) VALUES($1,$2,$3,$4,$5)',
    [documentId, roomId, 'Memorandum', ownerId, override],
  );
  await migrationPool.query(
    `INSERT INTO document_version
     (id,document_id,original_filename,object_key,declared_media_type,size_bytes,state)
     VALUES($1,$2,'memo.txt',$3,'text/plain',1,'quarantine')`,
    [versionId, documentId, `quarantine/${createOpaqueId()}/${createOpaqueId()}`],
  );
  await migrationPool.query(
    `INSERT INTO published_structure_entry
     (room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,
      order_key,source_revision,published_version_id)
     VALUES($1,$2,'document',$3,NULL,'Memorandum','',1000,1,$4)`,
    [roomId, createOpaqueId(), documentId, versionId],
  );
  return documentId;
}

const publish = (roomId: string) =>
  migrationPool.query("UPDATE room SET published_revision=1,state='published' WHERE id=$1", [
    roomId,
  ]);

beforeAll(async () => {
  ownerId = await resetRoomSchema('Installation download');
  adminId = await seedMember('admin', 'installation.admin');
  plainMemberId = await seedMember('member', 'installation.plain');
  managerId = await seedMember('member', 'installation.manager');
  contributorId = await seedMember('member', 'installation.contributor');

  /* Published and inheriting: its inheriting document is what allowing reaches. */
  const inheriting = await seedRoom(ownerId, 'Inheriting room');
  await staffRoom(managerId, inheriting, 'manager', ownerId);
  await staffRoom(contributorId, inheriting, 'contributor', ownerId);
  inheritingDocumentId = await publishedDocument(inheriting, null);
  await publishedDocument(inheriting, 'allow');
  await publish(inheriting);

  /* Published with its own policy: the default does not reach it. */
  const overridden = await seedRoom(ownerId, 'Overridden room');
  await migrationPool.query("UPDATE room SET download_policy='deny' WHERE id=$1", [overridden]);
  overriddenRoomDocumentId = await publishedDocument(overridden, null);
  await publish(overridden);

  /* A draft inherits, but nothing in it is reachable yet. */
  await publishedDocument(await seedRoom(ownerId, 'Draft room'), null);
});
afterAll(closePools);

const revision = async (): Promise<number> =>
  (
    await migrationPool.query<{ policy_revision: number }>(
      'SELECT policy_revision FROM organization',
    )
  ).rows[0]?.policy_revision ?? 0;

const review = (actor: string, policy: string) =>
  databasePool.query<{ impact: Record<string, unknown> }>(
    'SELECT dry_run_installation_download_policy($1,$2) AS impact',
    [actor, policy],
  );

const apply = (
  actor: string,
  policy: string,
  expected: number,
  authenticatedAt: Date | null,
  confirmation: string | null,
) =>
  databasePool.query<{ revision: number }>(
    'SELECT apply_installation_download_policy($1,$2,$3,$4,$5,$6,$7) AS revision',
    [
      actor,
      policy,
      expected,
      authenticatedAt,
      confirmation,
      createOpaqueId(),
      createCorrelationId(),
    ],
  );

const effective = async (documentId: string): Promise<string | undefined> =>
  (
    await migrationPool.query<{ policy: string }>(
      'SELECT resolve_document_download_policy($1) AS policy',
      [documentId],
    )
  ).rows[0]?.policy;

describe('reading the installation settings', () => {
  it.each([
    ['Owner', () => ownerId],
    ['Admin', () => adminId],
  ])('answers %s with the default and how many rooms inherit it', async (_label, actor) => {
    expect(
      (await databasePool.query('SELECT * FROM read_installation_settings($1)', [actor()]))
        .rows,
    ).toStrictEqual([
      { download_policy: 'deny', policy_revision: 1, inheriting_room_count: 2 },
    ]);
  });

  it.each([
    ['plain Member', () => plainMemberId],
    ['Room Manager', () => managerId],
    ['Room Contributor', () => contributorId],
  ])('refuses a %s, before looking at anything it sent', async (_label, actor) => {
    await expect(
      databasePool.query('SELECT * FROM read_installation_settings($1)', [actor()]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(review(actor(), 'not-a-policy')).rejects.toMatchObject({ code: '42501' });
    await expect(apply(actor(), 'allow', 999, stale(), null)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(apply(actor(), 'deny', 999, stale(), null)).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('authorizes before validation, locks, revisions, state, freshness, and confirmation phrase', async () => {
    const currentRev = await revision();
    /* A contributor calling apply with an invalid policy must get 42501, not 22023. */
    await expect(
      apply(contributorId, 'invalid-policy', currentRev, fresh(), 'ALLOW ORIGINAL DOWNLOADS'),
    ).rejects.toMatchObject({ code: '42501' });

    /* A contributor calling apply with stale revision must get 42501, not 40001. */
    await expect(
      apply(contributorId, 'allow', currentRev + 100, fresh(), 'ALLOW ORIGINAL DOWNLOADS'),
    ).rejects.toMatchObject({ code: '42501' });

    /* A contributor calling apply with held policy must get 42501, not 55000. */
    await expect(apply(contributorId, 'deny', currentRev, fresh(), null)).rejects.toMatchObject(
      {
        code: '42501',
      },
    );

    /* A contributor calling apply with wrong phrase must get 42501, not 22023. */
    await expect(
      apply(contributorId, 'allow', currentRev, fresh(), 'WRONG PHRASE'),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('reviewing a change', () => {
  it('names the inheriting rooms and the published documents viewers can open now', async () => {
    expect((await review(adminId, 'allow')).rows[0]?.impact).toStrictEqual({
      currentPolicy: 'deny',
      proposedPolicy: 'allow',
      inheritingRoomCount: 2,
      affectedDocumentCount: 1,
      requiresFreshAuthentication: true,
      expectedRevision: 1,
      confirmation: 'ALLOW ORIGINAL DOWNLOADS',
    });
  });

  it('refuses to review the value already held, and a value that is not a policy', async () => {
    await expect(review(adminId, 'deny')).rejects.toMatchObject({ code: '55000' });
    await expect(review(adminId, 'sometimes')).rejects.toMatchObject({ code: '22023' });
  });
});

describe('allowing original downloads installation-wide', () => {
  it('needs a fresh sign-in, the exact phrase and the current revision', async () => {
    const expected = await revision();
    await expect(
      apply(ownerId, 'allow', expected, stale(), 'ALLOW ORIGINAL DOWNLOADS'),
    ).rejects.toMatchObject({ code: '42501', message: 'fresh OIDC required' });
    await expect(apply(ownerId, 'allow', expected, fresh(), 'allow')).rejects.toMatchObject({
      code: '22023',
    });
    await expect(apply(ownerId, 'allow', expected, fresh(), null)).rejects.toMatchObject({
      code: '22023',
    });
    await expect(
      apply(ownerId, 'allow', expected + 1, fresh(), 'ALLOW ORIGINAL DOWNLOADS'),
    ).rejects.toMatchObject({ code: '40001' });
  });

  it('changes what every inheriting document resolves to, and audits it', async () => {
    const expected = await revision();
    const applied = await apply(
      adminId,
      'allow',
      expected,
      fresh(),
      'ALLOW ORIGINAL DOWNLOADS',
    );
    expect(applied.rows[0]?.revision).toBe(expected + 1);
    expect(await effective(inheritingDocumentId)).toBe('allow');
    expect(await effective(overriddenRoomDocumentId)).toBe('deny');
    expect(
      (
        await migrationPool.query(
          `SELECT actor_id,resource_type,reason_code,detail FROM audit_event
            WHERE reason_code='INSTALLATION_DOWNLOAD_POLICY_CHANGED' ORDER BY occurred_at DESC LIMIT 1`,
        )
      ).rows[0],
    ).toStrictEqual({
      actor_id: adminId,
      resource_type: 'organization',
      reason_code: 'INSTALLATION_DOWNLOAD_POLICY_CHANGED',
      detail: { policy: 'allow', policyRevision: expected + 1 },
    });
  });
});

describe('denying original downloads installation-wide', () => {
  it('takes no phrase and no fresh sign-in, because it only removes access', async () => {
    const expected = await revision();
    await expect(
      apply(ownerId, 'deny', expected, stale(), 'ALLOW ORIGINAL DOWNLOADS'),
    ).rejects.toMatchObject({ code: '22023' });
    expect((await apply(ownerId, 'deny', expected, stale(), null)).rows[0]?.revision).toBe(
      expected + 1,
    );
    expect(await effective(inheritingDocumentId)).toBe('deny');
  });

  it('refuses a change to the value already held', async () => {
    await expect(apply(ownerId, 'deny', await revision(), fresh(), null)).rejects.toMatchObject(
      {
        code: '55000',
      },
    );
  });
});

describe('transaction property (Invariant 14)', () => {
  it('commits the mutation and audit row in one transaction, rolling back both on failure', async () => {
    const client = await databasePool.connect();
    const currentRev = await revision();
    try {
      await client.query('BEGIN');
      const res = await client.query<{ revision: number }>(
        'SELECT apply_installation_download_policy($1,$2,$3,$4,$5,$6,$7) AS revision',
        [
          ownerId,
          'allow',
          currentRev,
          fresh(),
          'ALLOW ORIGINAL DOWNLOADS',
          createOpaqueId(),
          createCorrelationId(),
        ],
      );
      expect(res.rows[0]?.revision).toBe(currentRev + 1);

      /* Uncommitted: the change and the audit row are visible in this transaction. */
      const inTxPolicy = (
        await client.query<{ installation_download_policy: string }>(
          'SELECT installation_download_policy FROM organization',
        )
      ).rows[0]?.installation_download_policy;
      expect(inTxPolicy).toBe('allow');

      const inTxAudit = (
        await client.query<{ count: string }>(
          "SELECT count(*) AS count FROM audit_event WHERE reason_code='INSTALLATION_DOWNLOAD_POLICY_CHANGED'",
        )
      ).rows[0]?.count;
      expect(Number(inTxAudit)).toBeGreaterThan(0);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    /* After rollback, neither the policy change nor the audit event survived. */
    const postRollback = (
      await migrationPool.query<{
        installation_download_policy: string;
        policy_revision: number;
      }>('SELECT installation_download_policy, policy_revision FROM organization')
    ).rows[0];
    expect(postRollback?.installation_download_policy).toBe('deny');
    expect(postRollback?.policy_revision).toBe(currentRev);
  });
});

describe('the setter from 007', () => {
  it('is no longer callable by the web credential', async () => {
    await expect(
      databasePool.query('SELECT set_installation_download_policy($1,$2,$3,$4,$5)', [
        ownerId,
        'allow',
        await revision(),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('audit detail content boundary', () => {
  it('carries no configured value, no email, and no storage key in audit detail', async () => {
    const rows = (
      await migrationPool.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_event WHERE reason_code='INSTALLATION_DOWNLOAD_POLICY_CHANGED'`,
      )
    ).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const text = JSON.stringify(row.detail);
      expect(text).not.toMatch(/@/);
      expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(text).not.toMatch(/s3:\/\/|\/var\/|quarantine\//);
      for (const envKey of [
        'DUEFOLD_TEST_DATABASE_URL',
        'DUEFOLD_STORAGE_BUCKET',
        'DUEFOLD_STORAGE_ENDPOINT',
        'DUEFOLD_OIDC_ISSUER',
        'DUEFOLD_OIDC_CLIENT_ID',
        'DUEFOLD_AUTH_MAIL_FROM',
      ]) {
        const val = process.env[envKey];
        if (val) expect(text).not.toContain(val);
      }
    }
  });
});

describe('the installation routes', () => {
  it('declares both routes member-audience, CSRF on the change, with the error envelope', () => {
    for (const [id, method, path, csrf] of [
      ['installation.settings.read', 'GET', '/api/installation', false],
      ['installation.download-policy', 'POST', '/api/installation/download-policy', true],
    ] as const) {
      const route = generatedRoutes.find((entry) => entry.id === id);
      expect(route).toMatchObject({ method, path, audience: 'member', csrf });
      const responses = (route?.schema as { readonly response: Record<string, unknown> })
        .response;
      for (const status of [400, 401, 403, 409, 500])
        expect(responses[String(status)], `${id} ${status}`).toBeDefined();
    }
  });

  it('reads the settings for an Admin and refuses a plain Member uniformly', async () => {
    const instance = await app();
    const read = async (memberId: string) =>
      instance.inject({
        method: 'GET',
        url: '/api/installation',
        headers: headers(await memberSession(memberId), false),
      });
    expect((await read(adminId)).json()).toStrictEqual({
      settings: { downloadPolicy: 'deny', revision: await revision(), inheritingRoomCount: 2 },
    });
    const refused = await read(plainMemberId);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
    await instance.close();
  });

  it('reviews, then asks a stale session to sign in again before allowing', async () => {
    const instance = await app();
    const post = async (payload: Record<string, unknown>, authenticatedAt: Date) =>
      instance.inject({
        method: 'POST',
        url: '/api/installation/download-policy',
        headers: headers(await memberSession(ownerId, authenticatedAt)),
        payload,
      });
    const reviewed = await post({ action: 'dry-run', policy: 'allow' }, fresh());
    expect(reviewed.statusCode).toBe(200);
    const { impact } = reviewed.json<{
      impact: { expectedRevision: number; confirmation: string };
    }>();
    const change = {
      action: 'apply',
      policy: 'allow',
      expectedRevision: impact.expectedRevision,
      confirmation: impact.confirmation,
    };
    const refused = await post(change, stale());
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe(
      'FRESH_AUTHENTICATION_REQUIRED',
    );
    const applied = await post(change, fresh());
    expect(applied.json()).toStrictEqual({ revision: impact.expectedRevision + 1 });
    const denied = await post(
      { action: 'apply', policy: 'deny', expectedRevision: impact.expectedRevision + 1 },
      stale(),
    );
    expect(denied.json()).toStrictEqual({ revision: impact.expectedRevision + 2 });
    await instance.close();
  });

  it('rejects a deny that carries a phrase, and any change without CSRF', async () => {
    const instance = await app();
    const session = await memberSession(ownerId);
    const payload = {
      action: 'apply',
      policy: 'deny',
      expectedRevision: await revision(),
      confirmation: 'ALLOW ORIGINAL DOWNLOADS',
    };
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/api/installation/download-policy',
          headers: headers(session),
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/api/installation/download-policy',
          headers: headers(session, false),
          payload: { action: 'dry-run', policy: 'allow' },
        })
      ).statusCode,
    ).toBe(403);
    await instance.close();
  });
});
