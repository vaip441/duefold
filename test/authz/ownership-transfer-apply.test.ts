/**
 * Applying an ownership transfer: what moves, what is refused, and what is audited.
 *
 * Every case here consumes the current Owner, so each reseeds ownership from the fixture
 * first. `exactly_one_owner_after_member` is deferred to COMMIT, so the demote-then-promote
 * pair is legal inside one transaction; `one_active_owner` is a partial unique index and is
 * not, which is what the ordering case proves.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  activeAssignments,
  activeSessionFor,
  closeAdministrationPools,
  currentRevision,
  databasePool,
  issuePreview,
  migrationPool,
  reseedOwnership,
  seedAdministrationFixture,
  sessionState,
  type AdministrationFixture,
} from './support/administration-fixture.ts';

let fixture: AdministrationFixture;
let ownerId: string;
let adminId: string;
let plainMemberId: string;
let disabledMemberId: string;
let successorId: string;
let secondSuccessorId: string;
let firstRoomId: string;

beforeAll(async () => {
  fixture = await seedAdministrationFixture();
  ({
    ownerId,
    adminId,
    plainMemberId,
    disabledMemberId,
    successorId,
    secondSuccessorId,
    firstRoomId,
  } = fixture);
});

afterAll(closeAdministrationPools);

describe('applying an ownership transfer', () => {
  const freshAuthentication = (): Date => new Date();

  /* Every case consumes the Owner, so each starts from the seeded arrangement rather than
     from whatever the previous case left behind. */
  beforeEach(async () => {
    await reseedOwnership(fixture);
  });

  it('previews the impact and moves ownership, demoting the outgoing Owner to admin', async () => {
    const previewId = createOpaqueId();
    const impact = (
      await databasePool.query<{
        dry_run_ownership_transfer: {
          readonly previewId: string;
          readonly targetEmailDisplay: string;
          readonly confirmation: string;
          readonly message: string;
          readonly expectedRevision: number;
        };
      }>('SELECT dry_run_ownership_transfer($1,$2,$3)', [previewId, successorId, ownerId])
    ).rows[0]?.dry_run_ownership_transfer;
    expect(impact?.confirmation).toBe('TRANSFER OWNERSHIP');
    expect(impact?.targetEmailDisplay).toBe('Successor@example.test');
    expect(impact?.message).toContain('signed out of every device');
    expect(impact?.previewId).toBe(previewId);
    expect(impact?.expectedRevision).toBe(await currentRevision(successorId));

    const auditId = createOpaqueId();
    await databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
      successorId,
      ownerId,
      impact?.expectedRevision,
      freshAuthentication(),
      previewId,
      'TRANSFER OWNERSHIP',
      auditId,
      createCorrelationId(),
    ]);
    const roles = new Map(
      (
        await migrationPool.query<{ id: string; global_role: string }>(
          'SELECT id,global_role FROM member WHERE id = ANY($1)',
          [[ownerId, successorId]],
        )
      ).rows.map(({ id, global_role }) => [id, global_role]),
    );
    expect(roles.get(successorId)).toBe('owner');
    expect(roles.get(ownerId)).toBe('admin');
    const audit = (
      await migrationPool.query<{
        event_type: string;
        reason_code: string;
        actor_id: string;
        subject_id: string;
        detail: Readonly<Record<string, unknown>>;
      }>(
        'SELECT event_type,reason_code,actor_id,subject_id,detail FROM audit_event WHERE id=$1',
        [auditId],
      )
    ).rows[0];
    expect(audit).toMatchObject({
      event_type: 'ownership.transferred',
      reason_code: 'OWNERSHIP_TRANSFERRED',
      actor_id: ownerId,
      subject_id: successorId,
    });
    expect(JSON.stringify(audit?.detail)).not.toContain('@');
  });

  it('supersedes the successor\u2019s room assignments when promoting them to Owner', async () => {
    await migrationPool.query('DELETE FROM room_assignment WHERE member_id=$1', [
      secondSuccessorId,
    ]);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId,
      JSON.stringify([{ roomId: firstRoomId, roomRole: 'contributor' }]),
      JSON.stringify([]),
      ownerId,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(await activeAssignments(secondSuccessorId)).toHaveLength(1);

    const preview = await issuePreview({ targetId: secondSuccessorId, actorId: ownerId });
    const correlationId = createCorrelationId();
    await databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
      secondSuccessorId,
      ownerId,
      preview.expectedRevision,
      freshAuthentication(),
      preview.previewId,
      preview.confirmation,
      createOpaqueId(),
      correlationId,
    ]);
    expect(
      (
        await migrationPool.query<{ global_role: string }>(
          'SELECT global_role FROM member WHERE id=$1',
          [secondSuccessorId],
        )
      ).rows[0]?.global_role,
    ).toBe('owner');
    expect(await activeAssignments(secondSuccessorId)).toEqual([]);
    const events = (
      await migrationPool.query<{ event_type: string; reason_code: string }>(
        `SELECT event_type,reason_code FROM audit_event
          WHERE correlation_id=$1 ORDER BY event_type`,
        [correlationId],
      )
    ).rows;
    expect(events).toEqual([
      { event_type: 'ownership.transferred', reason_code: 'OWNERSHIP_TRANSFERRED' },
      { event_type: 'room.assignment', reason_code: 'ROOM_ASSIGNMENTS_SUPERSEDED' },
    ]);
  });

  it('revokes both members\u2019 sessions because both privilege rows changed', async () => {
    const ownerSession = await activeSessionFor(ownerId);
    const successorSession = await activeSessionFor(successorId);
    const preview = await issuePreview({ targetId: successorId, actorId: ownerId });
    await databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
      successorId,
      ownerId,
      preview.expectedRevision,
      freshAuthentication(),
      preview.previewId,
      preview.confirmation,
      createOpaqueId(),
      createCorrelationId(),
    ]);
    expect(await sessionState(ownerSession)).toBe('revoked');
    expect(await sessionState(successorSession)).toBe('revoked');
  });

  it('names the Owner-only refusal before the freshness one, not after', async () => {
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        successorId,
        adminId,
        await currentRevision(successorId),
        new Date(Date.now() - 30 * 60_000),
        createOpaqueId(),
        'TRANSFER OWNERSHIP',
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('Owner-only') as unknown });
  });

  it('refuses a mismatched confirmation, including a case variant', async () => {
    for (const confirmation of ['transfer ownership', 'TRANSFER  OWNERSHIP', '']) {
      const preview = await issuePreview({ targetId: successorId, actorId: ownerId });
      await expect(
        databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          successorId,
          ownerId,
          preview.expectedRevision,
          freshAuthentication(),
          preview.previewId,
          confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '22023' });
    }
    expect(
      (
        await migrationPool.query<{ global_role: string }>(
          'SELECT global_role FROM member WHERE id=$1',
          [ownerId],
        )
      ).rows[0]?.global_role,
    ).toBe('owner');
  });

  it('refuses an absent, future, or stale authentication instant', async () => {
    for (const authenticatedAt of [
      null,
      new Date(Date.now() + 60_000),
      new Date(Date.now() - 16 * 60_000),
    ]) {
      const preview = await issuePreview({ targetId: successorId, actorId: ownerId });
      await expect(
        databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          successorId,
          ownerId,
          preview.expectedRevision,
          authenticatedAt,
          preview.previewId,
          preview.confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toThrow('fresh OIDC required');
    }
  });

  it('refuses an Admin who is not the Owner, and a plain member', async () => {
    const ownerPreview = await issuePreview({ targetId: secondSuccessorId, actorId: ownerId });
    for (const actor of [successorId, plainMemberId]) {
      await expect(
        databasePool.query('SELECT dry_run_ownership_transfer($1,$2,$3)', [
          createOpaqueId(),
          secondSuccessorId,
          actor,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          secondSuccessorId,
          actor,
          ownerPreview.expectedRevision,
          freshAuthentication(),
          ownerPreview.previewId,
          ownerPreview.confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('refuses a disabled target, the Owner themselves, and an unknown member', async () => {
    const otherPreview = await issuePreview({ targetId: successorId, actorId: ownerId });
    for (const target of [disabledMemberId, ownerId, createOpaqueId()]) {
      await expect(
        databasePool.query('SELECT dry_run_ownership_transfer($1,$2,$3)', [
          createOpaqueId(),
          target,
          ownerId,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
          target,
          ownerId,
          otherPreview.expectedRevision,
          freshAuthentication(),
          otherPreview.previewId,
          otherPreview.confirmation,
          createOpaqueId(),
          createCorrelationId(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('rejects a stale target revision', async () => {
    const preview = await issuePreview({ targetId: successorId, actorId: ownerId });
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6,$7,$8)', [
        successorId,
        ownerId,
        preview.expectedRevision + 5,
        freshAuthentication(),
        preview.previewId,
        preview.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '40001' });
  });

  it('rolls the whole transfer back when audit persistence fails', async () => {
    await migrationPool.query(`CREATE FUNCTION fail_transfer_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='ownership.transferred' THEN RAISE EXCEPTION 'injected transfer audit failure'; END IF;
        RETURN NEW;
      END $$`);
    await migrationPool.query(
      'CREATE TRIGGER fail_transfer_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_transfer_audit()',
    );
    try {
      const preview = await issuePreview({ targetId: successorId, actorId: ownerId });
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
      ).rejects.toThrow('injected transfer audit failure');
      const roles = new Map(
        (
          await migrationPool.query<{ id: string; global_role: string }>(
            'SELECT id,global_role FROM member WHERE id = ANY($1)',
            [[ownerId, successorId]],
          )
        ).rows.map(({ id, global_role }) => [id, global_role]),
      );
      expect(roles.get(ownerId)).toBe('owner');
      expect(roles.get(successorId)).toBe('admin');
    } finally {
      await migrationPool.query('DROP TRIGGER fail_transfer_audit ON audit_event');
      await migrationPool.query('DROP FUNCTION fail_transfer_audit()');
    }
  });

  it('cannot hold two active owners even momentarily', async () => {
    await expect(
      migrationPool.query("UPDATE member SET global_role='owner' WHERE id=$1", [successorId]),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
