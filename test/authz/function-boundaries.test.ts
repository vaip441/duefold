/**
 * Which credential may execute which function, and what the audit spine records.
 *
 * The grants are the boundary. A function reachable by the wrong role is an escalation
 * regardless of the checks inside it, so these assert `has_function_privilege` directly
 * rather than inferring the grant from a refusal.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { SECURITY_EVENT_TYPES } from '../../modules/core-security/src/audit.ts';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import {
  authPool,
  closeAdministrationPools,
  databasePool,
  migrationPool,
  seedAdministrationFixture,
  type AdministrationFixture,
} from './support/administration-fixture.ts';

let fixture: AdministrationFixture;
let ownerId: string;
let plainMemberId: string;
let targetMemberId: string;
let firstRoomId: string;

beforeAll(async () => {
  fixture = await seedAdministrationFixture();
  ({ ownerId, plainMemberId, targetMemberId, firstRoomId } = fixture);
});

afterAll(closeAdministrationPools);

describe('organization administration function boundaries', () => {
  it('registers migration 017 exactly once in the generated sequence', () => {
    expect(
      generatedMigrations.filter(({ id }) => id === '017_organization_administration'),
    ).toHaveLength(1);
    expect(new Set(generatedMigrations.map(({ id }) => id)).size).toBe(
      generatedMigrations.length,
    );
  });

  /*
   * An audit row whose event type is absent from SECURITY_EVENT_TYPES is
   * unreadable through the typed audit layer, so the catalogue and the SQL that
   * writes it must not drift.
   */
  it('emits only event types the security catalogue names', async () => {
    const sources = await migrationPool.query<{ source: string }>(
      `SELECT prosrc AS source FROM pg_proc
       WHERE oid = ANY (ARRAY[
         'invite_member(text,text,text,text,text,text,text,text)',
         'revoke_member_invitation(text,text,text,text)',
         'set_member_global_role(text,text,text,integer,text,text)',
         'set_member_state(text,text,text,integer,text,text)',
         'transfer_ownership(text,text,integer,timestamptz,text,text,text,text)',
         'apply_room_assignments(text,jsonb,jsonb,text,text,text)',
         'supersede_room_assignments_for_role(text,text,text,text)'
       ]::regprocedure[])`,
    );
    expect(sources.rows).toHaveLength(7);
    /* Each audit insert is isolated to its own statement, then the first dotted
     * literal inside it is taken. Scanning positionally is unreliable because the
     * audit id may be an expression containing commas, and scanning the whole body
     * would pick up the job type in the queue insert. */
    const emitted = sources.rows.flatMap(({ source }) =>
      source
        .split(/INSERT INTO audit_event/giu)
        .slice(1)
        .map((statement) => {
          const type = /'([a-z][a-z0-9_]*\.[a-z0-9_.]+)'/u.exec(
            statement.slice(0, statement.indexOf(';')),
          )?.[1];
          if (type === undefined) throw new Error('audit insert without an event type');
          return type;
        }),
    );
    expect(emitted.toSorted()).toEqual([
      'invitation.created',
      'invitation.expired',
      'invitation.revoked',
      'member.role',
      'member.state',
      'ownership.transferred',
      /* Twice: apply_room_assignments writes the batch event, and
       * supersede_room_assignments_for_role writes the one that records a role change
       * clearing a member's explicit assignments. */
      'room.assignment',
      'room.assignment',
    ]);
    for (const type of emitted)
      expect(SECURITY_EVENT_TYPES, `uncatalogued event type ${type}`).toContain(type);
  });

  it('owns every function with the migration role and grants only its intended caller', async () => {
    const functions = [
      {
        signature: 'assert_organization_administrator(text)',
        runtime: false,
        worker: false,
      },
      {
        signature: 'invite_member(text,text,text,text,text,text,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'revoke_member_invitation(text,text,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'read_members(text,timestamptz,text,integer)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'cancel_member_invitation_mail(text)',
        runtime: false,
        worker: false,
      },
      {
        signature: 'read_member_invitation_mail(text,text,text,text)',
        runtime: false,
        worker: true,
      },
      {
        signature: 'set_member_global_role(text,text,text,integer,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'set_member_state(text,text,text,integer,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'dry_run_ownership_transfer(text,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'transfer_ownership(text,text,integer,timestamptz,text,text,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'apply_room_assignments(text,jsonb,jsonb,text,text,text)',
        runtime: true,
        worker: false,
      },
      {
        signature: 'member_assignment_impact(text)',
        runtime: false,
        worker: false,
      },
      {
        signature: 'supersede_room_assignments_for_role(text,text,text,text)',
        runtime: false,
        worker: false,
      },
    ] as const;
    for (const fn of functions) {
      const owner = await migrationPool.query<{ owner: string }>(
        'SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid=$1::regprocedure',
        [fn.signature],
      );
      expect(owner.rows[0]?.owner, fn.signature).toBe('duefold_migration');
      for (const [role, expected] of [
        ['duefold_runtime', fn.runtime],
        ['duefold_worker', fn.worker],
        ['duefold_authenticator', false],
      ] as const) {
        const privilege = await migrationPool.query<{ allowed: boolean }>(
          'SELECT has_function_privilege($1,$2,$3) AS allowed',
          [role, fn.signature, 'EXECUTE'],
        );
        expect(privilege.rows[0]?.allowed, `${role} EXECUTE ${fn.signature}`).toBe(expected);
      }
      const publicExecute = await migrationPool.query<{ allowed: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) acl
           WHERE p.oid=$1::regprocedure AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
         ) AS allowed`,
        [fn.signature],
      );
      expect(publicExecute.rows[0]?.allowed, `PUBLIC EXECUTE ${fn.signature}`).toBe(false);
    }
  });

  /*
   * The FINAL INSTALLED table ACLs, after every migration in the generated sequence
   * has been applied. Function EXECUTE grants alone proved nothing here: 001 granted
   * duefold_runtime full DML on room_assignment and duefold_authenticator full DML on
   * room_assignment, invitation, and member, so every audited boundary above could be
   * sidestepped with plain SQL -- a room privilege granted with no administrator check
   * and no audit row, or an invitation's intended_global_role rewritten from 'member'
   * to 'admin' before acceptance. Both defeat invariant 14.
   *
   * PostgreSQL grants are additive and 007's narrow re-grant never removed 001's
   * broad one, so this asserts the end state rather than any single migration's text.
   */
  it('leaves no application role able to mutate identity or room privilege directly', async () => {
    const matrix = [
      /* The web credential resolves room roles on every request, so it reads. It
       * writes nothing: apply_room_assignments is the only path. */
      { table: 'room_assignment', role: 'duefold_runtime', allowed: ['SELECT'] },
      { table: 'room_assignment', role: 'duefold_authenticator', allowed: ['SELECT'] },
      { table: 'room_assignment', role: 'duefold_worker', allowed: [] },
      /* Acceptance reads a pending invitation and writes only its state. It can
       * neither author an invitation nor choose the role one carries. */
      { table: 'invitation', role: 'duefold_authenticator', allowed: ['SELECT'] },
      { table: 'invitation', role: 'duefold_runtime', allowed: [] },
      { table: 'invitation', role: 'duefold_worker', allowed: [] },
      /* Role and state changes are confined to the audited functions. */
      { table: 'member', role: 'duefold_runtime', allowed: ['SELECT'] },
      { table: 'member', role: 'duefold_worker', allowed: [] },
      { table: 'ownership_transfer_preview', role: 'duefold_runtime', allowed: [] },
      { table: 'ownership_transfer_preview', role: 'duefold_authenticator', allowed: [] },
      { table: 'ownership_transfer_preview', role: 'duefold_worker', allowed: [] },
    ] as const;
    for (const { table, role, allowed } of matrix)
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const) {
        const held = (
          await migrationPool.query<{ held: boolean }>(
            'SELECT has_table_privilege($1,$2,$3) AS held',
            [role, table, privilege],
          )
        ).rows[0]?.held;
        expect(held, `${role} ${privilege} ON ${table}`).toBe(
          (allowed as readonly string[]).includes(privilege),
        );
      }

    /*
     * NO APPLICATION ROLE MAY WRITE ANY invitation COLUMN.
     *
     * Asserted per column, because a table-level UPDATE grant is not the only way to
     * reach one: `GRANT UPDATE (state)` grants exactly that column and
     * `has_table_privilege` for UPDATE still answers false.
     *
     * `intended_global_role` is the escalation-relevant column -- writing it before
     * acceptance turns an invited Member into an Admin, and acceptance then audits the
     * elevated role as though it had been authorized. `state` was granted to the
     * authenticator so the OIDC callback could mark an invitation accepted; that write
     * now happens inside `accept_member_invitation`, so no credential needs it and the
     * grant is gone. A privilege nothing uses is only an available bypass.
     */
    for (const role of ['duefold_authenticator', 'duefold_runtime', 'duefold_worker'] as const)
      for (const column of [
        'state',
        'intended_global_role',
        'email_key',
        'email_display',
        'kind',
        'expires_at',
      ] as const)
        expect(
          (
            await migrationPool.query<{ held: boolean }>(
              "SELECT has_column_privilege($1,'invitation',$2,'UPDATE') AS held",
              [role, column],
            )
          ).rows[0]?.held,
          `${role} UPDATE(invitation.${column})`,
        ).toBe(false);

    /*
     * member IS SELECT-ONLY FOR EVERY APPLICATION ROLE, INCLUDING THE AUTHENTICATOR.
     *
     * The authenticator is the credential an UNAUTHENTICATED OIDC callback runs on, so
     * DML here is the most valuable write in the installation: provisioning that chose
     * the role in TypeScript could insert an Admin or an Owner with no invitation and no
     * audit row.
     *
     * Both provisioning paths are `accept_member_invitation` and `claim_first_owner`,
     * which read the role from the audited invitation or hardcode 'owner' under a lock,
     * and write their own audit rows. No caller needs the table, so PostgreSQL enforces
     * it rather than a convention. CLI owner recovery runs on the migration role.
     */
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const)
      expect(
        (
          await migrationPool.query<{ held: boolean }>(
            'SELECT has_table_privilege($1,$2,$3) AS held',
            ['duefold_authenticator', 'member', privilege],
          )
        ).rows[0]?.held,
        `duefold_authenticator ${privilege} ON member`,
      ).toBe(false);
    /* SELECT remains: session authorization resolves the principal on every request. */
    expect(
      (
        await migrationPool.query<{ held: boolean }>(
          "SELECT has_table_privilege('duefold_authenticator','member','SELECT') AS held",
        )
      ).rows[0]?.held,
    ).toBe(true);
  });

  /*
   * The ACL assertions above describe what PostgreSQL reports. These attempt the
   * actual bypasses, so the finding is closed by behaviour and not only by catalogue
   * inspection.
   */
  it('refuses the direct bypasses those grants used to permit', async () => {
    const assignmentId = createOpaqueId();
    for (const [statement, parameters] of [
      [
        "INSERT INTO room_assignment(id,room_id,member_id,room_role) VALUES($1,$2,$3,'manager')",
        [assignmentId, firstRoomId, targetMemberId],
      ],
      ["UPDATE room_assignment SET room_role='manager' WHERE member_id=$1", [targetMemberId]],
      ['DELETE FROM room_assignment WHERE member_id=$1', [targetMemberId]],
      ["UPDATE member SET global_role='owner' WHERE id=$1", [plainMemberId]],
      ["UPDATE member SET state='disabled' WHERE id=$1", [targetMemberId]],
    ] as const)
      await expect(databasePool.query(statement, [...parameters])).rejects.toMatchObject({
        code: '42501',
      });

    /* The authenticator credential holds the invitation privileges acceptance needs.
     * It must still not be able to escalate the role an invitation will grant. */
    const invitationId = createOpaqueId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      invitationId,
      'acl.escalation@example.test',
      'ACL.Escalation@example.test',
      'member',
      ownerId,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ]);
    await expect(
      authPool.query("UPDATE invitation SET intended_global_role='admin' WHERE id=$1", [
        invitationId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      authPool.query(
        `INSERT INTO invitation(id,kind,email_key,email_display,state,expires_at,intended_global_role)
         VALUES($1,'member','acl.forged@example.test','acl.forged@example.test','pending',
                statement_timestamp()+interval '7 days','admin')`,
        [createOpaqueId()],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await migrationPool.query<{ intended_global_role: string }>(
          'SELECT intended_global_role FROM invitation WHERE id=$1',
          [invitationId],
        )
      ).rows[0]?.intended_global_role,
    ).toBe('member');
    /*
     * Acceptance's own state write is refused DIRECTLY too.
     *
     * This asserted the opposite while `GRANT UPDATE (state)` existed, on the reasoning
     * that acceptance needed it. Acceptance happens inside `accept_member_invitation`,
     * which runs as its owner, so the caller's own privileges are irrelevant -- and the
     * grant's only remaining effect was to let the credential serving an unauthenticated
     * callback mark any invitation revoked or accepted at will.
     */
    await expect(
      authPool.query("UPDATE invitation SET state='revoked' WHERE id=$1", [invitationId]),
    ).rejects.toMatchObject({ code: '42501' });
    /* And acceptance through the function still works, so the narrowing removed a bypass
       rather than the capability. */
    const accepted = await authPool.query<{ accept_member_invitation: string | null }>(
      'SELECT accept_member_invitation($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        createOpaqueId(),
        'acl.subject@example.test',
        'acl.subject@example.test',
        'https://issuer.example',
        `acl-subject-${createOpaqueId()}`,
        createOpaqueId(),
        createOpaqueId(),
        createCorrelationId(),
      ],
    );
    expect(accepted.rows[0]?.accept_member_invitation).toBeNull();
  });
});
