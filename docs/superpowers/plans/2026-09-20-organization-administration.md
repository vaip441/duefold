# Organization Administration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it possible to invite, role, staff, disable and replace internal members through the product, so a room created in Duefold can actually be worked by more than one person.

**Architecture:** Every mutation is a `SECURITY DEFINER` PostgreSQL function that authorizes the actor itself and writes its audit row in the same transaction; HTTP routes are thin, declared `audience: 'member'`, and let PostgreSQL decide Owner/Admin. The browser gains a Members surface, and section tabs stop being a hardcoded array so an omitted module's panel cannot reach the bundle.

**Tech Stack:** Node 26.5.0, TypeScript 5.9.3, Fastify, PostgreSQL (plpgsql `SECURITY DEFINER`), TypeBox schemas, Kysely (reads), React 19, Vite 8, Vitest 5, Playwright 1.63.

**Spec:** `docs/superpowers/specs/2026-09-20-room-admin-surface-design.md` (milestone 1 of 3)

## Global Constraints

- Node is pinned to **26.5.0**; npm `>=11.0.0`. Do not add a dependency — every library this plan needs is already in `package.json`.
- Migrations are **one global sequence across all four modules** and are **immutable once applied**. The next free number is `017`. During development re-run `npm run db:reset` rather than editing an applied migration.
- Every new PostgreSQL function is `LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp`, is `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO duefold_runtime`, and `ALTER FUNCTION ... OWNER TO duefold_migration`. Copy the footer style of `modules/rooms-documents/migrations/004_room_structure.sql:495`.
- **Invariant 14:** the mutation and its `audit_event` insert commit in one transaction, inside the function. Never audit from TypeScript.
- **Invariant 4:** routes are `audience: 'member'`; role checks live in SQL. Never branch on role in a route handler.
- All user-visible strings go through `translate()` with a key in `apps/web-client/src/i18n/en.ts`. No literal copy in components.
- Telemetry and audit `detail` must not contain full emails, tokens, object keys or raw IPs (§20.3).
- **Running tests on this machine:** check `free -h` first; the full `npm run verify` has OOM'd WSL before. Run steps singly and cap workers: `npx vitest run --project unit --maxWorkers=2`.
- Integration and authz projects need PostgreSQL with the four roles. `npm run test:authz` and `npm run test:integration` both run `npm run compose` first.

---

### Task 1: Migration 017 — invitation role, `invite_member`, `revoke_member_invitation`, `read_members`

**Files:**
- Create: `modules/core-security/migrations/017_organization_administration.sql`
- Modify: `modules/core-security/src/declaration.ts` (migrations array, ~line 98)
- Test: `test/authz/organization-administration.test.ts`

**Interfaces:**
- Consumes: `canonical_email_key(text)`, `member`, `invitation`, `audit_event`, `job_queue` from `001_security_kernel.sql`.
- Produces:
  - `invite_member(p_id text, p_email_key text, p_email_display text, p_intended_role text, p_actor_id text, p_job_id text, p_audit_id text, p_correlation_id text) RETURNS timestamptz` — returns the invitation expiry.
  - `revoke_member_invitation(p_invitation_id text, p_actor_id text, p_audit_id text, p_correlation_id text) RETURNS void`
  - `read_members(p_actor_id text) RETURNS TABLE(subject_kind text, subject_id text, email_display text, global_role text, state text, revision integer, created_at timestamptz)` — `subject_kind` is `'member'` or `'invitation'`.

- [x] **Step 1: Write the failing test**

Create `test/authz/organization-administration.test.ts`. Copy the pool and migration
bootstrap block verbatim from `test/authz/security-routes.test.ts:38-70` (five pools,
`migrate`, `testWebRuntime`), then add:

```ts
describe('invite_member', () => {
  it('admits an Owner and records the intended role', async () => {
    const invitationId = createOpaqueId();
    const expiry = await databasePool.query<{ invite_member: Date }>(
      'SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)',
      [invitationId, 'new.admin@example.test', 'New.Admin@example.test', 'admin',
       ownerId, createOpaqueId(), createOpaqueId(), createCorrelationId()],
    );
    expect(expiry.rows[0]?.invite_member).toBeInstanceOf(Date);

    const row = await migrationPool.query<{ intended_global_role: string; state: string }>(
      'SELECT intended_global_role,state FROM invitation WHERE id=$1',
      [invitationId],
    );
    expect(row.rows[0]).toEqual({ intended_global_role: 'admin', state: 'pending' });
  });

  it('refuses a plain member', async () => {
    await expect(
      databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
        createOpaqueId(), 'nope@example.test', 'nope@example.test', 'member',
        plainMemberId, createOpaqueId(), createOpaqueId(), createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses an email already held by an active member', async () => {
    await expect(
      databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
        createOpaqueId(), ownerEmailKey, ownerEmailKey, 'member',
        ownerId, createOpaqueId(), createOpaqueId(), createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('writes the audit row in the same transaction', async () => {
    const invitationId = createOpaqueId();
    const auditId = createOpaqueId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      invitationId, 'audited@example.test', 'audited@example.test', 'member',
      ownerId, createOpaqueId(), auditId, createCorrelationId(),
    ]);
    const audit = await migrationPool.query<{ event_type: string; reason_code: string }>(
      'SELECT event_type,reason_code FROM audit_event WHERE id=$1', [auditId],
    );
    expect(audit.rows[0]).toEqual({
      event_type: 'invitation.created', reason_code: 'MEMBER_INVITED',
    });
  });

  it('enqueues exactly one onboarding mail job', async () => {
    const invitationId = createOpaqueId();
    const jobId = createOpaqueId();
    await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
      invitationId, 'mailed@example.test', 'mailed@example.test', 'member',
      ownerId, jobId, createOpaqueId(), createCorrelationId(),
    ]);
    const job = await migrationPool.query<{ job_type: string; idempotency_key: string }>(
      'SELECT job_type,idempotency_key FROM job_queue WHERE id=$1', [jobId],
    );
    expect(job.rows[0]).toEqual({
      job_type: 'mail.member_invitation',
      idempotency_key: `member-invitation:${invitationId}`,
    });
  });
});

describe('read_members', () => {
  it('returns members and pending invitations, and refuses a plain member', async () => {
    const rows = await databasePool.query<{ subject_kind: string }>(
      'SELECT subject_kind FROM read_members($1)', [ownerId],
    );
    expect(rows.rows.some((r) => r.subject_kind === 'member')).toBe(true);
    expect(rows.rows.some((r) => r.subject_kind === 'invitation')).toBe(true);
    await expect(
      databasePool.query('SELECT * FROM read_members($1)', [plainMemberId]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
free -h
npm run test:authz -- organization-administration
```

Expected: FAIL with `function invite_member(...) does not exist`.

- [x] **Step 3: Write migration 017**

Create `modules/core-security/migrations/017_organization_administration.sql`:

