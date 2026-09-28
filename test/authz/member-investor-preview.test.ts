/**
 * Investor preview: a Room Manager reads published content through member-authorized
 * projections that never touch viewer sessions, watermark caches, or preview evidence.
 *
 * The routes carry no role branch, so every refusal here is PostgreSQL's, reached
 * through the real app and real sessions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { generatedRoutes } from '../../.duefold/generated/routes.ts';
import { createSessionAuthenticator } from '../../apps/web/src/authenticate.ts';
import type { DeliveryStorage } from '../../modules/rooms-documents/src/storage/s3-compatible.ts';
import { buildTestWebApp, testWebRuntime } from '../support/web-runtime.ts';
import { authPool, closePools, databasePool, migrationPool } from './support/database.ts';
import { headers, memberSession, viewerCookie } from './support/route-fixture.ts';
import { resetRoomSchema, seedMember, seedRoom, staffRoom } from './support/room-fixture.ts';

let ownerId = '';
let adminId = '';
let managerId = '';
let contributorId = '';
let outsiderId = '';
let disabledManagerId = '';
let roomId = '';
const viewerId = createOpaqueId();
const folderId = createOpaqueId(),
  documentId = createOpaqueId(),
  draftDocumentId = createOpaqueId(),
  unreadyDocumentId = createOpaqueId();
const versionId = createOpaqueId(),
  replacementVersionId = createOpaqueId(),
  draftVersionId = createOpaqueId(),
  unreadyVersionId = createOpaqueId();

const PNG = new Uint8Array([137, 80, 78, 71]);
const requestedKeys: string[] = [];
const storage = {
  getObjectBytes: (key: string) => {
    requestedKeys.push(key);
    return Promise.resolve(PNG);
  },
} as unknown as DeliveryStorage;

function audit(): readonly [string, string] {
  return [createOpaqueId(), createCorrelationId()];
}

/** A version with a clean scan and derivatives: what publication requires. */
async function seedReadyVersion(id: string, document: string, pages: readonly string[]) {
  const jobId = createOpaqueId(),
    token = createOpaqueId();
  await migrationPool.query(
    `INSERT INTO job_queue(id,job_type,idempotency_key,payload,state,attempts,lease_owner,lease_token,lease_expires_at)
     VALUES($1,'document.source.validate',$2,jsonb_build_object('versionId',$3::text),'running',1,$4,$5,
       transaction_timestamp()+interval '1 hour')`,
    [jobId, createOpaqueId(), id, createOpaqueId(), token],
  );
  await migrationPool.query(
    `INSERT INTO document_version(id,document_id,original_filename,object_key,declared_media_type,
       detected_media_type,size_bytes,sha256,state,scan_signature_version)
     VALUES($1,$2,'model.pdf',$3,'application/pdf','application/pdf',10,$4,'ready_for_review','1')`,
    [id, document, `quarantine/${createOpaqueId()}/${createOpaqueId()}`, 'a'.repeat(64)],
  );
  await migrationPool.query(
    `INSERT INTO document_scan_evidence(version_id,job_id,lease_token,signature_version,signatures_published_at)
     VALUES($1,$2,$3,'1',transaction_timestamp())`,
    [id, jobId, token],
  );
  for (const [index, text] of pages.entries())
    await migrationPool.query(
      `INSERT INTO document_derivative(id,version_id,page_number,object_key,media_type,size_bytes,sha256,width,height,accessible_label,text_layer)
       VALUES($1,$2,$3,$4,'image/png',10,$5,100,100,$6,$7::jsonb)`,
      [
        createOpaqueId(),
        id,
        index + 1,
        `derivatives/${id}/${createOpaqueId()}`,
        'b'.repeat(64),
        `Page ${String(index + 1)}`,
        JSON.stringify([
          { text, x: 0.1, y: 0.1, width: 0.5, height: 0.05, link: 'https://example.com/terms' },
        ]),
      ],
    );
}

