/**
 * Ownership transfer under contention.
 *
 * The interesting failures are not refusals but races: two Owners transferring at once, and
 * an assignment batch landing between a preview and its apply. Each case establishes that a
 * transaction is genuinely BLOCKED before committing the other, because committing first and
 * asserting afterwards would prove only that statements run in order.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  activeAssignments,
  backendPid,
  closeAdministrationPools,
  currentRevision,
  databasePool,
  issuePreview,
  migrationPool,
  reseedOwnership,
  seedAdministrationFixture,
  waitUntilBlocked,
  type AdministrationFixture,
} from './support/administration-fixture.ts';

let fixture: AdministrationFixture;
let ownerId: string;
let successorId: string;
let secondSuccessorId: string;
let firstRoomId: string;
let secondRoomId: string;
let thirdRoomId: string;

beforeAll(async () => {
  fixture = await seedAdministrationFixture();
  ({ ownerId, successorId, secondSuccessorId, firstRoomId, secondRoomId, thirdRoomId } =
    fixture);
});

afterAll(closeAdministrationPools);

describe('ownership transfer under contention', () => {
  const freshAuthentication = (): Date => new Date();

  /* Every case consumes the Owner, so each starts from the seeded arrangement rather than
     from whatever the previous case left behind. */
  beforeEach(async () => {
    await reseedOwnership(fixture);
  });

  it('waits for an in-flight assignment batch rather than previewing around it', async () => {
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [secondSuccessorId],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);

    const previewId = createOpaqueId();
    const mutationTx = await databasePool.connect();
    const previewTx = await databasePool.connect();
    try {
      await mutationTx.query('BEGIN');
      await mutationTx.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
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

      const previewPid = await backendPid(previewTx);
      await previewTx.query('BEGIN');
      const preview = previewTx
        .query<{
          dry_run_ownership_transfer: { readonly revokedAssignmentCount: number };
        }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [
          previewId,
          secondSuccessorId,
          ownerId,
        ])
        .then(
          (result) => result.rows[0]?.dry_run_ownership_transfer,
          (error: unknown) => error,
        );
      await waitUntilBlocked(previewPid);
      await mutationTx.query('COMMIT');
      expect(await preview).toMatchObject({ revokedAssignmentCount: 2 });
      await previewTx.query('COMMIT');
    } finally {
      mutationTx.release();
      previewTx.release();
    }
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
  });

  it('refuses an apply whose successor assignments changed after the preview', async () => {
    await migrationPool.query(
      "UPDATE member SET global_role='member',state='active' WHERE id=$1",
      [secondSuccessorId],
    );
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
    for (const [label, mutate] of [
      [
        'assignment added',
        async (): Promise<void> => {
          await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
            secondSuccessorId,
            JSON.stringify([{ roomId: thirdRoomId, roomRole: 'contributor' }]),
            JSON.stringify([]),
            ownerId,
            createOpaqueId(),
            createCorrelationId(),
          ]);
        },
      ],
      [
        'assignment revoked',
        async (): Promise<void> => {
          await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
            secondSuccessorId,
            JSON.stringify([]),
            JSON.stringify([thirdRoomId]),
            ownerId,
            createOpaqueId(),
            createCorrelationId(),
          ]);
        },
      ],
    ] as const) {
      const preview = await issuePreview({ targetId: secondSuccessorId, actorId: ownerId });
      await mutate();
      expect(await currentRevision(secondSuccessorId)).toBe(preview.expectedRevision);
      await expect(
        databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          secondSuccessorId,
          ownerId,
          preview.expectedRevision,
          freshAuthentication(),
          preview.previewId,
          preview.confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ]),
        label,
      ).rejects.toMatchObject({ code: '40001' });
      expect(
        (
          await migrationPool.query<{ global_role: string }>(
            'SELECT global_role FROM member WHERE id=$1',
            [ownerId],
          )
        ).rows[0]?.global_role,
        label,
      ).toBe('owner');
    }
    const fresh = await issuePreview({ targetId: secondSuccessorId, actorId: ownerId });
    await databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
      secondSuccessorId,
      ownerId,
      fresh.expectedRevision,
      freshAuthentication(),
      fresh.previewId,
      fresh.confirmation,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(
      (
        await migrationPool.query<{ global_role: string }>(
          'SELECT global_role FROM member WHERE id=$1',
          [secondSuccessorId],
        )
      ).rows[0]?.global_role,
    ).toBe('owner');
  });

  it('rolls everything back when the assignment digest is stale', async () => {
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
    const preview = await issuePreview({ targetId: secondSuccessorId, actorId: ownerId });
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId,
      JSON.stringify([{ roomId: secondRoomId, roomRole: 'contributor' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    const correlationId = createCorrelationId();
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        secondSuccessorId,
        ownerId,
        preview.expectedRevision,
        freshAuthentication(),
        preview.previewId,
        preview.confirmation,
        createOpaqueId(),
        correlationId,
      ]),
    ).rejects.toMatchObject({ code: '40001' });
    const roles = new Map(
      (
        await migrationPool.query<{ id: string; global_role: string }>(
          'SELECT id,global_role FROM member WHERE id = ANY($1)',
          [[ownerId, secondSuccessorId]],
        )
      ).rows.map(({ id, global_role }) => [id, global_role]),
    );
    expect(roles.get(ownerId)).toBe('owner');
    expect(roles.get(secondSuccessorId)).toBe('member');
    expect(await activeAssignments(secondSuccessorId)).toHaveLength(2);
    expect(
      (
        await migrationPool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM audit_event WHERE correlation_id=$1',
          [correlationId],
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await migrationPool.query<{ consumed_at: Date | null }>(
          'SELECT consumed_at FROM ownership_transfer_preview WHERE id=$1',
          [preview.previewId],
        )
      ).rows[0]?.consumed_at,
    ).toBeNull();
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
  });

  it('lets exactly one of two simultaneous transfers succeed', async () => {
    const first = await databasePool.connect();
    const second = await databasePool.connect();
    const successorRevision = await currentRevision(successorId);
    const secondRevision = await currentRevision(secondSuccessorId);
    try {
      const firstPreview = await issuePreview({ targetId: successorId, actorId: ownerId });
      const secondPreview = await issuePreview({
        targetId: secondSuccessorId,
        actorId: ownerId,
      });
      const secondPid = await backendPid(second);
      await first.query('BEGIN');
      await second.query('BEGIN');
      await first.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        successorId,
        ownerId,
        successorRevision,
        freshAuthentication(),
        firstPreview.previewId,
        firstPreview.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ]);
      const blocked = second
        .query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          secondSuccessorId,
          ownerId,
          secondRevision,
          freshAuthentication(),
          secondPreview.previewId,
          secondPreview.confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ])
        .then(
          () => null,
          (error: unknown) => error,
        );
      await waitUntilBlocked(secondPid);
      await first.query('COMMIT');
      expect(await blocked).toMatchObject({ code: '42501' });
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
    expect(
      (
        await migrationPool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM member WHERE global_role='owner' AND state='active'",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
});
