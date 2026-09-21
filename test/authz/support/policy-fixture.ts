/**
 * Seeding for the policy, expiry and counterparty suites: one room with a Manager and a
 * Contributor, a second room nobody is staffed into, a document in each, and a viewer.
 *
 * The second room and its document exist so a refusal about something in another room can be
 * compared against a refusal about something that does not exist; they must be
 * indistinguishable.
 */
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { app, databasePool, headers, memberSession, migrationPool } from './route-fixture.ts';
import {
  resetRoomSchema,
  seedMember,
  seedRoom,
  seedViewerWithRoomGrant,
  staffRoom,
} from './room-fixture.ts';

export interface PolicyFixture {
  readonly ownerId: string;
  readonly managerId: string;
  readonly contributorId: string;
  readonly plainMemberId: string;
  readonly roomId: string;
  readonly otherRoomId: string;
  readonly documentId: string;
  readonly otherDocumentId: string;
  readonly viewerId: string;
}

export async function seedPolicyFixture(organizationName: string): Promise<PolicyFixture> {
  const ownerId = await resetRoomSchema(organizationName);
  const managerId = await seedMember('member', 'policy.manager');
  const contributorId = await seedMember('member', 'policy.contributor');
  const plainMemberId = await seedMember('member', 'policy.plain');
  const roomId = await seedRoom(ownerId, 'Policy room');
  const otherRoomId = await seedRoom(ownerId, 'Other policy room');
  await staffRoom(managerId, roomId, 'manager', ownerId);
  await staffRoom(contributorId, roomId, 'contributor', ownerId);

  const documentId = createOpaqueId();
  await migrationPool.query(
    'INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,$3,$4)',
    [documentId, roomId, 'Information memorandum', managerId],
  );
  await databasePool.query('SELECT create_document_entry($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
    createOpaqueId(),
    documentId,
    null,
    'Information memorandum',
    1,
    managerId,
    (
      await migrationPool.query<{ working_revision: number }>(
        'SELECT working_revision FROM room WHERE id=$1',
        [roomId],
      )
    ).rows[0]?.working_revision,
    createOpaqueId(),
    createCorrelationId(),
  ]);

  const otherDocumentId = createOpaqueId();
  await migrationPool.query(
    'INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,$3,$4)',
    [otherDocumentId, otherRoomId, 'Other memorandum', ownerId],
  );
  await databasePool.query('SELECT create_document_entry($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
    createOpaqueId(),
    otherDocumentId,
    null,
    'Other memorandum',
    1,
    ownerId,
    (
      await migrationPool.query<{ working_revision: number }>(
        'SELECT working_revision FROM room WHERE id=$1',
        [otherRoomId],
      )
    ).rows[0]?.working_revision,
    createOpaqueId(),
    createCorrelationId(),
  ]);

  const viewerId = await seedViewerWithRoomGrant(roomId, managerId, 'counterparty.viewer');
  return {
    ownerId,
    managerId,
    contributorId,
    plainMemberId,
    roomId,
    otherRoomId,
    documentId,
    otherDocumentId,
    viewerId,
  };
}

export async function policies(
  memberId: string,
  payload: Record<string, unknown>,
  csrf = true,
) {
  const instance = await app();
  const response = await instance.inject({
    method: 'POST',
    url: '/api/policies',
    headers: headers(await memberSession(memberId), csrf),
    payload,
  });
  await instance.close();
  return response;
}

export async function counterparties(
  memberId: string,
  payload: Record<string, unknown>,
  csrf = true,
) {
  const instance = await app();
  const response = await instance.inject({
    method: 'POST',
    url: '/api/counterparties',
    headers: headers(await memberSession(memberId), csrf),
    payload,
  });
  await instance.close();
  return response;
}

export async function roster(memberId: string, targetRoomId: string) {
  const instance = await app();
  const response = await instance.inject({
    method: 'GET',
    url: `/api/participants?roomId=${targetRoomId}`,
    headers: headers(await memberSession(memberId), false),
  });
  await instance.close();
  return response;
}

export const documentRevision = async (id: string): Promise<number> => {
  const revision = (
    await migrationPool.query<{ revision: number }>(
      'SELECT revision FROM document WHERE id=$1',
      [id],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('document missing');
  return revision;
};