async function previewRoom(actor: string) {
  return (
    await databasePool.query<{ room: unknown }>('SELECT read_member_preview_room($1,$2) room', [
      actor,
      roomId,
    ])
  ).rows[0]?.room;
}
async function previewDocument(actor: string, document: string, correlation?: string) {
  return (
    await databasePool.query<Record<string, unknown>>(
      'SELECT * FROM read_member_preview_document($1,$2,$3,$4,$5)',
      [actor, roomId, document, createOpaqueId(), correlation ?? createCorrelationId()],
    )
  ).rows;
}
async function previewPage(actor: string, document: string, page: number) {
  return (
    await databasePool.query<Record<string, unknown>>(
      'SELECT * FROM read_member_preview_page($1,$2,$3,$4)',
      [actor, roomId, document, page],
    )
  ).rows;
}
async function previewAuditCount(): Promise<number> {
  const row = (
    await migrationPool.query<{ count: string }>(
      "SELECT count(*) FROM audit_event WHERE event_type='room.preview.document'",
    )
  ).rows[0];
  return Number(row?.count ?? 0);
}

function app() {
  return buildTestWebApp({
    runtime: testWebRuntime({ pool: databasePool, authPool, deliveryStorage: storage }),
    authenticate: createSessionAuthenticator(authPool, { idleMinutes: 30, absoluteHours: 12 }),
  });
}
async function get(url: string, memberId: string) {
  const instance = await app();
  const response = await instance.inject({
    method: 'GET',
    url,
    headers: headers(await memberSession(memberId), false),
  });
  await instance.close();
  return response;
}

