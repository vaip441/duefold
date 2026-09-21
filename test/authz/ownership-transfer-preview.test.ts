/**
 * The preview: what it discloses, what it stores, and how long it lives.
 *
 * A preview is one-time evidence that the required dry run happened, and it deliberately
 * holds NO personal data — the rendered impact is returned to the caller, never stored, so
 * an abandoned preview cannot retain a named person's address and room access.
 *
 * What it does store is a digest of the successor's assignments, because `member.revision`
 * does not move when a `room_assignment` row changes: without it the Owner could approve one
 * set of revocations and a different set would be carried out.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  activeAssignments,
  closeAdministrationPools,
  currentRevision,
  databasePool,
  issuePreview,
  migrationPool,
  reseedOwnership,
  seedAdministrationFixture,
  workerPool,
  type AdministrationFixture,
} from './support/administration-fixture.ts';

let fixture: AdministrationFixture;
let ownerId: string;
let successorId: string;
let secondSuccessorId: string;
let firstRoomId: string;
let secondRoomId: string;
let bulkRoomIds: readonly string[];

beforeAll(async () => {
  fixture = await seedAdministrationFixture({ bulkRooms: true });
  ({ ownerId, successorId, secondSuccessorId, firstRoomId, secondRoomId, bulkRoomIds } =
    fixture);
});

afterAll(closeAdministrationPools);

describe('the ownership transfer preview', () => {
  const freshAuthentication = (): Date => new Date();

  /* Every case consumes the Owner, so each starts from the seeded arrangement rather than
     from whatever the previous case left behind. */
  beforeEach(async () => {
    await reseedOwnership(fixture);
  });

  it('refuses an apply that never previewed, even with the correct phrase', async () => {
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        successorId,
        ownerId,
        await currentRevision(successorId),
        freshAuthentication(),
        createOpaqueId(),
        'TRANSFER OWNERSHIP',
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await migrationPool.query<{ global_role: string }>(
          'SELECT global_role FROM member WHERE id=$1',
          [ownerId],
        )
      ).rows[0]?.global_role,
    ).toBe('owner');
  });

  it('spends a preview exactly once', async () => {
    const preview = await issuePreview({ targetId: successorId, actorId: ownerId });
    const apply = (): Promise<unknown> =>
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        successorId,
        ownerId,
        preview.expectedRevision,
        freshAuthentication(),
        preview.previewId,
        preview.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ]);
    await apply();
    await expect(apply()).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await migrationPool.query<{ consumed: boolean }>(
          'SELECT consumed_at IS NOT NULL AS consumed FROM ownership_transfer_preview WHERE id=$1',
          [preview.previewId],
        )
      ).rows[0]?.consumed,
    ).toBe(true);
  });

  it('refuses a lapsed preview', async () => {
    const preview = await issuePreview({ targetId: successorId, actorId: ownerId });
    await migrationPool.query(
      `UPDATE ownership_transfer_preview
       SET created_at = statement_timestamp() - interval '30 minutes',
           expires_at = statement_timestamp() - interval '15 minutes'
       WHERE id=$1`,
      [preview.previewId],
    );
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        successorId,
        ownerId,
        preview.expectedRevision,
        freshAuthentication(),
        preview.previewId,
        preview.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a preview whose target changed after it was issued', async () => {
    const preview = await issuePreview({ targetId: secondSuccessorId, actorId: ownerId });
    await databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId,
      'admin',
      ownerId,
      preview.expectedRevision,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        secondSuccessorId,
        ownerId,
        await currentRevision(secondSuccessorId),
        freshAuthentication(),
        preview.previewId,
        preview.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '40001' });
  });

  it('keeps the preview record unreachable from every application role', async () => {
    for (const statement of [
      'SELECT * FROM ownership_transfer_preview',
      "INSERT INTO ownership_transfer_preview(id,actor_id,target_id,target_revision,target_assignment_digest,expires_at) VALUES ('x','y','z',1,repeat('0',64),statement_timestamp())",
      'DELETE FROM ownership_transfer_preview',
    ])
      await expect(databasePool.query(statement)).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps no personal data on the preview row, and sweeps consumed rows away', async () => {
    const columns = (
      await migrationPool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'ownership_transfer_preview' ORDER BY column_name`,
      )
    ).rows.map((row) => row.column_name);
    expect(columns).toStrictEqual([
      'actor_id',
      'consumed_at',
      'created_at',
      'expires_at',
      'id',
      'target_assignment_digest',
      'target_id',
      'target_revision',
    ]);

    await workerPool.query('SELECT purge_ownership_transfer_previews()');
    const preview = createOpaqueId();
    await databasePool.query('SELECT dry_run_ownership_transfer($1,$2,$3)', [
      preview,
      successorId,
      ownerId,
    ]);
    expect(
      (await workerPool.query<{ n: number }>('SELECT purge_ownership_transfer_previews() n'))
        .rows[0]?.n,
    ).toBe(0);
    await migrationPool.query(
      'UPDATE ownership_transfer_preview SET consumed_at = statement_timestamp() WHERE id = $1',
      [preview],
    );
    expect(
      (await workerPool.query<{ n: number }>('SELECT purge_ownership_transfer_previews() n'))
        .rows[0]?.n,
    ).toBe(1);
    await expect(
      databasePool.query('SELECT purge_ownership_transfer_previews()'),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('discloses the assignments the promotion will revoke, with rooms the Owner may see', async () => {
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [secondSuccessorId],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId,
      JSON.stringify([
        { roomId: firstRoomId, roomRole: 'manager' },
        { roomId: secondRoomId, roomRole: 'contributor' },
      ]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const impact = (
      await databasePool.query<{
        dry_run_ownership_transfer: {
          readonly revokedAssignmentCount: number;
          readonly revokedAssignments: readonly {
            readonly roomId: string;
            readonly roomTitle: string;
            readonly roomRole: string;
          }[];
          readonly revokedAssignmentsTruncated: boolean;
        };
      }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [
        createOpaqueId(),
        secondSuccessorId,
        ownerId,
      ])
    ).rows[0]?.dry_run_ownership_transfer;
    expect(impact?.revokedAssignmentCount).toBe(2);
    expect(impact?.revokedAssignmentsTruncated).toBe(false);
    expect(impact?.revokedAssignments).toEqual([
      {
        roomId: firstRoomId,
        roomTitle: 'First assignment room',
        roomRole: 'manager',
      },
      {
        roomId: secondRoomId,
        roomTitle: 'Second assignment room',
        roomRole: 'contributor',
      },
    ]);
  });

  it('reports an empty, non-truncated impact for an unassigned successor', async () => {
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [successorId]);
    const impact = (
      await databasePool.query<{
        dry_run_ownership_transfer: {
          readonly revokedAssignmentCount: number;
          readonly revokedAssignments: readonly unknown[];
          readonly revokedAssignmentsTruncated: boolean;
        };
      }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [
        createOpaqueId(),
        successorId,
        ownerId,
      ])
    ).rows[0]?.dry_run_ownership_transfer;
    expect(impact).toMatchObject({
      revokedAssignmentCount: 0,
      revokedAssignments: [],
      revokedAssignmentsTruncated: false,
    });
  });

  it('bounds the named rooms while keeping the count exact', async () => {
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [secondSuccessorId],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
    for (let offset = 0; offset < bulkRoomIds.length; offset += 100)
      await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
        secondSuccessorId,
        JSON.stringify(
          bulkRoomIds
            .slice(offset, offset + 100)
            .map((roomId) => ({ roomId, roomRole: 'contributor' })),
        ),
        JSON.stringify([]),
        ownerId,
        createOpaqueId(),
        createCorrelationId(),
      ]);
    const impact = (
      await databasePool.query<{
        dry_run_ownership_transfer: {
          readonly revokedAssignmentCount: number;
          readonly revokedAssignments: readonly { readonly roomTitle: string }[];
          readonly revokedAssignmentsTruncated: boolean;
        };
      }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [
        createOpaqueId(),
        secondSuccessorId,
        ownerId,
      ])
    ).rows[0]?.dry_run_ownership_transfer;
    expect(impact?.revokedAssignmentCount).toBe(bulkRoomIds.length);
    expect(impact?.revokedAssignments).toHaveLength(100);
    expect(impact?.revokedAssignmentsTruncated).toBe(true);
    expect(impact?.revokedAssignments[0]?.roomTitle).toBe('Bulk room 000');
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
  });

  it('cannot disclose one assignment set while storing another\u2019s digest', async () => {
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [secondSuccessorId],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId,
      JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);

    const previewId = createOpaqueId();
    const inFlightPreview = databasePool
      .query<{
        dry_run_ownership_transfer: {
          readonly revokedAssignmentCount: number;
          readonly revokedAssignments: readonly { readonly roomId: string }[];
        };
      }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [previewId, secondSuccessorId, ownerId])
      .then(({ rows }) => rows[0]?.dry_run_ownership_transfer);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId,
      JSON.stringify([{ roomId: secondRoomId, roomRole: 'contributor' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const disclosed = await inFlightPreview;
    expect(await activeAssignments(secondSuccessorId)).toHaveLength(2);

    const stored = (
      await migrationPool.query<{
        target_assignment_digest: string;
        target_revision: number;
      }>(
        `SELECT target_assignment_digest,target_revision
           FROM ownership_transfer_preview WHERE id=$1`,
        [previewId],
      )
    ).rows[0];
    if (stored === undefined) throw new Error('preview row missing');
    if (disclosed === undefined) throw new Error('preview disclosure missing');
    const disclosedRooms = disclosed.revokedAssignments.map(({ roomId }) => roomId);
    const digestOfDisclosed = (
      await migrationPool.query<{ digest: string }>(
        `SELECT encode(sha256(convert_to(coalesce(string_agg(
             a.id || ':' || a.room_id || ':' || a.room_role, E'\\n' ORDER BY a.room_id), ''),
           'UTF8')),'hex') AS digest
         FROM room_assignment a
         WHERE a.member_id=$1 AND a.state='active' AND a.room_id = ANY($2)`,
        [secondSuccessorId, disclosedRooms],
      )
    ).rows[0]?.digest;
    expect(stored.target_assignment_digest).toBe(digestOfDisclosed);

    if (disclosed.revokedAssignmentCount === 1) {
      await expect(
        databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          secondSuccessorId,
          ownerId,
          stored.target_revision,
          freshAuthentication(),
          previewId,
          'TRANSFER OWNERSHIP',
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '40001' });
      expect(await activeAssignments(secondSuccessorId)).toHaveLength(2);
      expect(
        (
          await migrationPool.query<{ global_role: string }>(
            'SELECT global_role FROM member WHERE id=$1',
            [ownerId],
          )
        ).rows[0]?.global_role,
      ).toBe('owner');
    }
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
  });
});