```sql
-- Duefold organization administration. This migration is immutable after application.
--
-- Member invitation carries the role the invitee will receive, so an Admin is
-- invited as an Admin rather than invited, accepted as a member, then promoted.
-- Acceptance reads this column; see modules/core-security/src/auth/oidc.ts.
ALTER TABLE invitation
  ADD COLUMN intended_global_role text
    CHECK (intended_global_role IS NULL OR intended_global_role IN ('admin','member')),
  ADD COLUMN invited_by text REFERENCES member(id),
  ADD CONSTRAINT invitation_role_matches_kind CHECK (
    (kind = 'member' AND intended_global_role IS NOT NULL) OR
    (kind = 'viewer' AND intended_global_role IS NULL));
UPDATE invitation SET intended_global_role = 'member' WHERE kind = 'member';

-- An active member's address is not invitable. A partial unique index states
-- that as a constraint rather than leaving it to a race between two Admins.
CREATE UNIQUE INDEX one_pending_member_invitation
  ON invitation (email_key) WHERE kind = 'member' AND state = 'pending';

CREATE FUNCTION assert_organization_administrator(p_actor_id text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM member
                WHERE id=p_actor_id AND state='active' AND global_role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'organization administration forbidden' USING ERRCODE='42501';
  END IF;
END $$;

CREATE FUNCTION invite_member(
  p_id text,p_email_key text,p_email_display text,p_intended_role text,
  p_actor_id text,p_job_id text,p_audit_id text,p_correlation_id text
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE expiry timestamptz := statement_timestamp() + interval '7 days';
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_intended_role NOT IN ('admin','member') THEN
    RAISE EXCEPTION 'invalid intended role' USING ERRCODE='22023';
  END IF;
  IF NOT canonical_email_key(p_email_key)
     OR p_email_display IS NULL OR length(p_email_display) NOT BETWEEN 3 AND 320 THEN
    RAISE EXCEPTION 'invalid invitation email' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM member WHERE email_key=p_email_key AND state<>'disabled') THEN
    RAISE EXCEPTION 'member already exists' USING ERRCODE='23505';
  END IF;
  INSERT INTO invitation(id,kind,email_key,email_display,state,expires_at,
                         intended_global_role,invited_by)
  VALUES(p_id,'member',p_email_key,p_email_display,'pending',expiry,p_intended_role,p_actor_id);
  INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
  VALUES(p_job_id,'mail.member_invitation','member-invitation:'||p_id,
         jsonb_build_object('invitationId',p_id),statement_timestamp(),5);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,resource_type,resource_id,
                          result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'invitation.created','member',p_actor_id,'invitation',p_id,
         'success','MEMBER_INVITED',p_correlation_id,
         jsonb_build_object('intendedRole',p_intended_role,'expiresAt',expiry));
  RETURN expiry;
END $$;

CREATE FUNCTION revoke_member_invitation(
  p_invitation_id text,p_actor_id text,p_audit_id text,p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  UPDATE invitation SET state='revoked'
    WHERE id=p_invitation_id AND kind='member' AND state='pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation not pending' USING ERRCODE='40001';
  END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,resource_type,resource_id,
                          result,reason_code,correlation_id)
  VALUES(p_audit_id,'invitation.created','member',p_actor_id,'invitation',p_invitation_id,
         'success','MEMBER_INVITATION_REVOKED',p_correlation_id);
END $$;

-- member.state='invited' is unreachable: acceptance inserts 'active' directly, so an
-- invited person exists only as an invitation row. The reader unions both and marks
-- which is which, so the surface never renders an invitation as though it were a member.
CREATE FUNCTION read_members(p_actor_id text)
RETURNS TABLE(subject_kind text,subject_id text,email_display text,
              global_role text,state text,revision integer,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  RETURN QUERY
    SELECT 'member',m.id,m.email_display,m.global_role,m.state,m.revision,m.created_at
      FROM member m
    UNION ALL
    SELECT 'invitation',i.id,i.email_display,i.intended_global_role,i.state,1,i.created_at
      FROM invitation i
     WHERE i.kind='member' AND i.state='pending' AND i.expires_at>statement_timestamp()
    ORDER BY 7 DESC;
END $$;

REVOKE ALL ON FUNCTION assert_organization_administrator(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION invite_member(text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_member_invitation(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_members(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_member(text,text,text,text,text,text,text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION revoke_member_invitation(text,text,text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION read_members(text) TO duefold_runtime;
ALTER FUNCTION assert_organization_administrator(text) OWNER TO duefold_migration;
ALTER FUNCTION invite_member(text,text,text,text,text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION revoke_member_invitation(text,text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_members(text) OWNER TO duefold_migration;
```

- [x] **Step 4: Register the migration**

In `modules/core-security/src/declaration.ts`, change the `migrations` array to:

```ts
  migrations: [
    { id: '001_security_kernel', file: '001_security_kernel.sql' },
    { id: '017_organization_administration', file: '017_organization_administration.sql' },
  ],
```

- [x] **Step 5: Run the test to verify it passes**

```bash
npm run db:reset && npm run test:authz -- organization-administration
```

Expected: PASS, all six assertions.

- [x] **Step 6: Commit**

```bash
git add modules/core-security/migrations/017_organization_administration.sql \
        modules/core-security/src/declaration.ts \
        test/authz/organization-administration.test.ts
git commit -m "Invite internal members with the role they will hold"
```

---

### Task 2: Member invitation mail

**Files:**
- Create: `modules/core-security/src/jobs/member-invitation-mail.ts`
- Modify: `modules/core-security/migrations/017_organization_administration.sql` (append the reader — only valid because 017 is not yet applied anywhere real; if it has been applied, add `018_member_invitation_mail.sql` instead)
- Modify: `modules/core-security/src/declaration.ts` (jobs array, ~line 99)
- Test: `test/integration/member-invitation-mail.test.ts`

**Interfaces:**
- Consumes: `invite_member` (Task 1); `RequiredMailer.deliverOnboarding` from `modules/core-security/src/auth/mail.ts:32`; `JobContext`, `LeasedJob` from `apps/worker/src/runner.ts`.
- Produces: `read_member_invitation_mail(p_invitation_id text, p_job_id text, p_owner text, p_token text) RETURNS TABLE(email_display text, occurred_at timestamptz)`; job type `mail.member_invitation`.

`deliverOnboarding` is already implemented in both the SMTP and Resend transports
(`modules/core-security/src/auth/mail.ts:190`) and `'internal-onboarding'` is already a
`REQUIRED_MAIL_EVENT_CLASS`. Nothing has ever called it. Do not add a transport method.

- [x] **Step 1: Write the failing test**

Create `test/integration/member-invitation-mail.test.ts`:

```ts
it('delivers onboarding mail for a pending member invitation under a valid lease', async () => {
  const invitationId = createOpaqueId();
  const jobId = createOpaqueId();
  await databasePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
    invitationId, 'onboard@example.test', 'Onboard@example.test', 'member',
    ownerId, jobId, createOpaqueId(), createCorrelationId(),
  ]);

  const delivered: { emailDisplay: string; authenticatedLink: string }[] = [];
  const handler = createMemberInvitationMailHandler({
    pool: workerPool,
    publicUrl: 'https://rooms.example.test',
    mailer: {
      deliver: () => Promise.resolve(),
      deliverInvitation: () => Promise.reject(new Error('WRONG_TEMPLATE')),
      deliverOnboarding: (message) => {
        delivered.push({
          emailDisplay: message.emailDisplay,
          authenticatedLink: message.authenticatedLink,
        });
        return Promise.resolve();
      },
      deliverSecurityNotice: () => Promise.resolve(),
      close: () => undefined,
    },
  });
  const runner = new JobRunner(workerPool, new Map([['mail.member_invitation', handler]]));
  await runner.runOne();

  expect(delivered).toEqual([
    { emailDisplay: 'Onboard@example.test', authenticatedLink: 'https://rooms.example.test/' },
  ]);
});

it('refuses to read the mail projection without the job lease', async () => {
  const rows = await workerPool.query(
    'SELECT * FROM read_member_invitation_mail($1,$2,$3,$4)',
    [createOpaqueId(), createOpaqueId(), 'not-the-owner', createOpaqueId()],
  );
  expect(rows.rows).toHaveLength(0);
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
npm run test:integration -- member-invitation-mail
```

Expected: FAIL — `createMemberInvitationMailHandler` is not exported.

- [x] **Step 3: Append the SQL reader to migration 017**

The projection is lease-gated exactly like `read_viewer_invitation_mail`
(`modules/participants-access/migrations/007_participant_grants.sql:580`): the worker may
read an invitee's address only while holding the live lease for that specific job.

```sql
CREATE FUNCTION read_member_invitation_mail(
  p_invitation_id text,p_job_id text,p_owner text,p_token text
) RETURNS TABLE(email_display text,occurred_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT i.email_display,i.created_at
    FROM invitation i JOIN job_queue j ON j.id=p_job_id
   WHERE i.id=p_invitation_id AND i.kind='member' AND i.state='pending'
     AND i.expires_at>statement_timestamp()
     AND j.job_type='mail.member_invitation' AND j.payload->>'invitationId'=i.id
     AND j.state='running' AND j.lease_owner=p_owner AND j.lease_token=p_token
     AND j.lease_expires_at>statement_timestamp()
$$;
REVOKE ALL ON FUNCTION read_member_invitation_mail(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_member_invitation_mail(text,text,text,text) TO duefold_worker;
ALTER FUNCTION read_member_invitation_mail(text,text,text,text) OWNER TO duefold_migration;
```

- [x] **Step 4: Write the job handler**

Create `modules/core-security/src/jobs/member-invitation-mail.ts`:

```ts
import type { Pool } from 'pg';
import type { RequiredMailer } from '../auth/mail.ts';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';

/**
 * Internal onboarding mail for an invited member.
 *
 * The address is read through a lease-gated projection, never from the payload:
 * a worker that no longer holds the job's lease cannot learn who was invited.
 * The mail carries a bare authenticated link and no role, inviter, or room.
 */
export interface MemberInvitationMailDependencies {
  readonly pool: Pool;
  readonly mailer: RequiredMailer;
  readonly publicUrl: string;
}

function field(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(value))
    throw new Error('INVALID_JOB_PAYLOAD');
  return value;
}

export function createHandler(dependencies: MemberInvitationMailDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const invitationId = field(job.payload, 'invitationId');
    const mail = (
      await dependencies.pool.query<{ email_display: string; occurred_at: Date }>(
        'SELECT * FROM read_member_invitation_mail($1,$2,$3,$4)',
        [invitationId, job.id, context.leaseOwner, job.lease_token],
      )
    ).rows[0];
    if (mail === undefined) throw new Error('MEMBER_INVITATION_MAIL_FORBIDDEN');
    const base = new URL(dependencies.publicUrl);
    base.pathname = '/';
    base.search = '';
    base.hash = '';
    await dependencies.mailer.deliverOnboarding({
      emailDisplay: mail.email_display,
      authenticatedLink: base.toString(),
      occurredAt: mail.occurred_at,
    });
  };
}
```

