/**
 * The default instant new grants inherit when a grant names none.
 *
 * The review echoes the caller's own instant, so unlike publication or ownership transfer
 * there is nothing here the caller could not already compute; the phrase confirms the act and
 * `expectedRoomRevision` refuses a room that moved.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeRoutePools, migrationPool } from './support/route-fixture.ts';
import { roomRevision } from './support/room-fixture.ts';
import { policies, seedPolicyFixture, type PolicyFixture } from './support/policy-fixture.ts';

let fixture: PolicyFixture;
let managerId: string;
let contributorId: string;
let roomId: string;

beforeAll(async () => {
  fixture = await seedPolicyFixture('Room default-expiry');
  ({ managerId, contributorId, roomId } = fixture);
});

afterAll(closeRoutePools);

describe('default grant expiry', () => {
  const inAYear = () => new Date(Date.now() + 365 * 86_400_000).toISOString();

  it('reviews the exact inherited instant, then applies it with the phrase', async () => {
    const expiresAt = inAYear();
    const review = await policies(managerId, {
      action: 'default-expiry-dry-run',
      roomId,
      expiresAt,
    });
    expect(review.statusCode).toBe(200);
    const { impact } = review.json<{
      impact: { confirmation: string; resolvedExpiresAt: string };
    }>();
    expect(impact.confirmation).toBe('CHANGE DEFAULT EXPIRY FOR 1 ROOM');
    expect(new Date(impact.resolvedExpiresAt).toISOString()).toBe(expiresAt);

    const before = await roomRevision(roomId);
    const applied = await policies(managerId, {
      action: 'default-expiry-apply',
      roomId,
      expiresAt,
      expectedRoomRevision: before,
      confirmation: impact.confirmation,
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json<{ impact: { roomRevision: number } }>().impact.roomRevision).toBe(
      before + 1,
    );
  });

  it('refuses a past instant and a Contributor', async () => {
    expect(
      (
        await policies(managerId, {
          action: 'default-expiry-dry-run',
          roomId,
          expiresAt: '2020-01-01T00:00:00.000Z',
        })
      ).statusCode,
    ).toBe(400);

    expect(
      (
        await policies(contributorId, {
          action: 'default-expiry-dry-run',
          roomId,
          expiresAt: inAYear(),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('decides authority before anything else for default expiry', async () => {
    const contributorPast = await policies(contributorId, {
      action: 'default-expiry-dry-run',
      roomId,
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    expect(contributorPast.statusCode).toBe(403);

    const contributorApplyStale = await policies(contributorId, {
      action: 'default-expiry-apply',
      roomId,
      expiresAt: inAYear(),
      expectedRoomRevision: (await roomRevision(roomId)) - 1,
      confirmation: 'CHANGE DEFAULT EXPIRY FOR 1 ROOM',
    });
    expect(contributorApplyStale.statusCode).toBe(403);

    const contributorApplyBadPhrase = await policies(contributorId, {
      action: 'default-expiry-apply',
      roomId,
      expiresAt: inAYear(),
      expectedRoomRevision: await roomRevision(roomId),
      confirmation: 'WRONG CONFIRMATION',
    });
    expect(contributorApplyBadPhrase.statusCode).toBe(403);
  });

  it('refuses apply with mismatched confirmation phrase or stale revision', async () => {
    const badPhrase = await policies(managerId, {
      action: 'default-expiry-apply',
      roomId,
      expiresAt: inAYear(),
      expectedRoomRevision: await roomRevision(roomId),
      confirmation: 'WRONG PHRASE',
    });
    expect(badPhrase.statusCode).toBe(400);

    const staleRev = await policies(managerId, {
      action: 'default-expiry-apply',
      roomId,
      expiresAt: inAYear(),
      expectedRoomRevision: (await roomRevision(roomId)) - 1,
      confirmation: 'CHANGE DEFAULT EXPIRY FOR 1 ROOM',
    });
    expect(staleRev.statusCode).toBe(409);
  });

  it('clears default grant expiry when null is passed', async () => {
    const review = await policies(managerId, {
      action: 'default-expiry-dry-run',
      roomId,
      expiresAt: null,
    });
    expect(review.statusCode).toBe(200);
    expect(
      review.json<{ impact: { resolvedExpiresAt: unknown } }>().impact.resolvedExpiresAt,
    ).toBeNull();

    const before = await roomRevision(roomId);
    const applied = await policies(managerId, {
      action: 'default-expiry-apply',
      roomId,
      expiresAt: null,
      expectedRoomRevision: before,
      confirmation: 'CHANGE DEFAULT EXPIRY FOR 1 ROOM',
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json<{ impact: { roomRevision: number } }>().impact.roomRevision).toBe(
      before + 1,
    );

    const inDb = (
      await migrationPool.query<{ default_grant_expires_at: unknown }>(
        'SELECT default_grant_expires_at FROM room WHERE id=$1',
        [roomId],
      )
    ).rows[0]?.default_grant_expires_at;
    expect(inDb).toBeNull();
  });

  /*
   * WHAT THE PHRASE CONFIRMS: the act, not the value.
   *
   * `CHANGE DEFAULT EXPIRY FOR 1 ROOM` is a constant, and the apply recomputes the impact from
   * its OWN `expiresAt`, so a phrase obtained by reviewing one instant applies another. That
   * is sound here and asserted rather than left implicit, because this review discloses
   * nothing the caller did not supply — it echoes their own instant back. Where a review
   * counts consequences the caller cannot see, the apply is bound to a server-issued preview
   * instead: `transfer-apply` carries a `previewId` and publication carries a revision pair.
   *
   * What IS stored and audited is always the instant the apply carried, never the reviewed
   * one, so the evidence cannot disagree with the room.
   */
  it('confirms the act rather than the instant, and records what was applied', async () => {
    const reviewed = new Date(Date.now() + 30 * 86_400_000);
    const applied = new Date(Date.now() + 900 * 86_400_000);
    const review = await policies(managerId, {
      action: 'default-expiry-dry-run',
      roomId,
      expiresAt: reviewed.toISOString(),
    });
    const phrase = review.json<{
      impact: { confirmation: string; resolvedExpiresAt: string };
    }>().impact;
    expect(new Date(phrase.resolvedExpiresAt).getTime()).toBe(reviewed.getTime());

    const response = await policies(managerId, {
      action: 'default-expiry-apply',
      roomId,
      expiresAt: applied.toISOString(),
      expectedRoomRevision: await roomRevision(roomId),
      confirmation: phrase.confirmation,
    });
    expect(response.statusCode).toBe(200);

    const stored = (
      await migrationPool.query<{ default_grant_expires_at: Date }>(
        'SELECT default_grant_expires_at FROM room WHERE id=$1',
        [roomId],
      )
    ).rows[0]?.default_grant_expires_at;
    expect(stored?.getTime()).toBe(applied.getTime());

    const audited = (
      await migrationPool.query<{ expires: string }>(
        /* `sequence` is the append order; `id` is an opaque random string and sorting by it
           would return an arbitrary row. */
        `SELECT detail->>'expiresAt' AS expires FROM audit_event
          WHERE event_type='grant.default_expiry' AND room_id=$1
          ORDER BY sequence DESC LIMIT 1`,
        [roomId],
      )
    ).rows[0]?.expires;
    expect(new Date(audited ?? '').getTime()).toBe(applied.getTime());
  });
});
