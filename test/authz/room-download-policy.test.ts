/**
 * Download policy: the room's, and a document's exception to it.
 *
 * Both setters authorize before anything else, so a Contributor is told they may not act
 * rather than told to reload. Both refuse setting the value already held, because an audit
 * row is evidence that something changed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpaqueId } from '@duefold/shared/ids';
import { closeRoutePools, migrationPool } from './support/route-fixture.ts';
import { roomRevision } from './support/room-fixture.ts';
import {
  documentRevision,
  policies,
  seedPolicyFixture,
  type PolicyFixture,
} from './support/policy-fixture.ts';

let fixture: PolicyFixture;
let ownerId: string;
let managerId: string;
let contributorId: string;
let plainMemberId: string;
let roomId: string;
let otherRoomId: string;
let documentId: string;
let otherDocumentId: string;

beforeAll(async () => {
  fixture = await seedPolicyFixture('Room download-policy');
  ({
    ownerId,
    managerId,
    contributorId,
    plainMemberId,
    roomId,
    otherRoomId,
    documentId,
    otherDocumentId,
  } = fixture);
});

afterAll(closeRoutePools);

describe('room download policy', () => {
  it('refuses a Contributor as forbidden, not as a conflict', async () => {
    const response = await policies(contributorId, {
      action: 'room-download',
      roomId,
      policy: 'allow',
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
  });

  it('lets a Manager allow downloads, audits it, and refuses the same value again', async () => {
    const before = await roomRevision(roomId);
    const response = await policies(managerId, {
      action: 'room-download',
      roomId,
      policy: 'allow',
      expectedRoomRevision: before,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ roomRevision: before + 1 });
    expect(
      (
        await migrationPool.query(
          "SELECT reason_code FROM audit_event WHERE room_id=$1 AND event_type='download.policy'",
          [roomId],
        )
      ).rows,
    ).toEqual([{ reason_code: 'ROOM_DOWNLOAD_POLICY_CHANGED' }]);
    const again = await policies(managerId, {
      action: 'room-download',
      roomId,
      policy: 'allow',
      expectedRoomRevision: before + 1,
    });
    expect(again.statusCode).toBe(409);
  });

  it('refuses a stale revision', async () => {
    const response = await policies(managerId, {
      action: 'room-download',
      roomId,
      policy: 'deny',
      expectedRoomRevision: (await roomRevision(roomId)) - 1,
    });
    expect(response.statusCode).toBe(409);
  });

  it('decides authority before anything else for room download policy', async () => {
    const staleRefusal = await policies(contributorId, {
      action: 'room-download',
      roomId,
      policy: 'allow',
      expectedRoomRevision: (await roomRevision(roomId)) - 1,
    });
    expect(staleRefusal.statusCode).toBe(403);

    const current =
      (
        await migrationPool.query<{ download_policy: string | null }>(
          'SELECT download_policy FROM room WHERE id=$1',
          [roomId],
        )
      ).rows[0]?.download_policy ?? null;

    const noopRefusal = await policies(contributorId, {
      action: 'room-download',
      roomId,
      policy: current,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(noopRefusal.statusCode).toBe(403);

    const plainRefusal = await policies(plainMemberId, {
      action: 'room-download',
      roomId,
      policy: 'deny',
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(plainRefusal.statusCode).toBe(403);
  });

  it('refuses unchanged room download policy with 55000 and writes no audit row', async () => {
    const countAudit = async () =>
      Number(
        (
          await migrationPool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM audit_event WHERE room_id=$1 AND event_type='download.policy' AND resource_type='room'",
            [roomId],
          )
        ).rows[0]?.count,
      );

    /* Starts from the installation default, so the no-op below is a no-op whatever ran
       before. Set at the table because setting it through the route would itself be the
       change this case is about to test. */
    await migrationPool.query('UPDATE room SET download_policy=NULL WHERE id=$1', [roomId]);

    const beforeAudit = await countAudit();
    const noopNull = await policies(managerId, {
      action: 'room-download',
      roomId,
      policy: null,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(noopNull.statusCode).toBe(409);
    expect(await countAudit()).toBe(beforeAudit);

    const toAllow = await policies(managerId, {
      action: 'room-download',
      roomId,
      policy: 'allow',
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(toAllow.statusCode).toBe(200);
    expect(await countAudit()).toBe(beforeAudit + 1);

    const noopAllow = await policies(managerId, {
      action: 'room-download',
      roomId,
      policy: 'allow',
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(noopAllow.statusCode).toBe(409);
    expect(await countAudit()).toBe(beforeAudit + 1);

    const toDeny = await policies(managerId, {
      action: 'room-download',
      roomId,
      policy: 'deny',
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(toDeny.statusCode).toBe(200);
    expect(await countAudit()).toBe(beforeAudit + 2);

    const noopDeny = await policies(managerId, {
      action: 'room-download',
      roomId,
      policy: 'deny',
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(noopDeny.statusCode).toBe(409);
    expect(await countAudit()).toBe(beforeAudit + 2);

    const toNull = await policies(managerId, {
      action: 'room-download',
      roomId,
      policy: null,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(toNull.statusCode).toBe(200);
    expect(await countAudit()).toBe(beforeAudit + 3);
  });

  it('refuses unknown room id indistinguishably from unreachable room', async () => {
    const unknownId = createOpaqueId();
    const ownerUnknown = await policies(ownerId, {
      action: 'room-download',
      roomId: unknownId,
      policy: 'allow',
      expectedRoomRevision: 1,
    });
    expect(ownerUnknown.statusCode).toBe(403);

    const contributorOther = await policies(contributorId, {
      action: 'room-download',
      roomId: otherRoomId,
      policy: 'allow',
      expectedRoomRevision: await roomRevision(otherRoomId),
    });
    expect(contributorOther.statusCode).toBe(403);

    const contributorUnknown = await policies(contributorId, {
      action: 'room-download',
      roomId: unknownId,
      policy: 'allow',
      expectedRoomRevision: 1,
    });
    expect(contributorUnknown.statusCode).toBe(403);
    expect(contributorOther.json()).toStrictEqual(contributorUnknown.json());
  });
});

describe('document download exception', () => {
  /* The answer names the DOCUMENT's new revision, which is the counter the next edit of this
     document must send. The transitions themselves are covered below. */
  it('answers with the document revision it advanced', async () => {
    const set = await policies(managerId, {
      action: 'document-download',
      documentId,
      policy: 'deny',
      expectedDocumentRevision: await documentRevision(documentId),
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toStrictEqual({ documentRevision: await documentRevision(documentId) });
  });

  it('refuses a Contributor', async () => {
    const response = await policies(contributorId, {
      action: 'document-download',
      documentId,
      policy: 'allow',
      expectedDocumentRevision: await documentRevision(documentId),
    });
    expect(response.statusCode).toBe(403);
  });

  it('decides authority before anything else for document download policy', async () => {
    const staleRefusal = await policies(contributorId, {
      action: 'document-download',
      documentId,
      policy: 'allow',
      expectedDocumentRevision: (await documentRevision(documentId)) - 1,
    });
    expect(staleRefusal.statusCode).toBe(403);

    const noopRefusal = await policies(contributorId, {
      action: 'document-download',
      documentId,
      policy: null,
      expectedDocumentRevision: await documentRevision(documentId),
    });
    expect(noopRefusal.statusCode).toBe(403);
  });

  it('refuses unchanged document download policy with 55000 and writes no audit row', async () => {
    const countAudit = async () =>
      Number(
        (
          await migrationPool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM audit_event WHERE resource_id=$1 AND event_type='download.policy' AND resource_type='document'",
            [documentId],
          )
        ).rows[0]?.count,
      );

    /* Starts from no exception, so the no-op below is a no-op whatever ran before. */
    await migrationPool.query('UPDATE document SET download_policy=NULL WHERE id=$1', [
      documentId,
    ]);

    const beforeAudit = await countAudit();
    const noopNull = await policies(managerId, {
      action: 'document-download',
      documentId,
      policy: null,
      expectedDocumentRevision: await documentRevision(documentId),
    });
    expect(noopNull.statusCode).toBe(409);
    expect(await countAudit()).toBe(beforeAudit);

    const toDeny = await policies(managerId, {
      action: 'document-download',
      documentId,
      policy: 'deny',
      expectedDocumentRevision: await documentRevision(documentId),
    });
    expect(toDeny.statusCode).toBe(200);
    expect(await countAudit()).toBe(beforeAudit + 1);

    const noopDeny = await policies(managerId, {
      action: 'document-download',
      documentId,
      policy: 'deny',
      expectedDocumentRevision: await documentRevision(documentId),
    });
    expect(noopDeny.statusCode).toBe(409);
    expect(await countAudit()).toBe(beforeAudit + 1);

    const toAllow = await policies(managerId, {
      action: 'document-download',
      documentId,
      policy: 'allow',
      expectedDocumentRevision: await documentRevision(documentId),
    });
    expect(toAllow.statusCode).toBe(200);
    expect(await countAudit()).toBe(beforeAudit + 2);

    const noopAllow = await policies(managerId, {
      action: 'document-download',
      documentId,
      policy: 'allow',
      expectedDocumentRevision: await documentRevision(documentId),
    });
    expect(noopAllow.statusCode).toBe(409);
    expect(await countAudit()).toBe(beforeAudit + 2);

    const toNull = await policies(managerId, {
      action: 'document-download',
      documentId,
      policy: null,
      expectedDocumentRevision: await documentRevision(documentId),
    });
    expect(toNull.statusCode).toBe(200);
    expect(await countAudit()).toBe(beforeAudit + 3);
  });

  it('binds optimistic concurrency to the document revision without touching room revision', async () => {
    const roomBefore = await roomRevision(roomId);
    const docBefore = await documentRevision(documentId);

    const staleRefusal = await policies(managerId, {
      action: 'document-download',
      documentId,
      policy: 'allow',
      expectedDocumentRevision: docBefore - 1,
    });
    expect(staleRefusal.statusCode).toBe(409);

    const success = await policies(managerId, {
      action: 'document-download',
      documentId,
      policy: 'allow',
      expectedDocumentRevision: docBefore,
    });
    expect(success.statusCode).toBe(200);
    expect(await documentRevision(documentId)).toBe(docBefore + 1);
    expect(await roomRevision(roomId)).toBe(roomBefore);

    await policies(managerId, {
      action: 'document-download',
      documentId,
      policy: null,
      expectedDocumentRevision: docBefore + 1,
    });
  });

  it('gives the same refusal for a nonexistent document as for one in another room', async () => {
    const unknownDoc = createOpaqueId();
    const otherRoomRefusal = await policies(managerId, {
      action: 'document-download',
      documentId: otherDocumentId,
      policy: 'allow',
      expectedDocumentRevision: await documentRevision(otherDocumentId),
    });
    expect(otherRoomRefusal.statusCode).toBe(403);

    const unknownDocRefusal = await policies(managerId, {
      action: 'document-download',
      documentId: unknownDoc,
      policy: 'allow',
      expectedDocumentRevision: 1,
    });
    expect(unknownDocRefusal.statusCode).toBe(403);
    expect(otherRoomRefusal.json()).toStrictEqual(unknownDocRefusal.json());

    const ownerUnknown = await policies(ownerId, {
      action: 'document-download',
      documentId: unknownDoc,
      policy: 'allow',
      expectedDocumentRevision: 1,
    });
    expect(ownerUnknown.statusCode).toBe(403);
  });
});