In the test, import it as
`import { createHandler as createMemberInvitationMailHandler } from '../../modules/core-security/src/jobs/member-invitation-mail.ts';`

- [x] **Step 5: Declare the job**

In `modules/core-security/src/declaration.ts`, add to the `jobs` array:

```ts
    {
      id: 'mail.member_invitation',
      handler: 'jobs/member-invitation-mail.ts',
      handlerFactoryExport: 'createHandler',
      service: 'worker',
    },
```

- [x] **Step 6: Run the test to verify it passes**

```bash
npm run db:reset && npm run test:integration -- member-invitation-mail
```

Expected: PASS, both assertions.

- [x] **Step 7: Commit**

```bash
git add modules/core-security/src/jobs/member-invitation-mail.ts \
        modules/core-security/migrations/017_organization_administration.sql \
        modules/core-security/src/declaration.ts \
        test/integration/member-invitation-mail.test.ts
git commit -m "Send internal onboarding mail when a member is invited"
```

---

### Task 3: Acceptance honours the intended role and writes audit

**Files:**
- Modify: `modules/core-security/src/auth/oidc.ts:321-361` (`resolveOidcMember`)
- Test: `test/integration/security-kernel.test.ts` (add cases)

**Interfaces:**
- Consumes: `invitation.intended_global_role` (Task 1).
- Produces: no signature change. `resolveOidcMember` keeps returning `{ memberId }`.

Two defects are fixed together because they are the same three lines. Acceptance
hardcodes `global_role='member'` at `oidc.ts:348`, and it creates a member and commits
**with no audit row at all**, which contradicts invariant 14.

- [x] **Step 1: Write the failing test**

Add to `test/integration/security-kernel.test.ts`:

```ts
it('accepts an admin invitation as an admin and audits the creation', async () => {
  const invitationId = createOpaqueId();
  await runtimePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
    invitationId, 'promoted@example.test', 'promoted@example.test', 'admin',
    ownerId, createOpaqueId(), createOpaqueId(), createCorrelationId(),
  ]);

  const { memberId } = await resolveOidcMember(authPool, {
    issuer: 'https://idp.example.test',
    subject: 'promoted-subject',
    emailKey: 'promoted@example.test',
    emailDisplay: 'promoted@example.test',
    authenticatedAt: new Date(),
  });

  const member = await migrationPool.query<{ global_role: string }>(
    'SELECT global_role FROM member WHERE id=$1', [memberId],
  );
  expect(member.rows[0]?.global_role).toBe('admin');

  const audit = await migrationPool.query<{ reason_code: string }>(
    "SELECT reason_code FROM audit_event WHERE event_type='invitation.created' AND subject_id=$1",
    [memberId],
  );
  expect(audit.rows[0]?.reason_code).toBe('MEMBER_INVITATION_ACCEPTED');
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
npm run test:integration -- security-kernel
```

Expected: FAIL — `expected 'member' to be 'admin'`.

- [x] **Step 3: Change acceptance**

In `modules/core-security/src/auth/oidc.ts`, replace the invitation lookup and member
insert (currently lines 338-355) with:

```ts
    const invitation = await client.query<{ id: string; intended_global_role: string }>(
      `SELECT id,intended_global_role FROM invitation WHERE kind = 'member' AND email_key = $1
         AND state = 'pending' AND expires_at > transaction_timestamp() FOR UPDATE`,
      [identity.emailKey],
    );
    const accepted = invitation.rows[0];
    if (accepted === undefined) throw new Error('MEMBER_INVITATION_REQUIRED');
    const memberId = createOpaqueId();
    await client.query(
      `INSERT INTO member
       (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
       VALUES ($1,$2,$3,$4,$5,$6,'active')`,
      [memberId, identity.emailKey, identity.emailDisplay, identity.issuer,
       identity.subject, accepted.intended_global_role],
    );
    await client.query("UPDATE invitation SET state = 'accepted' WHERE id = $1", [
      accepted.id,
    ]);
    /* Invariant 14: member creation is a security mutation, so its audit row
     * commits with it. Before this, acceptance created a member silently. */
    await client.query(
      `INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,
                               resource_type,resource_id,result,reason_code,correlation_id)
       VALUES ($1,'invitation.created','member',$2,$2,'member',$2,'success',
               'MEMBER_INVITATION_ACCEPTED',$3)`,
      [createOpaqueId(), memberId, createCorrelationId()],
    );
```

Add `createCorrelationId` to the existing `@duefold/shared/ids` import at the top of the file.

- [x] **Step 4: Run the test to verify it passes**

```bash
npm run test:integration -- security-kernel
```

Expected: PASS. The pre-existing cases in this file must still pass — a member invited
with `intended_global_role='member'` still becomes a plain member.

- [x] **Step 5: Commit**

```bash
git add modules/core-security/src/auth/oidc.ts test/integration/security-kernel.test.ts
git commit -m "Accept a member into the role their invitation named, and audit it"
```

---

### Task 4: Global role and member state

**Files:**
- Modify: `modules/core-security/migrations/017_organization_administration.sql`
- Test: `test/authz/organization-administration.test.ts` (extend)

**Interfaces:**
- Consumes: `assert_organization_administrator` (Task 1).
- Produces:
  - `set_member_global_role(p_target_id text, p_role text, p_actor_id text, p_expected_revision integer, p_audit_id text, p_correlation_id text) RETURNS integer` — new revision.
  - `set_member_state(p_target_id text, p_state text, p_actor_id text, p_expected_revision integer, p_audit_id text, p_correlation_id text) RETURNS integer` — new revision.

- [x] **Step 1: Write the failing test**

Append to `test/authz/organization-administration.test.ts`:

```ts
describe('set_member_global_role', () => {
  it('promotes a member and revokes their sessions', async () => {
    const sessionId = await activeSessionFor(targetMemberId);
    const next = await databasePool.query<{ set_member_global_role: number }>(
      'SELECT set_member_global_role($1,$2,$3,$4,$5,$6)',
      [targetMemberId, 'admin', ownerId, 1, createOpaqueId(), createCorrelationId()],
    );
    expect(next.rows[0]?.set_member_global_role).toBe(2);

    const session = await migrationPool.query<{ state: string }>(
      'SELECT state FROM session WHERE id=$1', [sessionId],
    );
    expect(session.rows[0]?.state).toBe('revoked');
  });

  it('refuses to target the Owner', async () => {
    await expect(
      databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)',
        [ownerId, 'admin', ownerId, 1, createOpaqueId(), createCorrelationId()]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects a stale revision', async () => {
    await expect(
      databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)',
        [targetMemberId, 'member', ownerId, 99, createOpaqueId(), createCorrelationId()]),
    ).rejects.toMatchObject({ code: '40001' });
  });

  it('refuses a plain member as actor', async () => {
    await expect(
      databasePool.query('SELECT set_member_global_role($1,$2,$3,$4,$5,$6)',
        [targetMemberId, 'admin', plainMemberId, 1, createOpaqueId(), createCorrelationId()]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('set_member_state', () => {
  it('disables a member', async () => {
    const revision = await currentRevision(disposableMemberId);
    await databasePool.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)',
      [disposableMemberId, 'disabled', ownerId, revision, createOpaqueId(), createCorrelationId()]);
    const row = await migrationPool.query<{ state: string }>(
      'SELECT state FROM member WHERE id=$1', [disposableMemberId],
    );
    expect(row.rows[0]?.state).toBe('disabled');
  });

  it('refuses to disable the Owner with a clear error, not a constraint violation', async () => {
    await expect(
      databasePool.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)',
        [ownerId, 'disabled', ownerId, 1, createOpaqueId(), createCorrelationId()]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
```

Add these two helpers near the top of the file:

```ts
async function currentRevision(memberId: string): Promise<number> {
  const row = await migrationPool.query<{ revision: number }>(
    'SELECT revision FROM member WHERE id=$1', [memberId],
  );
  if (row.rows[0] === undefined) throw new Error('member missing');
  return row.rows[0].revision;
}

async function activeSessionFor(memberId: string): Promise<string> {
  const issued = await issueSession(authPool, {
    principal: { kind: 'member', id: memberId, oidcAuthenticatedAt: new Date() },
    policy: sessionPolicy,
    clock: new FixedClock(new Date()),
  });
  return issued.sessionId;
}
```