beforeAll(async () => {
  ownerId = await resetRoomSchema('Preview authz');
  adminId = await seedMember('admin', 'preview.admin');
  managerId = await seedMember('member', 'preview.manager');
  contributorId = await seedMember('member', 'preview.contributor');
  outsiderId = await seedMember('member', 'preview.outsider');
  disabledManagerId = await seedMember('member', 'preview.disabled');
  roomId = await seedRoom(ownerId, 'Preview room');
  await staffRoom(managerId, roomId, 'manager', ownerId);
  await staffRoom(contributorId, roomId, 'contributor', ownerId);
  await staffRoom(disabledManagerId, roomId, 'manager', ownerId);
  await migrationPool.query("UPDATE member SET state='disabled' WHERE id=$1", [
    disabledManagerId,
  ]);
  await migrationPool.query(
    'INSERT INTO viewer (id,email_key,email_display,session_family_id) VALUES ($1,$2,$2,$3)',
    [viewerId, 'preview.viewer@example.test', createOpaqueId()],
  );

  await migrationPool.query('INSERT INTO folder(id,room_id,created_by) VALUES($1,$2,$3)', [
    folderId,
    roomId,
    ownerId,
  ]);
  await migrationPool.query(
    `INSERT INTO document(id,room_id,display_title,created_by)
     VALUES($1,$2,'Investor model',$3),($4,$2,'Draft plan',$3),($5,$2,'Unready model',$3)`,
    [documentId, roomId, ownerId, draftDocumentId, unreadyDocumentId],
  );
  await seedReadyVersion(versionId, documentId, ['Revenue 2026', 'Appendix']);
  await seedReadyVersion(draftVersionId, draftDocumentId, ['Draft only']);
  // A derivative without scan evidence, so the version has no publication evidence.
  await migrationPool.query(
    `INSERT INTO document_version(id,document_id,original_filename,object_key,declared_media_type,
       detected_media_type,size_bytes,sha256,state)
     VALUES($1,$2,'unready.pdf',$3,'application/pdf','application/pdf',10,$4,'source_validated')`,
    [
      unreadyVersionId,
      unreadyDocumentId,
      `quarantine/${createOpaqueId()}/${createOpaqueId()}`,
      'c'.repeat(64),
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
  const documentEntryId = createOpaqueId();
  const unreadyEntryId = createOpaqueId();
  // The draft document exists only in the working structure: it was never published.
  await migrationPool.query(
    `INSERT INTO working_structure_entry(id,room_id,folder_id,document_id,parent_folder_id,display_name,order_key)
     VALUES($1,$2,$1,NULL,NULL,'Financials',1000),($3,$2,NULL,$4,$1,'Investor model',2000),
       ($5,$2,NULL,$6,$1,'Draft plan',3000),($7,$2,NULL,$8,$1,'Unready model',4000)`,
    [
      folderId,
      roomId,
      documentEntryId,
      documentId,
      createOpaqueId(),
      draftDocumentId,
      unreadyEntryId,
      unreadyDocumentId,
    ],
  );
  await migrationPool.query(
    `INSERT INTO published_structure_entry(room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,order_key,source_revision,published_version_id)
     VALUES($1,$2,'folder',$2,NULL,'Financials','',1000,1,NULL),
       ($1,$3,'document',$4,$2,'Investor model','',2000,1,$5),
       ($1,$6,'document',$7,$2,'Unready model','',4000,1,$8)`,
    [
      roomId,
      folderId,
      documentEntryId,
      documentId,
      versionId,
      unreadyEntryId,
      unreadyDocumentId,
      unreadyVersionId,
    ],
  );
});

afterAll(closePools);

describe('investor preview authority', () => {
  it.each([
    ['Owner', () => ownerId],
    ['Admin', () => adminId],
    ['assigned Manager', () => managerId],
  ])('lets the %s read the published room', async (_label, actor) => {
    const room = (await previewRoom(actor())) as {
      title: string;
      state: string;
      entries: { displayName: string; siblingPosition: number }[];
    };
    expect(room.title).toBe('Preview room');
    expect(room.state).toBe('draft');
    expect(room.entries.map((entry) => [entry.displayName, entry.siblingPosition])).toEqual([
      ['Financials', 1],
      ['Investor model', 1],
    ]);
  });

  it.each([
    ['Contributor', () => contributorId],
    ['unassigned member', () => outsiderId],
    ['disabled Manager', () => disabledManagerId],
  ])('refuses the %s on every projection', async (_label, actor) => {
    await expect(previewRoom(actor())).rejects.toMatchObject({ code: '42501' });
    await expect(previewDocument(actor(), documentId)).rejects.toMatchObject({ code: '42501' });
    await expect(previewPage(actor(), documentId, 1)).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a Manager whose assignment was revoked mid-preview', async () => {
    const formerId = await seedMember('member', 'preview.former');
    await staffRoom(formerId, roomId, 'manager', ownerId);
    expect(await previewPage(formerId, documentId, 1)).toHaveLength(1);
    await databasePool.query('SELECT apply_room_assignments($1,$2::jsonb,$3::jsonb,$4,$5,$6)', [
      formerId,
      '[]',
      JSON.stringify([roomId]),
      ownerId,
      ...audit(),
    ]);
    await expect(previewPage(formerId, documentId, 1)).rejects.toMatchObject({ code: '42501' });
  });

  it('is executable by the web runtime alone, and keeps its guard internal', async () => {
    const rows = (
      await migrationPool.query<{ role: string; fn: string; allowed: boolean }>(
        `SELECT r.role, f.fn, has_function_privilege(r.role,f.fn,'EXECUTE') allowed
         FROM unnest(ARRAY['duefold_worker','duefold_authenticator','duefold_runtime']) r(role)
         CROSS JOIN unnest(ARRAY[
           'read_member_preview_room(text,text)',
           'read_member_preview_document(text,text,text,text,text)',
           'read_member_preview_page(text,text,text,integer)',
           'assert_member_preview(text,text)'
         ]) f(fn)`,
      )
    ).rows;
    for (const row of rows)
      expect(row.allowed, `${row.role} ${row.fn}`).toBe(
        row.role === 'duefold_runtime' && !row.fn.startsWith('assert_'),
      );
  });
});

describe('investor preview content', () => {
  it('hides a document whose published version lacks publication evidence', async () => {
    expect(await previewDocument(managerId, unreadyDocumentId)).toEqual([]);
    expect(await previewPage(managerId, unreadyDocumentId, 1)).toEqual([]);
  });

  it('never returns a document that exists only in the working structure', async () => {
    expect(await previewDocument(managerId, draftDocumentId)).toEqual([]);
    expect(await previewPage(managerId, draftDocumentId, 1)).toEqual([]);
  });

  it('returns published metadata and audits exactly one open with the exact version', async () => {
    const before = await previewAuditCount();
    const correlation = createCorrelationId();
    expect(await previewDocument(managerId, documentId, correlation)).toEqual([
      {
        document_id: documentId,
        display_title: 'Investor model',
        published_version_id: versionId,
        page_count: 2,
        download_policy: 'deny',
      },
    ]);
    expect(await previewAuditCount()).toBe(before + 1);
    const event = (
      await migrationPool.query(
        'SELECT actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,detail FROM audit_event WHERE correlation_id=$1',
        [correlation],
      )
    ).rows;
    expect(event).toEqual([
      {
        actor_kind: 'member',
        actor_id: managerId,
        room_id: roomId,
        resource_type: 'document',
        resource_id: documentId,
        result: 'success',
        reason_code: 'INVESTOR_PREVIEW',
        detail: { versionId },
      },
    ]);
  });

  it('writes no audit row when nothing is disclosed or the actor is refused', async () => {
    const before = await previewAuditCount();
    await previewDocument(managerId, draftDocumentId);
    await previewDocument(managerId, unreadyDocumentId);
    await expect(previewDocument(contributorId, documentId)).rejects.toMatchObject({
      code: '42501',
    });
    await previewPage(managerId, documentId, 1);
    expect(await previewAuditCount()).toBe(before);
  });

  it('writes nothing to viewer delivery, evidence, or download tables', async () => {
    await previewDocument(managerId, documentId);
    await previewPage(managerId, documentId, 1);
    const counts = (
      await migrationPool.query<Record<string, string>>(
        `SELECT (SELECT count(*) FROM watermark_cache) caches,
           (SELECT count(*) FROM preview_activity) activities,
           (SELECT count(*) FROM preview_delivery_telemetry) telemetry,
           (SELECT count(*) FROM download_lease) leases`,
      )
    ).rows[0];
    expect(counts).toEqual({ caches: '0', activities: '0', telemetry: '0', leases: '0' });
  });
});

describe('investor preview routes', () => {
  const pageQuery = (page: string | number, document = documentId) =>
    `roomId=${roomId}&documentId=${document}&pageNumber=${String(page)}`;

  it('declares four member GET routes with the validated error envelope', () => {
    for (const [id, path] of [
      ['room.preview.structure', '/api/rooms/preview/structure'],
      ['room.preview.document', '/api/rooms/preview/document'],
      ['room.preview.page.image', '/api/rooms/preview/page/image'],
      ['room.preview.page.text', '/api/rooms/preview/page/text'],
    ] as const) {
      const route = generatedRoutes.find((entry) => entry.id === id);
      expect(route).toMatchObject({ method: 'GET', path, audience: 'member', csrf: false });
      const responses = (route?.schema as { readonly response: Record<string, unknown> })
        .response;
      for (const status of [400, 401, 403, 404, 409, 500])
        expect(responses[String(status)], `${id} ${String(status)}`).toBeDefined();
    }
  });

  it('returns the room title and published entries', async () => {
    const response = await get(`/api/rooms/preview/structure?roomId=${roomId}`, managerId);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = response.json<{
      title: string;
      state: string;
      entries: { displayName: string }[];
    }>();
    expect(body.title).toBe('Preview room');
    expect(body.state).toBe('draft');
    expect(body.entries.map((entry) => entry.displayName)).toEqual([
      'Financials',
      'Investor model',
    ]);
  });

  it('answers a room that does not exist as not found, not as an empty room', async () => {
    const response = await get(
      `/api/rooms/preview/structure?roomId=${createOpaqueId()}`,
      ownerId,
    );
    expect(response.statusCode).toBe(404);
    expect(response.json()).toStrictEqual({
      error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
    });
  });

  it.each([
    ['Contributor', () => contributorId],
    ['unassigned member', () => outsiderId],
  ])('refuses a %s with the uniform 403 on every route', async (_label, actor) => {
    for (const url of [
      `/api/rooms/preview/structure?roomId=${roomId}`,
      `/api/rooms/preview/document?roomId=${roomId}&documentId=${documentId}`,
      `/api/rooms/preview/page/image?${pageQuery(1)}`,
      `/api/rooms/preview/page/text?${pageQuery(1)}`,
    ]) {
      const response = await get(url, actor());
      expect(response.statusCode, url).toBe(403);
      expect(response.json()).toStrictEqual({
        error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
      });
    }
  });

  it('refuses a viewer session and an unauthenticated request', async () => {
    const instance = await app();
    const url = `/api/rooms/preview/page/image?${pageQuery(1)}`;
    expect((await instance.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(
      (await instance.inject({ method: 'GET', url, headers: await viewerCookie(viewerId) }))
        .statusCode,
    ).toBe(401);
    await instance.close();
  });

  it('accepts exactly the derivative page range and rejects malformed numbers', async () => {
    for (const page of ['0', '-1', '1.5', '01', '10001', 'one']) {
      const response = await get(`/api/rooms/preview/page/text?${pageQuery(page)}`, managerId);
      expect(response.statusCode, page).toBe(400);
    }
    // The derivative bound is 10000 pages, so both ends are well-formed; they are absent here.
    for (const page of ['9999', '10000']) {
      const response = await get(`/api/rooms/preview/page/text?${pageQuery(page)}`, managerId);
      expect(response.statusCode, page).toBe(404);
    }
  });

  it('returns document metadata, or null for undisclosed content', async () => {
    const found = await get(
      `/api/rooms/preview/document?roomId=${roomId}&documentId=${documentId}`,
      managerId,
    );
    expect(found.json()).toStrictEqual({
      document: {
        documentId,
        displayTitle: 'Investor model',
        publishedVersionId: versionId,
        pageCount: 2,
        downloadPolicy: 'deny',
      },
    });
    const hidden = await get(
      `/api/rooms/preview/document?roomId=${roomId}&documentId=${draftDocumentId}`,
      managerId,
    );
    expect(hidden.json()).toStrictEqual({ document: null });
  });

  it('streams the stored derivative with its media type', async () => {
    const response = await get(`/api/rooms/preview/page/image?${pageQuery(1)}`, managerId);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(new Uint8Array(response.rawPayload)).toEqual(PNG);
    expect(requestedKeys.at(-1)).toMatch(new RegExp(`^derivatives/${versionId}/`, 'u'));
  });

  it('answers a missing page as not found', async () => {
    for (const url of [
      `/api/rooms/preview/page/image?${pageQuery(3)}`,
      `/api/rooms/preview/page/text?${pageQuery(1, draftDocumentId)}`,
    ])
      expect((await get(url, managerId)).statusCode, url).toBe(404);
  });

  it('returns the text layer with every link removed', async () => {
    const response = await get(`/api/rooms/preview/page/text?${pageQuery(1)}`, managerId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({
      versionId,
      accessibleLabel: 'Page 1',
      items: [{ text: 'Revenue 2026', x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
    });
  });

  // Last in the file: it republishes the document every earlier case reads.
  it('serves the currently published derivative after a republication', async () => {
    await seedReadyVersion(replacementVersionId, documentId, ['Restated revenue']);
    await migrationPool.query(
      'UPDATE published_structure_entry SET published_version_id=$1 WHERE room_id=$2 AND resource_id=$3',
      [replacementVersionId, roomId, documentId],
    );
    expect(await previewPage(managerId, documentId, 1)).toMatchObject([
      { version_id: replacementVersionId, media_type: 'image/png', accessible_label: 'Page 1' },
    ]);
    expect(await previewPage(managerId, documentId, 2)).toEqual([]);
    const text = await get(`/api/rooms/preview/page/text?${pageQuery(1)}`, managerId);
    expect(text.json()).toMatchObject({ versionId: replacementVersionId });
    expect(
      (await get(`/api/rooms/preview/page/image?${pageQuery(2)}`, managerId)).statusCode,
    ).toBe(404);
  });
});
