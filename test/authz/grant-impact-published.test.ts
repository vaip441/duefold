/**
 * Grant review against what the grantee can read: the published structure keeps content the
 * draft no longer shows until the next publication.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpaqueId } from '@duefold/shared/ids';
import {
  migrationPool,
  runtimePool,
  roomId,
  managerId,
  deniedViewerId,
  nestedFolderId,
  documentId,
  audit,
  grant,
  viewerIdentity,
  canViewerPreviewDocument,
  closeParticipantGrantPools,
  seedParticipantGrants,
} from './support/participant-grants-fixture.ts';

beforeAll(seedParticipantGrants);
afterAll(closeParticipantGrantPools);

describe('grant impact', () => {
  it('counts a published document the draft stages for removal under the granted folder', async () => {
    const entry = (
      await migrationPool.query<{
        id: string;
        revision: number;
        working_revision: number;
        display_name: string;
        order_key: string;
      }>(
        `SELECT e.id,e.revision,r.working_revision,e.display_name,e.order_key::text
         FROM working_structure_entry e JOIN room r ON r.id=e.room_id WHERE e.document_id=$1`,
        [documentId],
      )
    ).rows[0];
    if (!entry) throw new Error('WORKING_ENTRY_ABSENT');
    // Publication copies the working entry id; the staged removal then stays out of trash.
    await migrationPool.query(
      'UPDATE published_structure_entry SET entry_id=$1 WHERE room_id=$2 AND resource_id=$3',
      [entry.id, roomId, documentId],
    );
    await runtimePool.query('SELECT mutate_structure_entry($1,$2,$3,$4,true,$5,$6,$7,$8,$9)', [
      entry.id,
      nestedFolderId,
      entry.display_name,
      entry.order_key,
      managerId,
      entry.revision,
      entry.working_revision,
      ...audit(),
    ]);

    const impact = await grant({
      id: createOpaqueId(),
      granteeKind: 'viewer',
      viewerId: deniedViewerId,
      targetKind: 'folder',
      folderId: nestedFolderId,
    });

    expect(impact).toMatchObject({
      affectedCount: 3,
      confirmation: 'GRANT ACCESS TO 3 ITEMS',
      paths: [
        'Data room / Finantsid 財務',
        'Data room / Finantsid 財務 / Investor model',
        'Data room / Finantsid 財務 / Unready quarterly model',
      ],
    });
    expect(await canViewerPreviewDocument(viewerIdentity(deniedViewerId))).toBe(true);
  });
});