- [x] **Step 2: Run the test to verify it fails**

```bash
npm run test:authz -- organization-administration
```

Expected: FAIL — `function set_member_global_role(...) does not exist`.

- [x] **Step 3: Append the two functions to migration 017**

```sql
-- Ownership never moves through these. The Owner is untargetable here so that a
-- single audited path (transfer_ownership) owns the one_active_owner invariant.
CREATE FUNCTION set_member_global_role(
  p_target_id text,p_role text,p_actor_id text,p_expected_revision integer,
  p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer; previous_role text;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_role NOT IN ('admin','member') THEN
    RAISE EXCEPTION 'invalid global role' USING ERRCODE='22023';
  END IF;
  SELECT global_role INTO previous_role FROM member WHERE id=p_target_id;
  IF previous_role IS NULL OR previous_role='owner' THEN
    RAISE EXCEPTION 'target is not role-assignable' USING ERRCODE='42501';
  END IF;
  UPDATE member SET global_role=p_role,revision=revision+1
    WHERE id=p_target_id AND revision=p_expected_revision
    RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'stale member revision' USING ERRCODE='40001';
  END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,resource_type,
                          resource_id,result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'member.role','member',p_actor_id,p_target_id,'member',p_target_id,
         'success','MEMBER_ROLE_CHANGED',p_correlation_id,
         jsonb_build_object('from',previous_role,'to',p_role));
  RETURN next_revision;
END $$;

CREATE FUNCTION set_member_state(
  p_target_id text,p_state text,p_actor_id text,p_expected_revision integer,
  p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer; target_role text;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_state NOT IN ('active','disabled') THEN
    RAISE EXCEPTION 'invalid member state' USING ERRCODE='22023';
  END IF;
  SELECT global_role INTO target_role FROM member WHERE id=p_target_id;
  IF target_role IS NULL THEN
    RAISE EXCEPTION 'member not found' USING ERRCODE='42501';
  END IF;
  /* Disabling the Owner would trip one_active_owner and surface as a constraint
   * violation the UI cannot explain. Refuse it here with a reason instead. */
  IF target_role='owner' AND p_state='disabled' THEN
    RAISE EXCEPTION 'the Owner cannot be disabled; transfer ownership first'
      USING ERRCODE='42501';
  END IF;
  UPDATE member SET state=p_state,revision=revision+1
    WHERE id=p_target_id AND revision=p_expected_revision
    RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'stale member revision' USING ERRCODE='40001';
  END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,resource_type,
                          resource_id,result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'member.state','member',p_actor_id,p_target_id,'member',p_target_id,
         'success','MEMBER_STATE_CHANGED',p_correlation_id,
         jsonb_build_object('to',p_state));
  RETURN next_revision;
END $$;

REVOKE ALL ON FUNCTION set_member_global_role(text,text,text,integer,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION set_member_state(text,text,text,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_member_global_role(text,text,text,integer,text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION set_member_state(text,text,text,integer,text,text) TO duefold_runtime;
ALTER FUNCTION set_member_global_role(text,text,text,integer,text,text) OWNER TO duefold_migration;
ALTER FUNCTION set_member_state(text,text,text,integer,text,text) OWNER TO duefold_migration;
```

- [x] **Step 4: Run the test to verify it passes**

```bash
npm run db:reset && npm run test:authz -- organization-administration
```

Expected: PASS, all six new assertions.

- [x] **Step 5: Commit**

```bash
git add modules/core-security/migrations/017_organization_administration.sql \
        test/authz/organization-administration.test.ts
git commit -m "Change a member's role and state through audited functions"
```

---

### Task 5: Ownership transfer

**Files:**
- Modify: `modules/core-security/migrations/017_organization_administration.sql`
- Test: `test/authz/organization-administration.test.ts` (extend)

**Interfaces:**
- Consumes: `assert_organization_administrator` (Task 1).
- Produces:
  - `dry_run_ownership_transfer(p_target_id text, p_actor_id text) RETURNS jsonb` — `{targetEmailDisplay, confirmation, message}`.
  - `transfer_ownership(p_target_id text, p_actor_id text, p_expected_revision integer, p_confirmation text, p_audit_id text, p_correlation_id text) RETURNS void`.

**The statement order is load-bearing.** `exactly_one_owner_after_member` is a
`DEFERRABLE INITIALLY DEFERRED` constraint trigger checked at commit, so zero owners is
legal mid-transaction. `one_active_owner` is a **partial unique index**, which cannot be
deferred and is checked immediately. Demote first, then promote. The reverse order holds
two active owners between statements and raises `23505`.

- [x] **Step 1: Write the failing test**

Append to `test/authz/organization-administration.test.ts`:

```ts
describe('transfer_ownership', () => {
  it('moves ownership, demoting the outgoing Owner to admin', async () => {
    const impact = await databasePool.query<{ dry_run_ownership_transfer: {
      confirmation: string } }>(
      'SELECT dry_run_ownership_transfer($1,$2)', [successorId, ownerId],
    );
    const confirmation = impact.rows[0]?.dry_run_ownership_transfer.confirmation;
    expect(confirmation).toBe('TRANSFER OWNERSHIP');

    await databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6)', [
      successorId, ownerId, await currentRevision(successorId), confirmation,
      createOpaqueId(), createCorrelationId(),
    ]);

    const roles = await migrationPool.query<{ id: string; global_role: string }>(
      'SELECT id,global_role FROM member WHERE id = ANY($1) ORDER BY id',
      [[ownerId, successorId].sort()],
    );
    const byId = new Map(roles.rows.map((r) => [r.id, r.global_role]));
    expect(byId.get(successorId)).toBe('owner');
    expect(byId.get(ownerId)).toBe('admin');
  });

  it('revokes the outgoing Owner’s own sessions', async () => {
    const sessionId = await activeSessionFor(ownerId);
    await databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6)', [
      secondSuccessorId, ownerId, await currentRevision(secondSuccessorId),
      'TRANSFER OWNERSHIP', createOpaqueId(), createCorrelationId(),
    ]);
    const session = await migrationPool.query<{ state: string }>(
      'SELECT state FROM session WHERE id=$1', [sessionId],
    );
    expect(session.rows[0]?.state).toBe('revoked');
  });

  it('refuses a mismatched confirmation', async () => {
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6)', [
        successorId, ownerId, 1, 'transfer ownership',
        createOpaqueId(), createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('refuses an Admin who is not the Owner', async () => {
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6)', [
        successorId, adminId, 1, 'TRANSFER OWNERSHIP',
        createOpaqueId(), createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a disabled target', async () => {
    await expect(
      databasePool.query('SELECT transfer_ownership($1,$2,$3,$4,$5,$6)', [
        disabledMemberId, ownerId, 1, 'TRANSFER OWNERSHIP',
        createOpaqueId(), createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
```

Each transfer case needs a fresh Owner, so give this `describe` its own
`beforeEach` that reseeds `ownerId`, `successorId` and `secondSuccessorId` through
`migrationPool` exactly as the file's existing seed block does.

- [x] **Step 2: Run the test to verify it fails**

```bash
npm run test:authz -- organization-administration
```

Expected: FAIL — `function dry_run_ownership_transfer(...) does not exist`.

- [x] **Step 3: Append both functions to migration 017**

```sql
CREATE FUNCTION dry_run_ownership_transfer(p_target_id text,p_actor_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target_display text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM member
                WHERE id=p_actor_id AND state='active' AND global_role='owner') THEN
    RAISE EXCEPTION 'ownership transfer is Owner-only' USING ERRCODE='42501';
  END IF;
  SELECT email_display INTO target_display
    FROM member WHERE id=p_target_id AND state='active' AND global_role<>'owner';
  IF target_display IS NULL THEN
    RAISE EXCEPTION 'target cannot receive ownership' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object(
    'targetEmailDisplay',target_display,
    'confirmation','TRANSFER OWNERSHIP',
    'message','You become an Admin, the named member becomes Owner, and both of you '
              'are signed out of every device because privileges changed.');
END $$;

CREATE FUNCTION transfer_ownership(
  p_target_id text,p_actor_id text,p_expected_revision integer,p_confirmation text,
  p_audit_id text,p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb; promoted integer;
BEGIN
  impact := dry_run_ownership_transfer(p_target_id,p_actor_id);
  IF p_confirmation IS DISTINCT FROM impact->>'confirmation' THEN
    RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE='22023';
  END IF;
  /* ORDER IS LOAD-BEARING. one_active_owner is a PARTIAL UNIQUE INDEX and cannot
   * be deferred, so two active owners may never coexist even for one statement.
   * exactly_one_owner_after_member is DEFERRABLE INITIALLY DEFERRED and is checked
   * at COMMIT, so zero owners in between is fine. Demote, then promote. */
  UPDATE member SET global_role='admin',revision=revision+1
    WHERE id=p_actor_id AND global_role='owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outgoing owner changed concurrently' USING ERRCODE='40001';
  END IF;
  UPDATE member SET global_role='owner',revision=revision+1
    WHERE id=p_target_id AND revision=p_expected_revision AND state='active'
    RETURNING revision INTO promoted;
  IF promoted IS NULL THEN
    RAISE EXCEPTION 'stale member revision' USING ERRCODE='40001';
  END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,resource_type,
                          resource_id,result,reason_code,correlation_id)
  VALUES(p_audit_id,'ownership.transferred','member',p_actor_id,p_target_id,'member',
         p_target_id,'success','OWNERSHIP_TRANSFERRED',p_correlation_id);
END $$;

REVOKE ALL ON FUNCTION dry_run_ownership_transfer(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION transfer_ownership(text,text,integer,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dry_run_ownership_transfer(text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION transfer_ownership(text,text,integer,text,text,text) TO duefold_runtime;
ALTER FUNCTION dry_run_ownership_transfer(text,text) OWNER TO duefold_migration;
ALTER FUNCTION transfer_ownership(text,text,integer,text,text,text) OWNER TO duefold_migration;
```

- [x] **Step 4: Run the test to verify it passes**

```bash
npm run db:reset && npm run test:authz -- organization-administration
```

Expected: PASS, all five assertions.

- [x] **Step 5: Prove the ordering claim with a regression test**

Add one more case that asserts the constraint the comment describes, so a future
reordering fails loudly rather than intermittently:

```ts
it('cannot hold two active owners even momentarily', async () => {
  await expect(
    migrationPool.query(
      "UPDATE member SET global_role='owner' WHERE id=$1", [successorId],
    ),
  ).rejects.toMatchObject({ code: '23505' });
});
```

Run it: `npm run test:authz -- organization-administration`. Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add modules/core-security/migrations/017_organization_administration.sql \
        test/authz/organization-administration.test.ts
git commit -m "Transfer ownership in the only order the owner index permits"
```

---

### Task 6: Room assignments, applied as one batch per member

**Files:**
- Modify: `modules/core-security/migrations/017_organization_administration.sql`
- Test: `test/authz/organization-administration.test.ts` (extend)

**Interfaces:**
- Consumes: `assert_organization_administrator` (Task 1); `room_assignment` from `001_security_kernel.sql:126`.
- Produces: `apply_room_assignments(p_member_id text, p_assign jsonb, p_revoke jsonb, p_actor_id text, p_audit_id text, p_correlation_id text) RETURNS integer` — the number of rows changed. `p_assign` is `[{"roomId":"...","roomRole":"manager"}]`; `p_revoke` is `["roomId", ...]`.

**Why a batch and not one call per room.** `room_assignment_privilege_session_revoke`
fires on **every** insert, update and delete of a `room_assignment` row and revokes
**all** of that member's active sessions. Staffing someone across four rooms as four
calls signs them out four times. One transaction produces one revocation.

- [x] **Step 1: Write the failing test**

```ts
describe('apply_room_assignments', () => {
  it('assigns several rooms in one transaction and revokes sessions once', async () => {
    const sessionId = await activeSessionFor(targetMemberId);
    const changed = await databasePool.query<{ apply_room_assignments: number }>(
      'SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)',
      [targetMemberId,
       JSON.stringify([
         { roomId: firstRoomId, roomRole: 'manager' },
         { roomId: secondRoomId, roomRole: 'contributor' },
       ]),
       JSON.stringify([]),
       ownerId, createOpaqueId(), createCorrelationId()],
    );
    expect(changed.rows[0]?.apply_room_assignments).toBe(2);

    const rows = await migrationPool.query<{ room_id: string; room_role: string }>(
      "SELECT room_id,room_role FROM room_assignment WHERE member_id=$1 AND state='active' ORDER BY room_id",
      [targetMemberId],
    );
    expect(rows.rows).toHaveLength(2);

    const session = await migrationPool.query<{ state: string }>(
      'SELECT state FROM session WHERE id=$1', [sessionId],
    );
    expect(session.rows[0]?.state).toBe('revoked');
  });

  it('reactivates a revoked assignment rather than inserting a duplicate', async () => {
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)',
      [targetMemberId, JSON.stringify([]), JSON.stringify([firstRoomId]),
       ownerId, createOpaqueId(), createCorrelationId()]);
    await databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)',
      [targetMemberId, JSON.stringify([{ roomId: firstRoomId, roomRole: 'contributor' }]),
       JSON.stringify([]), ownerId, createOpaqueId(), createCorrelationId()]);
    const rows = await migrationPool.query<{ room_role: string; state: string }>(
      'SELECT room_role,state FROM room_assignment WHERE member_id=$1 AND room_id=$2',
      [targetMemberId, firstRoomId],
    );
    expect(rows.rows).toEqual([{ room_role: 'contributor', state: 'active' }]);
  });

  it('refuses a plain member as actor', async () => {
    await expect(
      databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)',
        [targetMemberId, JSON.stringify([{ roomId: firstRoomId, roomRole: 'manager' }]),
         JSON.stringify([]), plainMemberId, createOpaqueId(), createCorrelationId()]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects an unknown room role', async () => {
    await expect(
      databasePool.query('SELECT apply_room_assignments($1,$2,$3,$4,$5,$6)',
        [targetMemberId, JSON.stringify([{ roomId: firstRoomId, roomRole: 'owner' }]),
         JSON.stringify([]), ownerId, createOpaqueId(), createCorrelationId()]),
    ).rejects.toMatchObject({ code: '22023' });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
npm run test:authz -- organization-administration
```

Expected: FAIL — `function apply_room_assignments(...) does not exist`.

- [x] **Step 3: Append the function to migration 017**

```sql
-- One call per member, not per room: room_assignment_privilege_session_revoke fires
-- on every row change and revokes all of that member's sessions, so a batch is the
-- difference between signing someone out once and signing them out four times.
CREATE FUNCTION apply_room_assignments(
  p_member_id text,p_assign jsonb,p_revoke jsonb,p_actor_id text,
  p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE entry jsonb; changed integer := 0; room text; role_name text;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF NOT EXISTS(SELECT 1 FROM member WHERE id=p_member_id AND state='active') THEN
    RAISE EXCEPTION 'member not assignable' USING ERRCODE='42501';
  END IF;

  FOR entry IN SELECT * FROM jsonb_array_elements(p_assign) LOOP
    room := entry->>'roomId';
    role_name := entry->>'roomRole';
    IF role_name NOT IN ('manager','contributor') THEN
      RAISE EXCEPTION 'invalid room role' USING ERRCODE='22023';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM room WHERE id=room) THEN
      RAISE EXCEPTION 'room not found' USING ERRCODE='42501';
    END IF;
    INSERT INTO room_assignment(id,room_id,member_id,room_role)
    VALUES(replace(gen_random_uuid()::text,'-',''),room,p_member_id,role_name)
    ON CONFLICT (room_id,member_id)
    DO UPDATE SET state='active',room_role=EXCLUDED.room_role;
    changed := changed + 1;
  END LOOP;

  FOR entry IN SELECT * FROM jsonb_array_elements(p_revoke) LOOP
    UPDATE room_assignment SET state='revoked'
      WHERE member_id=p_member_id AND room_id=(entry #>> '{}') AND state='active';
    IF FOUND THEN changed := changed + 1; END IF;
  END LOOP;

  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,resource_type,
                          resource_id,result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'room.assignment','member',p_actor_id,p_member_id,'member',p_member_id,
         'success','ROOM_ASSIGNMENTS_APPLIED',p_correlation_id,
         jsonb_build_object('assigned',jsonb_array_length(p_assign),
                            'revoked',jsonb_array_length(p_revoke)));
  RETURN changed;
END $$;

REVOKE ALL ON FUNCTION apply_room_assignments(text,jsonb,jsonb,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_room_assignments(text,jsonb,jsonb,text,text,text) TO duefold_runtime;
ALTER FUNCTION apply_room_assignments(text,jsonb,jsonb,text,text,text) OWNER TO duefold_migration;
```

The `ON CONFLICT (room_id,member_id)` target matches the `UNIQUE (room_id, member_id)`
already declared at `001_security_kernel.sql:133`.

- [x] **Step 4: Run the test to verify it passes**

```bash
npm run db:reset && npm run test:authz -- organization-administration
```

Expected: PASS, all four assertions.

- [x] **Step 5: Commit**

```bash
git add modules/core-security/migrations/017_organization_administration.sql \
        test/authz/organization-administration.test.ts
git commit -m "Staff a member across rooms in one audited batch"
```

---

### Task 7: HTTP routes

**Files:**
- Create: `modules/core-security/src/administration.ts`
- Create: `modules/core-security/src/routes/member-list.ts`
- Create: `modules/core-security/src/routes/member-actions.ts`
- Modify: `modules/core-security/src/declaration.ts` (routes array)
- Test: `test/authz/organization-routes.test.ts`

**Interfaces:**
- Consumes: every function from Tasks 1, 4, 5, 6; `WebRuntime` from `apps/web/src/runtime.ts`; `MemberIdentity` from `modules/core-security/src/authorization.ts`.
- Produces:
  - `GET /api/members` → `{subjects: [{subjectKind, subjectId, emailDisplay, globalRole, state, revision, assignments: [{roomId, roomRole}]}]}`
  - `POST /api/members/actions` → discriminated union on `action`.
  - `modules/core-security/src/administration.ts` exports `readMembers`, `inviteMember`, `revokeMemberInvitation`, `setMemberGlobalRole`, `setMemberState`, `dryRunOwnershipTransfer`, `transferOwnership`, `applyRoomAssignments`, each taking `{pool, identity, ...}` and returning plain data.

Follow the shape of `modules/rooms-documents/src/routes/room-actions.ts` exactly: a
TypeBox `Type.Union` body, one `createHandler(runtime, identity)` export, and a `handler`
that throws `'... route runtime not initialized'`.

- [x] **Step 1: Write the failing test**

Create `test/authz/organization-routes.test.ts`, reusing the app bootstrap from
`test/authz/security-routes.test.ts`:

```ts
it('denies an unauthenticated request', async () => {
  const response = await unauthenticated.inject({ method: 'GET', url: '/api/members' });
  expect(response.statusCode).toBe(401);
});

it('denies a viewer session', async () => {
  const response = await viewerApp.inject({ method: 'GET', url: '/api/members' });
  expect(response.statusCode).toBe(403);
});

it('denies a plain member without disclosing whether members exist', async () => {
  const response = await plainMemberApp.inject({ method: 'GET', url: '/api/members' });
  expect(response.statusCode).toBe(403);
  expect(response.body).not.toContain('@');
});

it('lists members and pending invitations for an Admin', async () => {
  const response = await adminApp.inject({ method: 'GET', url: '/api/members' });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { subjects: { subjectKind: string }[] };
  expect(body.subjects.some((s) => s.subjectKind === 'invitation')).toBe(true);
});

it('rejects a mutation without the CSRF header', async () => {
  const response = await adminApp.inject({
    method: 'POST', url: '/api/members/actions',
    payload: { action: 'invite', email: 'x@example.test', intendedRole: 'member' },
  });
  expect(response.statusCode).toBe(403);
});

it('invites a member', async () => {
  const response = await adminApp.inject({
    method: 'POST', url: '/api/members/actions',
    headers: csrfHeaders,
    payload: { action: 'invite', email: 'fresh@example.test', intendedRole: 'admin' },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json()).toMatchObject({ intendedRole: 'admin' });
});

it('rejects an unknown action rather than defaulting', async () => {
  const response = await adminApp.inject({
    method: 'POST', url: '/api/members/actions',
    headers: csrfHeaders,
    payload: { action: 'delete-everything' },
  });
  expect(response.statusCode).toBe(400);
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
npm run test:authz -- organization-routes
```

Expected: FAIL — 404 on `/api/members`, because the route is not declared.

- [x] **Step 3: Write the operations module**

Create `modules/core-security/src/administration.ts`. One representative function; write
the remaining seven in the same shape, each a single `pool.query` over its SQL function
with `createOpaqueId()` for the audit id and `createCorrelationId()` for the correlation:

```ts
import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { normalizeEmail } from './auth/email.ts';
import type { MemberIdentity } from './authorization.ts';

/**
 * Organization administration operations.
 *
 * Every function here is a thin call over a SECURITY DEFINER function that
 * authorizes the actor and audits itself. This layer decides nothing: it does not
 * check roles, and it never writes an audit row, because a mutation and its audit
 * must commit together inside PostgreSQL (invariant 14).
 */
export interface InvitedMember {
  readonly invitationId: string;
  readonly intendedRole: 'admin' | 'member';
  readonly expiresAt: Date;
}

export async function inviteMember(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly email: string;
  readonly intendedRole: 'admin' | 'member';
}): Promise<InvitedMember> {
  const { emailKey, emailDisplay } = normalizeEmail(input.email);
  const invitationId = createOpaqueId();
  const result = await input.pool.query<{ invite_member: Date }>(
    'SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)',
    [invitationId, emailKey, emailDisplay, input.intendedRole, input.identity.id,
     createOpaqueId(), createOpaqueId(), createCorrelationId()],
  );
  const expiresAt = result.rows[0]?.invite_member;
  if (expiresAt === undefined) throw new Error('MEMBER_INVITATION_FAILED');
  return { invitationId, intendedRole: input.intendedRole, expiresAt };
}
```

Confirm the export name and shape of the email normalizer before using it:
`grep -rn "export function normalize" modules/core-security/src/auth/`. Use whatever it
actually exports; §8.2's normalization rules are already implemented there and must not
be reimplemented.

- [x] **Step 4: Write the two routes**

`member-list.ts` mirrors `modules/rooms-documents/src/routes/room-list.ts`: a response-only
schema and a `createHandler(runtime, identity)` returning `{subjects}`.

`member-actions.ts` mirrors `modules/rooms-documents/src/routes/room-actions.ts`:

```ts
const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const ROLE = Type.Union([Type.Literal('admin'), Type.Literal('member')]);
const REVISION = Type.Integer({ minimum: 1 });
const CONFIRMATION = Type.String({ minLength: 1, maxLength: 200 });
const NO_EXTRAS = { additionalProperties: false } as const;

export const schema = {
  body: Type.Union([
    Type.Object({ action: Type.Literal('invite'),
      email: Type.String({ minLength: 3, maxLength: 320 }),
      intendedRole: ROLE }, NO_EXTRAS),
    Type.Object({ action: Type.Literal('revoke-invitation'),
      invitationId: ID }, NO_EXTRAS),
    Type.Object({ action: Type.Literal('set-role'),
      memberId: ID, role: ROLE, expectedRevision: REVISION }, NO_EXTRAS),
    Type.Object({ action: Type.Literal('set-state'),
      memberId: ID,
      state: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
      expectedRevision: REVISION }, NO_EXTRAS),
    Type.Object({ action: Type.Literal('transfer-dry-run'),
      memberId: ID }, NO_EXTRAS),
    Type.Object({ action: Type.Literal('transfer-apply'),
      memberId: ID, expectedRevision: REVISION, confirmation: CONFIRMATION }, NO_EXTRAS),
    Type.Object({ action: Type.Literal('assign-rooms'),
      memberId: ID,
      assign: Type.Array(Type.Object({ roomId: ID,
        roomRole: Type.Union([Type.Literal('manager'), Type.Literal('contributor')]) },
        NO_EXTRAS)),
      revoke: Type.Array(ID) }, NO_EXTRAS),
  ]),
};
```

The handler switches exhaustively on `body.action` with a `never` default, the same way
`apps/web/src/route-authority.ts:17` does, so a new action cannot silently fall through.

- [x] **Step 5: Declare the routes**

In `modules/core-security/src/declaration.ts`, add to `routes`:

```ts
    {
      id: 'organization.members.list',
      method: 'GET',
      path: '/api/members',
      audience: 'member',
      handler: 'routes/member-list.ts',
      handlerFactoryExport: 'createHandler',
    },
    {
      id: 'organization.members.actions',
      method: 'POST',
      path: '/api/members/actions',
      audience: 'member',
      handler: 'routes/member-actions.ts',
      handlerFactoryExport: 'createHandler',
    },
```

- [x] **Step 6: Run the test to verify it passes**

```bash
npm run compose && npm run test:authz -- organization-routes
```

Expected: PASS, all seven assertions.

- [x] **Step 7: Add the fresh-OIDC gate for transfer**

§9.4 requires fresh OIDC for ownership. The mechanism already exists — find how
`/api/grants` enforces it (`grep -rn "oidcAuthenticatedAt\|fresh" modules/participants-access/src/`)
and apply the identical check to `transfer-apply`. Add the matching test:

```ts
it('refuses ownership transfer on a stale authentication instant', async () => {
  const response = await staleOwnerApp.inject({
    method: 'POST', url: '/api/members/actions', headers: csrfHeaders,
    payload: { action: 'transfer-apply', memberId: successorId,
               expectedRevision: 1, confirmation: 'TRANSFER OWNERSHIP' },
  });
  expect(response.statusCode).toBe(403);
});
```

Run: `npm run test:authz -- organization-routes`. Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add modules/core-security/src/administration.ts \
        modules/core-security/src/routes/member-list.ts \
        modules/core-security/src/routes/member-actions.ts \
        modules/core-security/src/declaration.ts \
        test/authz/organization-routes.test.ts
git commit -m "Expose organization administration over HTTP"
```

---

### Task 8: Section tabs become a module contribution

**Files:**
- Modify: `apps/web-client/src/contract.ts`
- Create: `modules/branding-notifications/src/browser/branding-section.tsx`
- Move: `apps/web-client/src/components/BrandingPanel.tsx` → `modules/branding-notifications/src/browser/BrandingPanel.tsx`
- Modify: `modules/branding-notifications/src/declaration.ts` (browserEntries)
- Modify: `apps/web-client/src/routes/Workspace.tsx` (remove the `SECTIONS` literal and the branding import)
- Test: `apps/web-client/src/components/AppShell.unit.test.tsx` (extend), `test/composition/omitted-module.test.ts`

**Interfaces:**
- Consumes: `BrowserContribution` and the virtual module `virtual:duefold/browser-entries` resolved by `apps/web-client/build/browser-entries-plugin.ts`.
- Produces: `SectionContribution` on `BrowserContribution`:

```ts
export interface SectionContribution {
  readonly id: string;
  readonly scope: 'top' | 'room';
  /** Key in the localization catalogue; never literal copy. */
  readonly labelKey: string;
  /** Ascending. Core sections occupy 10, 20, 30…; contributed ones sit between. */
  readonly order: number;
  readonly render: (props: SectionProps) => React.ReactElement;
}
export interface SectionProps {
  readonly roomId: string | null;
  readonly onStatus: (message: string) => void;
}
```

**Why this task exists.** `SECTIONS` at `Workspace.tsx:73` hardcodes `'branding'`, so an
installation that omits the branding module still ships the tab and the panel in the
browser bundle. That contradicts invariant 17 and §5.2's requirement that generated
registries carry navigation. Adding four more hardcoded entries would widen it.

No new build mechanism is needed. `browser-entries-plugin.ts` already emits literal static
imports of exactly the composed modules.

- [x] **Step 1: Write the failing test**

Add to `test/composition/omitted-module.test.ts` (create the file if the existing
omission evidence lives elsewhere — check `grep -rln "minimal.manifest" test/`):

```ts
it('omits the branding section from a minimal composition', async () => {
  const bundle = await buildWithManifest('composition.minimal.manifest.json');
  expect(bundle).not.toContain('BrandingPanel');
  expect(bundle).not.toContain('workspace.tab.branding');
});
```

- [x] **Step 2: Run the test to verify it fails**

```bash
npm run compose:verify:minimal && npm run test:unit -- omitted-module
```

Expected: FAIL — the minimal bundle contains `BrandingPanel`.

- [x] **Step 3: Add `SectionContribution` to the contract**

Append the two interfaces above to `apps/web-client/src/contract.ts` and add the field:

```ts
export interface BrowserContribution {
  readonly supportContact?: SupportContactSlot;
  readonly branding?: BrandingSlot;
  readonly viewerIntroduction?: ViewerIntroductionSlot;
  readonly sections?: readonly SectionContribution[];
}
```

- [x] **Step 4: Move the panel and contribute it**

`git mv apps/web-client/src/components/BrandingPanel.tsx modules/branding-notifications/src/browser/BrandingPanel.tsx`,
fix its relative imports, then create
`modules/branding-notifications/src/browser/branding-section.tsx`:

```tsx
import type { BrowserContribution } from '@duefold/web-client/contract';
import { BrandingPanel } from './BrandingPanel.tsx';

/**
 * The room Branding section.
 *
 * Contributed, not hardcoded: when this module is omitted from the manifest the
 * generated registry has no entry, nothing imports this file, and neither the tab
 * nor the panel can reach the bundle.
 */
export const contribution: BrowserContribution = {
  sections: [
    {
      id: 'branding',
      scope: 'room',
      labelKey: 'workspace.tab.branding',
      order: 50,
      render: ({ roomId, onStatus }) =>
        roomId === null ? <></> : <BrandingPanel roomId={roomId} onStatus={onStatus} />,
    },
  ],
};
```

Add its `browserEntries` record to `modules/branding-notifications/src/declaration.ts`.

- [x] **Step 5: Build the tab strips from contributions**

In `Workspace.tsx`, delete the `SECTIONS` literal, `SECTION_LABEL`, the `BrandingPanel`
import and the `section === 'branding'` branch. Create
`apps/web-client/src/workspace/sections.ts`:

```ts
import { contributions } from 'virtual:duefold/browser-entries';
import type { SectionContribution } from '../contract.ts';

/** Core sections take 10, 20, 30, 40; a contributed section sorts in by `order`. */
const CORE: readonly SectionContribution[] = [
  { id: 'structure', scope: 'room', labelKey: 'workspace.tab.structure', order: 10, render: renderStructure },
  { id: 'participants', scope: 'room', labelKey: 'workspace.tab.participants', order: 20, render: renderParticipants },
  { id: 'processing', scope: 'room', labelKey: 'workspace.tab.processing', order: 30, render: renderProcessing },
  { id: 'exports', scope: 'room', labelKey: 'workspace.tab.exports', order: 40, render: renderExports },
];

export function sectionsFor(scope: 'top' | 'room'): readonly SectionContribution[] {
  const contributed = contributions.flatMap((entry) => entry.sections ?? []);
  return [...CORE, ...contributed]
    .filter((section) => section.scope === scope)
    .sort((left, right) => left.order - right.order);
}
```

Check the exact export name the virtual module provides before importing it:
`grep -n "export const" apps/web-client/build/browser-entries-plugin.ts`. Use whatever it
actually emits.

- [x] **Step 6: Run the tests to verify they pass**

```bash
npm run test:unit -- omitted-module AppShell
npm run typecheck
```

Expected: PASS, and the full composition still lists branding when the default manifest is used.

- [x] **Step 7: Commit**

```bash
git add -A apps/web-client/src modules/branding-notifications test/composition
git commit -m "Let modules contribute their own section tabs"
```

---

### Task 9: Split the member frame into views

**Files:**
- Modify: `apps/web-client/src/routes/Workspace.tsx` (1079 lines → a thin frame)
- Create: `apps/web-client/src/workspace/views/RegisterView.tsx`
- Create: `apps/web-client/src/workspace/views/AdministrationView.tsx`
- Create: `apps/web-client/src/workspace/views/RoomView.tsx`
- Test: `apps/web-client/src/workspace/views/views.unit.test.tsx`

**Interfaces:**
- Consumes: `AppShell`, the `useRoomSections` hooks, `SectionContribution` (Task 8).
- Produces: each view exports a default-shaped component taking
  `{onStatus: (message: string) => void}` plus its own props; `Workspace.tsx` exports
  `WorkspaceProps` unchanged so `App.tsx` needs no edit.

This is a pure move. Behaviour must not change, which is what makes it safely testable:
the existing unit tests are the specification.

- [x] **Step 1: Record the baseline**

```bash
npx vitest run --project unit --maxWorkers=2 2>&1 | tail -5
```

Write the passing count down. It must be identical at the end of this task.

- [x] **Step 2: Write the failing test**

Create `apps/web-client/src/workspace/views/views.unit.test.tsx`:

```tsx
it('renders the register with the tab strip and the New room action', () => {
  render(<RegisterView rooms={[]} onOpen={() => {}} onStatus={() => {}} />);
  expect(screen.getByRole('button', { name: /new room/i })).toBeTruthy();
  expect(screen.getByRole('navigation', { name: /sections/i })).toBeTruthy();
});

it('renders the administration view with Members current', () => {
  render(<AdministrationView section="members" onStatus={() => {}} />);
  expect(screen.getByRole('heading', { level: 1, name: /members/i })).toBeTruthy();
});
```

- [x] **Step 3: Run the test to verify it fails**

```bash
npx vitest run --project unit --maxWorkers=2 -- views
```

Expected: FAIL — the modules do not exist.

- [x] **Step 4: Perform the split**

Move the register branch of `Workspace.tsx` into `RegisterView.tsx`, the room branch into
`RoomView.tsx`, and create `AdministrationView.tsx` as a shell with a Members section that
renders an empty state for now (Task 10 fills it). `Workspace.tsx` keeps only: session
state, theme, the current view, and the `AppShell` call. Target under 200 lines.

- [x] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run --project unit --maxWorkers=2
npm run typecheck
```

Expected: PASS, with the passing count from Step 1 **plus two**. Any other change in that
number means the move altered behaviour — find it before continuing.

- [x] **Step 6: Commit**

```bash
git add apps/web-client/src
git commit -m "Split the member frame into register, administration, and room views"
```

---

### Task 10: The Members surface

**Files:**
- Create: `apps/web-client/src/components/MembersPanel.tsx`
- Create: `apps/web-client/src/components/MemberDetail.tsx`
- Create: `apps/web-client/src/api/administration.ts`
- Modify: `apps/web-client/src/api/client.ts` (re-export)
- Modify: `apps/web-client/src/i18n/en.ts`
- Modify: `apps/web-client/src/workspace/views/AdministrationView.tsx`
- Test: `apps/web-client/src/components/MembersPanel.unit.test.tsx`

**Interfaces:**
- Consumes: `GET /api/members`, `POST /api/members/actions` (Task 7); `Notice`, `StatusRegion` components.
- Produces: `MembersPanel` props
  `{subjects, rooms, loading, denied, failure, onInvite, onRevokeInvitation, onRoleChange, onStateChange, onAssign, onTransfer}`.

- [x] **Step 1: Add the localization keys**

In `apps/web-client/src/i18n/en.ts`, add at minimum:

```ts
  'members.title': 'Members',
  'members.empty': 'You are the only member of this installation.',
  'members.emptyHelp': 'Invite a colleague to give them access to rooms.',
  'members.columns.person': 'Person',
  'members.columns.role': 'Role',
  'members.columns.state': 'State',
  'members.columns.rooms': 'Rooms',
  'members.role.owner': 'Owner',
  'members.role.admin': 'Admin',
  'members.role.member': 'Member',
  'members.state.active': 'Active',
  'members.state.disabled': 'Disabled',
  'members.state.invited': 'Invited, not yet signed in',
  'members.invite.submit': 'Invite member',
  'members.invite.sent': 'Invitation sent. It expires in seven days.',
  'members.assign.signOutWarning':
    'This member will be signed out of every device and must sign in again.',
  'members.transfer.title': 'Transfer ownership',
  'members.transfer.confirmLabel': 'Type TRANSFER OWNERSHIP to confirm',
  'members.transfer.consequence':
    'You become an Admin and are signed out of every device immediately.',
  'members.denied': 'Member administration is not available to your role.',
```

- [x] **Step 2: Write the failing test**

```tsx
it('names every state in words, not by colour alone', () => {
  render(<MembersPanel subjects={[invitedSubject]} {...noops} />);
  expect(screen.getByText('Invited, not yet signed in')).toBeTruthy();
});

it('warns that assignment signs the member out before submitting', async () => {
  render(<MembersPanel subjects={[activeMember]} rooms={[room]} {...noops} />);
  await userEvent.click(screen.getByRole('button', { name: /rooms/i }));
  expect(screen.getByText(/signed out of every device/i)).toBeTruthy();
});

it('keeps the transfer button disabled until the confirmation matches exactly', async () => {
  render(<MembersPanel subjects={[activeMember]} {...noops} />);
  await userEvent.click(screen.getByRole('button', { name: /transfer ownership/i }));
  const confirm = screen.getByRole('button', { name: /^transfer$/i });
  expect(confirm).toBeDisabled();
  await userEvent.type(screen.getByLabelText(/type transfer ownership/i), 'transfer ownership');
  expect(confirm).toBeDisabled();
  await userEvent.clear(screen.getByLabelText(/type transfer ownership/i));
  await userEvent.type(screen.getByLabelText(/type transfer ownership/i), 'TRANSFER OWNERSHIP');
  expect(confirm).toBeEnabled();
});

it('renders the denied state without revealing whether members exist', () => {
  render(<MembersPanel denied {...noops} />);
  expect(screen.getByText(/not available to your role/i)).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
});
```

- [x] **Step 3: Run the test to verify it fails**

```bash
npx vitest run --project unit --maxWorkers=2 -- MembersPanel
```

Expected: FAIL — module not found.

- [x] **Step 4: Write the API client and the panel**

`api/administration.ts` follows `api/participants.ts`: typed parsers that validate every
field off the wire rather than casting. `MembersPanel` renders a `<table>` with a
`<caption>` and `scope` attributes, matching `RoomRegister.tsx`. The transfer dialog is
`role="dialog"`, focus-trapped, `aria-describedby` the consequence paragraph, with the
confirmation input compared exactly against the server-supplied string.

- [x] **Step 5: Handle the self-inflicted sign-out after transfer**

Spec §6.4. `member_privilege_session_revoke` revokes the acting Owner's sessions inside
`transfer_ownership`, so the very response to `transfer-apply` arrives on a session that
no longer exists, and the next request 401s. That is success, not failure, and must not
render as a generic auth error.

Add the key:

```ts
  'members.transfer.sessionEnded':
    'Ownership transferred. You are now an Admin and have been signed out of every device.',
```

Write the test first:

```tsx
it('reports a completed transfer as a sign-out, not an error', async () => {
  const onTransfer = vi.fn().mockResolvedValue({ outcome: 'session-ended' });
  render(<MembersPanel subjects={[activeMember]} onTransfer={onTransfer} {...noops} />);
  await completeTransferDialog();
  expect(await screen.findByText(/signed out of every device/i)).toBeTruthy();
  expect(screen.queryByText(/something went wrong/i)).toBeNull();
});
```

Then make `api/administration.ts` treat a 401 **on the transfer-apply response only** as
`{outcome: 'session-ended'}` rather than throwing, and have `AdministrationView` route
that outcome to the designed sign-in surface carrying this message. A 401 on any other
call keeps its existing meaning.

Run: `npx vitest run --project unit --maxWorkers=2 -- MembersPanel`. Expected: PASS.

- [x] **Step 6: Wire it into the view and run the tests**

```bash
npx vitest run --project unit --maxWorkers=2
npm run typecheck && npm run lint
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/web-client/src
git commit -m "Add the Members administration surface"
```

---

### Task 11: Browser journey and accessibility

**Files:**
- Create: `test/browser/administration.spec.ts`
- Modify: `test/support/browser-server.ts` (seed an Admin and a pending invitation)

**Interfaces:**
- Consumes: everything above.
- Produces: no application code.

- [x] **Step 1: Write the failing test**

```ts
test('an Admin invites a member and staffs them into a room', async ({ page }) => {
  await signInAsAdmin(page);
  await page.getByRole('button', { name: 'Members' }).click();
  await page.getByLabel('Email address').fill('newcolleague@example.test');
  await page.getByLabel('Role').selectOption('member');
  await page.getByRole('button', { name: 'Invite member' }).click();
  await expect(page.getByText('Invitation sent')).toBeVisible();
  await expect(page.getByText('Invited, not yet signed in')).toBeVisible();
});

test('the Members surface has no accessibility violations in either theme', async ({ page }) => {
  await signInAsAdmin(page);
  await page.getByRole('button', { name: 'Members' }).click();
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  }
});

test('the Members tab is absent for a plain member', async ({ page }) => {
  await signInAsPlainMember(page);
  await expect(page.getByRole('button', { name: 'Members' })).toHaveCount(0);
});
```

- [x] **Step 2: Run to verify it fails**

```bash
npm run test:browser -- administration
```

Expected: FAIL — the Members tab is not reachable from the seeded state.

- [x] **Step 3: Seed the fixtures**

Extend `test/support/browser-server.ts` to create an Admin member, a plain member, and one
pending member invitation, following the seeding already there at line 486.

- [x] **Step 4: Run to verify it passes**

```bash
npm run test:browser -- administration
```

Expected: PASS, all three, on Chromium, Firefox and WebKit.

- [x] **Step 5: Full verification**

```bash
free -h
npm run format && npm run lint && npm run typecheck
npm run compose:verify && npm run compose:verify:minimal
npx vitest run --project unit --maxWorkers=2
npm run test:authz && npm run test:integration
```

Run these **one at a time**. The combined `npm run verify` has exhausted memory on this
machine before.

- [x] **Step 6: Commit**

```bash
git add test/
git commit -m "Cover the administration journey in the browser"
```

---

## Done when

- An Owner can invite an Admin, that Admin signs in through OIDC and arrives as an Admin.
- An Admin can staff a member into rooms as Manager or Contributor in one action.
- An Owner can transfer ownership, and is signed out by it.
- A plain member sees no Members tab and gets 403 from both routes.
- A minimal composition contains no branding section, tab or panel.
- Every mutation has an `audit_event` row written in its own transaction.
