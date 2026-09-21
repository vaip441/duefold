# Room Administration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Owner or Admin can create a room, and a Room Manager can control its visibility, download policy, default grant expiry, audit retention, purge, counterparties and per-document download exceptions — all through the product, with no hand-written SQL.

**Architecture:** As in milestone 1: every mutation is a `SECURITY DEFINER` function that authorizes, validates and audits in one transaction; routes are thin and `audience: 'member'`; the browser offers a control only where a server-computed capability says the call would be accepted. Migration 022 (`rooms-documents`) fixes the defects that exposing room state and purge would make reachable. Migration 023 (`participants-access`) adds the settings reader and its capabilities, visibility changes (their dry run counts viewer reach, which is participants-access data), and counterparty listing and removal. The room Settings section owns its own state.

**Tech Stack:** Node 26.5.0, TypeScript 5.9.3, Fastify, PostgreSQL (plpgsql `SECURITY DEFINER`), TypeBox, pg, React 19, Base UI dialogs, Vite 8, Vitest 5, Playwright 1.63, axe-core.

**Spec:** `docs/superpowers/specs/2026-09-20-room-admin-surface-design.md` — milestone 2 of 3 (§4.5, §4.6, §5, §6, §7, §10). `DESIGN_SPEC.md` §4.2, §9.3, §9.4, §10.1, §15.4, §15.5 are the product rules these tasks implement.

## Global Constraints

- Node is pinned to **26.5.0**; npm `>=11.0.0`. **No new dependency.**
- Migrations are **one global sequence across all four modules** and **immutable once applied**. This plan uses **`022_room_administration.sql`** (`rooms-documents`) and **`023_room_settings.sql`** (`participants-access`). Later tasks append to them, which is valid only while neither has been applied to a durable database; during development re-run `npm run db:reset`. If either is applied anywhere before this plan finishes, put the remaining SQL in the next free number instead. Gaps in the sequence are allowed (`migrate` checks only that ids are unique and that the applied ledger is a prefix of the registry), so these numbers stand even if milestone 1's 018, 019 and 021 are folded into 017 before it ships.
- Every new function is `SECURITY DEFINER SET search_path=public,pg_temp`, `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO duefold_runtime` (readers and mutations the web calls), and `ALTER FUNCTION ... OWNER TO duefold_migration`. `CREATE OR REPLACE` keeps an existing function's owner and grants.
- **Invariant 14:** the mutation and its `audit_event` row commit in one transaction, inside the function. **Invariant 4:** routes are `audience: 'member'` with no role branch in the handler.
- **Capabilities.** The browser renders a control only where the server said the call would be accepted. Room-level capabilities come from `room_settings_capabilities` (Task 4). Each key mirrors exactly one function's refusals, and a test asserts, per key, that the capability is true exactly when the function accepts. The Settings tab itself is offered on the register row's `canPublish`, which is Room Manager authority.
- **Refusals are SQLSTATEs.** Raise `42501` (forbidden), `22023`/`23514` (invalid), `23505` (duplicate — mapped to 409 from Task 7), `40001` (stale revision), `55000` (wrong state). TypeScript never throws for user input: a plain `Error` reaches the client as HTTP 500. TypeScript throws only when a function that must return a row returned none.
- **Authorize before anything else.** A caller who may not act is told so, not told to sign in again or to reload. Freshness is decided in SQL; wrappers pass `identity.oidcAuthenticatedAt ?? null` exactly as `modules/rooms-documents/src/lifecycle.ts` does and never pre-check with `hasFreshOidc`.
- **Client mutations return `Promise<PresentedFailure | null>`**, where `null` means committed (`committed()` in `workspace/outcome.ts`, Task 8). The dialog that started a mutation owns its pending and failure state and closes when the promise resolves `null`. No shared failure field, no provenance tracking, no change counters. Milestone 1's `AssignmentOutcome` moves onto this in Task 8, so the client keeps one convention.
- **Parsers validate every field** off the wire and fail closed with `ApiError('unavailable')`, as `parseRoom` in `apps/web-client/src/api/rooms.ts` does. No casts of response arrays.
- All user-visible strings go through `translate()` with a key in `apps/web-client/src/i18n/en.ts`. Room state and policy are named in words, never by colour alone.
- Audit and telemetry `detail` carry no full email, token, object key or raw IP (§20.3).
- **Size.** No file over 1000 lines. `RoomView.tsx` (776) and `Workspace.tsx` (494) may each grow by at most 30 lines across the whole milestone; anything more moves into a hook or component. `test/support/browser-server.ts` (1055) must not grow: browser seeding goes in `test/support/room-seeding.ts`. New authz suites take pools, sessions and the app from `test/authz/support/route-fixture.ts` and room seeding from `test/authz/support/room-fixture.ts` (Task 1); none opens its own pools.
- **Comments** state a rule once, where it is owned. No history narration ("used to", "previously", "017 claimed") in new code or migrations; the git log holds history.
- **Every role that can reach a surface, and one that cannot,** is exercised in tests: Owner, Admin, Room Manager, Contributor, plain Member as applicable. Browser accessibility runs axe in **both** light and dark.
- **Running tests on this machine.** `free -h` first; run steps one at a time — the combined `npm run verify` has exhausted memory here. `.env` is not shell-sourceable, so pass it to node:
  - `npm run compose` after any migration, route or declaration change (regenerates `.duefold/generated`);
  - authz: `node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/<file>`;
  - integration: `node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2 test/integration/<file>`;
  - unit: `npx vitest run --project unit --maxWorkers=2 <pattern>`;
  - browser: `node --env-file=.env ./node_modules/@playwright/test/cli.js test test/browser/<file>`.
- **Commits** follow each task only with the user's approval for this plan's execution (AGENTS.md). Without it, stop after the verification step and report.

## File map

| File | Responsibility |
|---|---|
| `modules/rooms-documents/migrations/022_room_administration.sql` | `create_room` text rules, `read_member_room`, purge safety, `document_revision` in the structure reader, `change_room_state` revoked from runtime |
| `modules/participants-access/migrations/023_room_settings.sql` | settings reader + capabilities, download overrides reader, visibility dry run/apply, counterparty list/remove, authorize-first room download policy |
| `modules/rooms-documents/src/routes/room-create.ts` | `POST /api/rooms` |
| `modules/participants-access/src/room-settings.ts` | settings, visibility, policy and counterparty wrappers |
| `modules/participants-access/src/routes/room-settings.ts` | `GET /api/rooms/settings` |
| `modules/participants-access/src/routes/room-visibility.ts` | `POST /api/rooms/visibility` |
| `modules/participants-access/src/routes/policies.ts` | `POST /api/policies` |
| `modules/participants-access/src/routes/counterparties.ts` | `POST /api/counterparties` |
| `test/authz/support/room-fixture.ts` | schema reset with an Owner; member, room, staffing and viewer seeding (pools from `route-fixture.ts`) |
| `test/support/room-seeding.ts` | browser-test room state seeding through `server.migrationPool` |
| `test/authz/room-administration.test.ts` | Tasks 1–3 |
| `test/authz/room-settings.test.ts` | Tasks 4–5 |
| `test/authz/room-policies.test.ts` | Tasks 6–7 |
| `apps/web-client/src/workspace/outcome.ts` | `Outcome<T>` and `settle()` |
| `apps/web-client/src/api/room-settings.ts` | client for settings, visibility, policies, lifecycle |
| `apps/web-client/src/workspace/useOpenRoom.ts` | the open room's register row, by id |
| `apps/web-client/src/workspace/useRoomSettings.ts` | settings load and mutations |
| `apps/web-client/src/workspace/room-settings.ts` | pure copy/derivation helpers for settings |
| `apps/web-client/src/components/NewRoomDialog.tsx` | create a room |
| `apps/web-client/src/components/ConfirmationDialog.tsx` | one dialog for every reviewed or typed confirmation |
| `apps/web-client/src/components/RoomSettingsPanel.tsx` | the Settings section |
| `apps/web-client/src/components/RoomVisibilityControls.tsx` | publish, archive, return to draft |
| `apps/web-client/src/components/RoomPolicyControls.tsx` | room download policy, default grant expiry |
| `apps/web-client/src/components/RoomLifecycleControls.tsx` | retention, purge schedule and cancel |
| `apps/web-client/src/components/DownloadOverrideControl.tsx` | per-document download exception in `StructureTable` |
| `apps/web-client/src/components/GrantChangeForm.tsx` | moved out of `ParticipantsPanel.tsx` |
| `apps/web-client/src/components/CounterpartyControls.tsx` | counterparties, placement, counterparty grants |
| `apps/web-client/src/workspace/views/AccessSection.tsx` | composes `ParticipantsPanel` and `CounterpartyControls` |
| `test/browser/room-administration.spec.ts` | journeys and accessibility |
| `docs/room-administration-http-contract.md` | the HTTP contract, grown task by task |

---

### Task 1: Create a room, and read one room by id

**Files:**
- Create: `modules/rooms-documents/migrations/022_room_administration.sql`
- Modify: `modules/rooms-documents/src/declaration.ts` (migrations array after `020_room_register_paging`; routes array after `room.list`)
- Create: `modules/rooms-documents/src/routes/room-create.ts`
- Modify: `modules/rooms-documents/src/structure.ts:57-73` (`createRoom`)
- Modify: `modules/rooms-documents/src/workspace-reads.ts:166-199` (`readMemberRooms`), add `readMemberRoom`
- Modify: `modules/rooms-documents/src/routes/room-list.ts` (querystring union, handler)
- Create: `test/authz/support/room-fixture.ts`
- Create: `test/authz/room-administration.test.ts`
- Create: `docs/room-administration-http-contract.md`

**Interfaces:**
- Consumes: `create_room` and `valid_structure_text` from `004_room_structure.sql`; `member_can_mutate_room`; `apply_room_assignments(p_member_id,p_assign jsonb,p_revoke jsonb,p_actor_id,p_audit_id,p_correlation_id)` from `021_room_assignment_batch.sql`.
- Produces:
  - `read_member_room(p_actor_id text, p_room_id text) RETURNS TABLE(room_id, title, description, state, revision, working_revision, published_revision, room_role, access_source, can_publish)` — zero rows when the room is unreachable or does not exist.
  - `POST /api/rooms` `{title, description}` → `201 {roomId}`.
  - `GET /api/rooms?roomId=<id>` → `200 {rooms: [MemberRoom] | []}`.
  - `readMemberRoom({pool, identity, roomId}): Promise<MemberRoom | null>` in `workspace-reads.ts`.
  - `resetRoomSchema(organizationName): Promise<ownerId>`, `seedMember(role, label)`, `seedRoom(actorId, title)`, `staffRoom(memberId, roomId, role, actorId)`, `roomRevision(roomId)` and `seedViewerWithRoomGrant(roomId, actorId, label)` in `test/authz/support/room-fixture.ts`, used by every later authz task alongside `app`, `memberSession`, `headers`, `migrationPool`, `databasePool` and `closeRoutePools` from `route-fixture.ts`.

`create_room` is Owner/Admin-gated and audited already. Two things stop it being routable as-is: its title rule accepts whitespace-only and multi-line titles, and `createRoom` pre-validates in TypeScript by throwing plain `Error`s, which the web process maps to **500**. The SQL becomes the single authority and TypeScript stops deciding.

`read_member_room` exists because the frame found the open room's row by searching the loaded register page. A room on an unloaded page — including one just created whose title sorts late — had no row, so every revision-dependent control inside it was disabled.

- [x] **Step 1: Write the room fixture**

The pools, `app()`, `memberSession()` and `headers()` already exist in `test/authz/support/route-fixture.ts`, which the milestone 1 route suites use. The room suites reuse them rather than opening a second set of pools, and add only room seeding.

Create `test/authz/support/room-fixture.ts`:

```ts
/**
 * Room seeding for the room-administration suites, through the same audited functions
 * the product calls. Pools, sessions and the app come from `route-fixture.ts`.
 *
 * The organization and its Owner are inserted in ONE transaction, because
 * `exactly_one_owner_after_member` is a deferred trigger that requires exactly one
 * active Owner whenever an organization exists.
 */
import type { Pool, PoolClient } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { generatedMigrations } from '../../../.duefold/generated/migrations.ts';
import { migrate } from '../../../modules/core-security/src/db/migrate.ts';
import { bootstrapPool, databasePool, migrationPool } from './route-fixture.ts';

async function insertMember(
  client: Pool | PoolClient,
  role: 'owner' | 'admin' | 'member',
  label: string,
): Promise<string> {
  const id = createOpaqueId();
  await client.query(
    `INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
     VALUES ($1,$2,$2,'https://issuer.example',$1,$3,'active')`,
    [id, `${label}@example.test`, role],
  );
  return id;
}

/** Drops and migrates the schema, inserts the organization and its Owner, returns the Owner's id. */
export async function resetRoomSchema(organizationName: string): Promise<string> {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO organization (id,name) VALUES ($1,$2)', [
      createOpaqueId(),
      organizationName,
    ]);
    const ownerId = await insertMember(client, 'owner', 'fixture.owner');
    await client.query('COMMIT');
    return ownerId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function seedMember(role: 'admin' | 'member', label: string): Promise<string> {
  return insertMember(migrationPool, role, label);
}

export async function seedRoom(actorId: string, title: string): Promise<string> {
  const roomId = createOpaqueId();
  await databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
    roomId, title, '', actorId, createOpaqueId(), createCorrelationId(),
  ]);
  return roomId;
}

export async function staffRoom(
  memberId: string,
  roomId: string,
  role: 'manager' | 'contributor',
  actorId: string,
): Promise<void> {
  await databasePool.query('SELECT apply_room_assignments($1,$2::jsonb,$3::jsonb,$4,$5,$6)', [
    memberId,
    JSON.stringify([{ roomId, roomRole: role }]),
    '[]',
    actorId,
    createOpaqueId(),
    createCorrelationId(),
  ]);
}

export async function roomRevision(roomId: string): Promise<number> {
  const revision = (
    await migrationPool.query<{ revision: number }>('SELECT revision FROM room WHERE id=$1', [roomId])
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('room missing');
  return revision;
}

/** An active viewer in the room holding an active whole-room grant. Returns the viewer id. */
export async function seedViewerWithRoomGrant(
  roomId: string,
  actorId: string,
  label: string,
): Promise<string> {
  const viewerId = createOpaqueId();
  await migrationPool.query(
    'INSERT INTO viewer (id,email_key,email_display,session_family_id) VALUES ($1,$2,$2,$3)',
    [viewerId, `${label}@example.test`, createOpaqueId()],
  );
  await databasePool.query('SELECT add_viewer_to_room($1,$2,$3,$4,$5,$6,$7)', [
    createOpaqueId(), viewerId, roomId, actorId, await roomRevision(roomId),
    createOpaqueId(), createCorrelationId(),
  ]);
  const grantId = createOpaqueId();
  const shape = [actorId, roomId, 'grant', grantId, 'viewer', viewerId, null, 'room', null, null, null];
  const impact = (
    await databasePool.query<{ impact: { confirmation: string } }>(
      'SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS impact',
      shape,
    )
  ).rows[0]?.impact;
  if (impact === undefined) throw new Error('grant preview missing');
  await databasePool.query(
    'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
    [...shape, await roomRevision(roomId), new Date(), impact.confirmation,
     createOpaqueId(), createCorrelationId()],
  );
  return viewerId;
}
```

Each suite ends with `afterAll(closeRoutePools)`, which ends the shared pools.

- [x] **Step 2: Write the failing tests**

Create `test/authz/room-administration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  app,
  closeRoutePools,
  databasePool,
  headers,
  memberSession,
  migrationPool,
} from './support/route-fixture.ts';
import {
  resetRoomSchema,
  roomRevision,
  seedMember,
  seedRoom,
  staffRoom,
} from './support/room-fixture.ts';

let ownerId = '';
let adminId = '';
let contributorId = '';
let plainMemberId = '';
let staffedRoomId = '';
let otherRoomId = '';

beforeAll(async () => {
  ownerId = await resetRoomSchema('Room administration');
  adminId = await seedMember('admin', 'room.admin');
  contributorId = await seedMember('member', 'room.contributor');
  plainMemberId = await seedMember('member', 'room.plain');
  staffedRoomId = await seedRoom(ownerId, 'Staffed room');
  otherRoomId = await seedRoom(ownerId, 'Unstaffed room');
  await staffRoom(contributorId, staffedRoomId, 'contributor', ownerId);
});
afterAll(closeRoutePools);

function createRoomAs(actorId: string, title: string, description = '') {
  return databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
    createOpaqueId(), title, description, actorId, createOpaqueId(), createCorrelationId(),
  ]);
}

describe('create_room', () => {
  it('admits an Admin and an Owner', async () => {
    await expect(createRoomAs(adminId, 'Series B')).resolves.toBeDefined();
    await expect(createRoomAs(ownerId, 'Series C')).resolves.toBeDefined();
  });

  it('refuses a plain member', async () => {
    await expect(createRoomAs(plainMemberId, 'Refused')).rejects.toMatchObject({ code: '42501' });
  });

  it.each([['   '], ['Two\nlines'], ['Tab\there'], ['Bell\u0007'], ['Café']])(
    'refuses the title %j as invalid',
    async (title) => {
      await expect(createRoomAs(adminId, title)).rejects.toMatchObject({ code: '22023' });
    },
  );

  it('refuses a description with a control character', async () => {
    await expect(createRoomAs(adminId, 'Fine', 'bad\u0000')).rejects.toMatchObject({ code: '22023' });
  });
});

describe('POST /api/rooms', () => {
  it('creates a draft room, answers 201, and audits the creation', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: headers(await memberSession(adminId)),
      payload: { title: 'Project Atlas', description: 'Sell-side room' },
    });
    expect(response.statusCode).toBe(201);
    const { roomId } = response.json<{ roomId: string }>();
    expect(
      (await migrationPool.query('SELECT title,state FROM room WHERE id=$1', [roomId])).rows[0],
    ).toEqual({ title: 'Project Atlas', state: 'draft' });
    expect(
      (
        await migrationPool.query(
          "SELECT actor_id,reason_code FROM audit_event WHERE event_type='room.create' AND resource_id=$1",
          [roomId],
        )
      ).rows,
    ).toEqual([{ actor_id: adminId, reason_code: 'ROOM_CREATED' }]);
    await instance.close();
  });

  it('answers an unusable title with 400, never 500', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: headers(await memberSession(adminId)),
      payload: { title: '   ', description: '' },
    });
    expect(response.statusCode).toBe(400);
    await instance.close();
  });

  it('refuses a plain member with the uniform 403', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: headers(await memberSession(plainMemberId)),
      payload: { title: 'Refused', description: '' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
    await instance.close();
  });

  it('requires the CSRF header', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: headers(await memberSession(adminId), false),
      payload: { title: 'No token', description: '' },
    });
    expect(response.statusCode).toBe(403);
    await instance.close();
  });
});

describe('GET /api/rooms?roomId=', () => {
  async function readOne(memberId: string, roomId: string) {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: `/api/rooms?roomId=${roomId}`,
      headers: headers(await memberSession(memberId), false),
    });
    await instance.close();
    return response;
  }

  it('returns a staffed Contributor their room, explained as an assignment', async () => {
    const response = await readOne(contributorId, staffedRoomId);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ rooms: unknown[] }>().rooms).toEqual([
      expect.objectContaining({
        roomId: staffedRoomId,
        accessSource: 'assignment',
        roomRole: 'contributor',
        canPublish: false,
      }),
    ]);
  });

  it('returns an Admin any room, explained by the organization role', async () => {
    const response = await readOne(adminId, otherRoomId);
    expect(response.json<{ rooms: unknown[] }>().rooms).toEqual([
      expect.objectContaining({ roomId: otherRoomId, accessSource: 'global_role', canPublish: true }),
    ]);
  });

  it('answers an unreachable room and an unknown id identically', async () => {
    const unreachable = await readOne(contributorId, otherRoomId);
    const unknown = await readOne(contributorId, createOpaqueId());
    expect(unreachable.statusCode).toBe(200);
    expect(unreachable.json()).toStrictEqual({ rooms: [] });
    expect(unknown.json()).toStrictEqual({ rooms: [] });
  });

  it('refuses a roomId combined with a cursor', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: `/api/rooms?roomId=${staffedRoomId}&afterTitle=A&afterRoomId=${staffedRoomId}`,
      headers: headers(await memberSession(adminId), false),
    });
    expect(response.statusCode).toBe(400);
    await instance.close();
  });
});
```

- [x] **Step 3: Run the tests to verify they fail**

```bash
free -h
npm run compose
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-administration.test.ts
```

Expected: FAIL — the whitespace/multi-line titles are accepted, `POST /api/rooms` is 404, and `?roomId=` is 400.

- [x] **Step 4: Write migration 022, part 1**

Create `modules/rooms-documents/migrations/022_room_administration.sql`:

```sql
-- Duefold room administration: room text rules, one-room reads, purge safety, and the
-- document revision structure writers compare. Immutable after application.

-- create_room is the single authority on room text, so an unusable title is a 22023
-- the web process maps to 400. A title is single-line visible text.
CREATE OR REPLACE FUNCTION create_room(
  p_id text,p_title text,p_description text,p_actor_id text,p_audit_id text,p_correlation_id text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM member WHERE id=p_actor_id AND state='active'
                AND global_role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'room creation forbidden' USING ERRCODE='42501';
  END IF;
  IF valid_structure_text(p_title,200,false) IS NOT TRUE
     OR btrim(p_title)='' OR p_title ~ '[\u0009\u000A\u000D]'
     OR valid_structure_text(p_description,4000,true) IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid room text' USING ERRCODE='22023';
  END IF;
  INSERT INTO room(id,title,description) VALUES(p_id,p_title,p_description);
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
                          result,reason_code,correlation_id)
  VALUES(p_audit_id,'room.create','member',p_actor_id,p_id,'room',p_id,'success','ROOM_CREATED',
         p_correlation_id);
END $$;

-- One register row by id, with the columns and provenance rule of read_member_rooms, so an
-- open room never depends on which register page is loaded. Unreachable and unknown rooms
-- both return no row.
CREATE FUNCTION read_member_room(p_actor_id text,p_room_id text)
RETURNS TABLE(room_id text,title text,description text,state text,revision integer,
              working_revision integer,published_revision integer,room_role text,
              access_source text,can_publish boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT r.id,r.title,r.description,r.state,r.revision,r.working_revision,r.published_revision,
         a.room_role,
         CASE WHEN a.room_role IS NOT NULL THEN 'assignment' ELSE 'global_role' END,
         member_can_mutate_room(p_actor_id,r.id,true)
    FROM room r
    LEFT JOIN room_assignment a
      ON a.room_id=r.id AND a.member_id=p_actor_id AND a.state='active'
   WHERE r.id=p_room_id AND member_can_mutate_room(p_actor_id,r.id,false)
$$;

REVOKE ALL ON FUNCTION read_member_room(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_member_room(text,text) TO duefold_runtime;
ALTER FUNCTION read_member_room(text,text) OWNER TO duefold_migration;
```

Register it in `modules/rooms-documents/src/declaration.ts`, after the `020_room_register_paging` entry:

```ts
    { id: '022_room_administration', file: '022_room_administration.sql' },
```

- [x] **Step 5: Let `createRoom` defer to SQL**

In `modules/rooms-documents/src/structure.ts`, delete the two validation calls from `createRoom` (the `validateStructureName` / `validateStructureDescription` functions stay; other writers still use them):

```ts
export async function createRoom(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly title: string;
  readonly description: string;
}): Promise<{ readonly roomId: string }> {
  const roomId = createOpaqueId();
  await input.pool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
    roomId,
    input.title,
    input.description,
    ...parameters(input.identity),
  ]);
  return { roomId };
}
```

- [x] **Step 6: Add the route**

Create `modules/rooms-documents/src/routes/room-create.ts`:

```ts
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { createRoom } from '../structure.ts';

/** Room creation. Owner/Admin authority and every text rule live in `create_room`. */
export const schema = {
  body: Type.Object(
    {
      title: Type.String({ minLength: 1, maxLength: 200 }),
      description: Type.String({ maxLength: 4000 }),
    },
    { additionalProperties: false },
  ),
  response: {
    201: Type.Object(
      { roomId: Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' }) },
      { additionalProperties: false },
    ),
  },
};

interface Body {
  readonly title: string;
  readonly description: string;
}

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Body;
    const created = await createRoom({ pool: runtime.pool, identity, ...body });
    reply.code(201);
    return created;
  };
}
export function handler(): never {
  throw new Error('room create route runtime not initialized');
}
```

Declare it in `modules/rooms-documents/src/declaration.ts`, after the `room.list` entry:

```ts
    {
      id: 'room.create',
      method: 'POST',
      path: '/api/rooms',
      audience: 'member',
      handler: 'routes/room-create.ts',
      handlerFactoryExport: 'createHandler',
    },
```

- [x] **Step 7: Read one room by id**

In `modules/rooms-documents/src/workspace-reads.ts`, lift the row mapping out of `readMemberRooms` into a function both readers use, and add the one-room reader:

```ts
function toMemberRoom(row: Omit<MemberRoomRow, 'continues'>): MemberRoom {
  return {
    roomId: row.room_id,
    title: row.title,
    description: row.description,
    state: row.state,
    revision: row.revision,
    workingRevision: row.working_revision,
    publishedRevision: row.published_revision,
    /* One decision, so a contradictory pair cannot be assembled here. */
    ...roomAccess(row),
    canPublish: row.can_publish,
  };
}

/** One register row, or null when the room is unreachable or unknown — the two are not told apart. */
export async function readMemberRoom(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
}): Promise<MemberRoom | null> {
  const result = await input.pool.query<Omit<MemberRoomRow, 'continues'>>(
    'SELECT * FROM read_member_room($1,$2)',
    [input.identity.id, input.roomId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toMemberRoom(row);
}
```

and in `readMemberRooms` replace the inline object with `const rooms = result.rows.map(toMemberRoom);`. `roomAccess` takes the row type without `continues` too: change its parameter to `Omit<MemberRoomRow, 'continues'>`.

In `modules/rooms-documents/src/routes/room-list.ts`, add a third, closed member to the querystring union and branch on it in the handler:

```ts
const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
```

```ts
  querystring: Type.Union([
    Type.Object({ limit: LIMIT }, { additionalProperties: false }),
    Type.Object(
      {
        limit: LIMIT,
        afterTitle: Type.String({ minLength: 1, maxLength: 200 }),
        afterRoomId: Type.String(),
      },
      { additionalProperties: false },
    ),
    /* One room by id. Closed, so it cannot be combined with a cursor. */
    Type.Object({ roomId: ID }, { additionalProperties: false }),
  ]),
```

```ts
interface Query {
  readonly limit?: string;
  readonly afterTitle?: string;
  readonly afterRoomId?: string;
  readonly roomId?: string;
}
```

At the top of the handler body, after `const query = request.query as Query;`:

```ts
    if (query.roomId !== undefined) {
      const room = await readMemberRoom({ pool: runtime.pool, identity, roomId: query.roomId });
      return { rooms: room === null ? [] : [room] };
    }
```

and add `readMemberRoom` to the import from `../workspace-reads.ts`.

- [x] **Step 8: Start the HTTP contract**

Create `docs/room-administration-http-contract.md`:

````markdown
# Room administration HTTP contract

Every route is declared `audience: 'member'` and carries no role branch in its handler.
Authority, validation, optimistic concurrency, typed confirmation, OIDC freshness and the
audit row are decided inside `SECURITY DEFINER` functions in
`022_room_administration.sql` (`rooms-documents`) and `023_room_settings.sql`
(`participants-access`), which commit the mutation and its `audit_event` row in one
transaction (`DESIGN_SPEC.md` §15.1, invariant 14).

IDs are opaque 32-character values; instants are RFC 3339 UTC. Every body schema is closed.
Refusals follow `apps/web/src/failure-mapping.ts`: 403 uniform, 403
`FRESH_AUTHENTICATION_REQUIRED` for a stale sign-in on a change that needs a fresh one,
400 invalid, 409 stale or wrong state. Database wording is never forwarded.

## `POST /api/rooms`

```
{title, description}  →  201 {roomId}
```

Owner/Admin, enforced by `create_room`. The room starts in `draft`. A title is 1–200
characters of NFC, single-line text that is not only spaces; a description is up to 4000
characters of NFC plain text. Both rules live in `create_room` and a violation is `400`.

## `GET /api/rooms?roomId=<id>`

```
200 {rooms: [room] | []}
```

One register row, in the same shape as a page of `GET /api/rooms`. An unreachable room
and an unknown id both answer `{rooms: []}`. `roomId` cannot be combined with a cursor.
````

- [x] **Step 9: Run the tests to verify they pass**

```bash
npm run compose
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-administration.test.ts
npx vitest run --project unit --maxWorkers=2 room-list
npm run typecheck && npm run lint
```

Expected: PASS.

- [x] **Step 10: Commit**

```bash
git add modules/rooms-documents test/authz/support/room-fixture.ts test/authz/room-administration.test.ts docs/room-administration-http-contract.md
git commit -m "Create rooms over HTTP and read one room by id"
```

---

### Task 2: A live purge pins its room; a cancelled purge frees it

**Files:**
- Modify: `modules/rooms-documents/migrations/022_room_administration.sql` (append)
- Test: `test/authz/room-administration.test.ts` (extend)
- Modify: `docs/room-administration-http-contract.md` (append)

**Interfaces:**
- Consumes: `room_purge`, `dry_run_room_purge`, `schedule_room_purge`, `cancel_room_purge` from `011_retention_lifecycle.sql`.
- Produces: trigger `live_purge_pins_archive` on `room`; partial unique index `one_uncancelled_room_purge`; `dry_run_room_purge` now refuses a room that already has an uncancelled purge (`55000`) and returns the constant confirmation `SCHEDULE ROOM PURGE`.

Three defects become reachable the moment room state and purge have routes:

1. Nothing stops an archived room with a scheduled purge from being returned to draft and published again. The purge job checks the purge row, not the room, so 30 days later it deletes a room that is back in service.
2. `room_purge.room_id` is `UNIQUE`, so a cancelled purge blocks every later schedule. The collision surfaces as an unmapped `23505`, i.e. HTTP 500.
3. The phrase `SCHEDULE PURGE FOR ROOM <32-character id>` is untypeable, which invites pasting and defeats the friction.

- [x] **Step 1: Write the failing tests**

Append to `test/authz/room-administration.test.ts`:

```ts
describe('purge safety', () => {
  let roomId = '';

  async function archive(id: string): Promise<void> {
    await migrationPool.query(
      "UPDATE room SET state='archived',revision=revision+1 WHERE id=$1",
      [id],
    );
  }

  async function schedule(id: string, confirmation = 'SCHEDULE ROOM PURGE'): Promise<string> {
    const purgeId = createOpaqueId();
    await databasePool.query('SELECT schedule_room_purge($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
      purgeId, ownerId, id, new Date(), await roomRevision(id), confirmation,
      `system/deletion-markers/v1/${id}/${purgeId}.json`,
      createOpaqueId(), createOpaqueId(), createCorrelationId(),
    ]);
    return purgeId;
  }

  async function cancel(purgeId: string): Promise<void> {
    await databasePool.query('SELECT cancel_room_purge($1,$2,$3,$4,$5)', [
      purgeId, ownerId, 'CANCEL ROOM PURGE', createOpaqueId(), createCorrelationId(),
    ]);
  }

  beforeAll(async () => {
    roomId = await seedRoom(ownerId, 'Purge candidate');
    await archive(roomId);
  });

  it('offers a phrase a person can type', async () => {
    const impact = (
      await databasePool.query<{ impact: { confirmation: string } }>(
        'SELECT dry_run_room_purge($1,$2) AS impact',
        [ownerId, roomId],
      )
    ).rows[0]?.impact;
    expect(impact?.confirmation).toBe('SCHEDULE ROOM PURGE');
  });

  it('pins the room to archived while the purge is live', async () => {
    const purgeId = await schedule(roomId);
    await expect(
      migrationPool.query("UPDATE room SET state='draft' WHERE id=$1", [roomId]),
    ).rejects.toMatchObject({ code: '55000' });

    await expect(
      databasePool.query('SELECT dry_run_room_purge($1,$2)', [ownerId, roomId]),
    ).rejects.toMatchObject({ code: '55000' });

    await cancel(purgeId);
    await migrationPool.query(
      "UPDATE room SET state='draft',revision=revision+1 WHERE id=$1",
      [roomId],
    );
    expect(
      (await migrationPool.query('SELECT state FROM room WHERE id=$1', [roomId])).rows[0],
    ).toEqual({ state: 'draft' });
  });

  it('lets a cancelled purge be scheduled again', async () => {
    const again = await seedRoom(ownerId, 'Rescheduled');
    await archive(again);
    await cancel(await schedule(again));
    const second = await schedule(again);
    expect(
      (
        await migrationPool.query(
          'SELECT state FROM room_purge WHERE room_id=$1 ORDER BY scheduled_at',
          [again],
        )
      ).rows.map(({ state }: { state: string }) => state),
    ).toEqual(['cancelled', 'scheduled']);
    await cancel(second);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

```bash
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-administration.test.ts -t "purge safety"
```

Expected: FAIL — the phrase is the id-bearing one, the state change succeeds, and rescheduling raises `23505`.

- [x] **Step 3: Append the purge rules to migration 022**

```sql
-- A live purge pins its room to archived. Returning the room to service requires
-- cancelling the purge first; otherwise the job deletes a room that is back in use.
CREATE FUNCTION enforce_live_purge_pins_archive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.state='archived' AND NEW.state<>'archived' AND EXISTS(
       SELECT 1 FROM room_purge p
        WHERE p.room_id=NEW.id AND p.state IN ('scheduled','marker_pending','purging')) THEN
    RAISE EXCEPTION 'room is pinned by a live purge' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER live_purge_pins_archive BEFORE UPDATE OF state ON room
FOR EACH ROW EXECUTE FUNCTION enforce_live_purge_pins_archive();
REVOKE ALL ON FUNCTION enforce_live_purge_pins_archive() FROM PUBLIC;
ALTER FUNCTION enforce_live_purge_pins_archive() OWNER TO duefold_migration;

-- A cancelled purge no longer holds its room.
ALTER TABLE room_purge DROP CONSTRAINT room_purge_room_id_key;
CREATE UNIQUE INDEX one_uncancelled_room_purge ON room_purge(room_id) WHERE state<>'cancelled';

-- The room is bound by id and expected revision, so the phrase is a constant a person can
-- type. A room that already holds a purge is refused here, before the unique index would.
CREATE OR REPLACE FUNCTION dry_run_room_purge(p_actor_id text,p_room_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE impact jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM member WHERE id=p_actor_id AND state='active' AND global_role='owner') THEN
    RAISE EXCEPTION 'owner required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM room WHERE id=p_room_id AND state='archived') THEN
    RAISE EXCEPTION 'room must be archived' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM room_purge WHERE room_id=p_room_id AND state<>'cancelled') THEN
    RAISE EXCEPTION 'room already holds a purge' USING ERRCODE='55000';
  END IF;
  SELECT jsonb_build_object('roomId',p_room_id,
    'documentCount',(SELECT count(*) FROM document WHERE room_id=p_room_id),
    'viewerCount',(SELECT count(*) FROM viewer_room_membership WHERE room_id=p_room_id),
    'sourceBytes',(SELECT COALESCE(sum(v.size_bytes),0) FROM document d
                     JOIN document_version v ON v.document_id=d.id WHERE d.room_id=p_room_id),
    'cancellationDays',30,'confirmation','SCHEDULE ROOM PURGE') INTO impact;
  RETURN impact;
END $$;
```

`dry_run_room_purge` reads `viewer_room_membership`, a participants-access table, in its 011 form already; this keeps that body and changes only the phrase and the uncancelled-purge refusal. Do not widen it further.

- [x] **Step 4: Append to the contract**

````markdown
## Purge and room state

A room whose purge is `scheduled`, `marker_pending` or `purging` cannot leave `archived`:
returning it to draft answers `409` until the Owner cancels the purge. A cancelled purge no
longer holds its room, so the room can be scheduled again. The purge confirmation is the
constant `SCHEDULE ROOM PURGE`; the room is bound by id and expected revision.
````

- [x] **Step 5: Run the tests to verify they pass, and that retention still does**

```bash
npm run compose
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-administration.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2 test/integration/retention-lifecycle.test.ts
```

Expected: PASS. The retention suite reads the phrase from the dry run, so it needs no edit; if a case hard-codes the old phrase, update it to `SCHEDULE ROOM PURGE`.

- [x] **Step 6: Commit**

```bash
git add modules/rooms-documents/migrations/022_room_administration.sql test/authz/room-administration.test.ts docs/room-administration-http-contract.md
git commit -m "Pin a room to archived while its purge is live"
```

---

### Task 3: The structure reader returns the document revision

**Files:**
- Modify: `modules/rooms-documents/migrations/022_room_administration.sql` (append)
- Modify: `modules/rooms-documents/src/workspace-reads.ts:201-264` (`WorkingStructureEntry`, `readWorkingStructure`)
- Modify: `modules/rooms-documents/src/routes/room-workspace.ts:34-55` (entry schema)
- Modify: `apps/web-client/src/api/rooms.ts:56-72, 227-244` (`WorkingEntry`, `loadRoomWorkspace`)
- Modify: `apps/web-client/src/components/StructureControls.tsx:37-41, 320-330` (`MetadataInput`, `MetadataFormProps`)
- Modify: `apps/web-client/src/components/StructureTable.tsx:335` (narrow before `MetadataForm`)
- Modify: `apps/web-client/src/workspace/views/RoomView.tsx:645`
- Test: `test/authz/room-administration.test.ts` (extend), `apps/web-client/src/api/rooms.unit.test.ts` (extend)

**Interfaces:**
- Consumes: `read_member_working_structure` from `006_member_workspace_readers.sql`; `set_document_download_policy` from `007_participant_grants.sql`.
- Produces: `read_member_working_structure` gains `document_revision integer` (NULL for folders), directly after `revision`. The client `WorkingEntry` becomes a union on `resourceKind`: a `DocumentEntry` carries `documentRevision: number`, a `FolderEntry` carries `documentRevision: null`. `export type DocumentEntry` is used by Task 12.

`update_document_metadata` compares `document.revision`, but the client sends the **entry** revision (`RoomView.tsx:645`). They agree today only because every writer bumps both. `set_document_download_policy` bumps the document alone, so after one download override every metadata edit of that document fails as stale, permanently. This task must land before Task 12 exposes overrides.

- [x] **Step 1: Write the failing server test**

Append to `test/authz/room-administration.test.ts`:

```ts
describe('document revision in the working structure', () => {
  it('reports the revision update_document_metadata compares, after they diverge', async () => {
    const roomId = await seedRoom(ownerId, 'Revision room');
    const entryId = createOpaqueId();
    const documentId = createOpaqueId();
    await databasePool.query('SELECT create_document_entry($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      entryId, documentId, null, 'Teaser', 1, ownerId,
      (await migrationPool.query<{ working_revision: number }>(
        'SELECT working_revision FROM room WHERE id=$1', [roomId],
      )).rows[0]?.working_revision,
      createOpaqueId(), createCorrelationId(),
    ]);
    await databasePool.query('SELECT set_document_download_policy($1,$2,$3,$4,$5,$6)', [
      ownerId, documentId, 'allow', 1, createOpaqueId(), createCorrelationId(),
    ]);

    const entry = (
      await databasePool.query<{ revision: number; document_revision: number | null }>(
        'SELECT revision,document_revision FROM read_member_working_structure($1,$2) WHERE entry_id=$3',
        [ownerId, roomId, entryId],
      )
    ).rows[0];
    expect(entry).toEqual({ revision: 1, document_revision: 2 });

    const working = (
      await migrationPool.query<{ working_revision: number }>(
        'SELECT working_revision FROM room WHERE id=$1', [roomId],
      )
    ).rows[0]?.working_revision;
    await expect(
      databasePool.query('SELECT * FROM update_document_metadata($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        documentId, 'Teaser v2', '', null, ownerId, entry?.document_revision, working,
        createOpaqueId(), createCorrelationId(),
      ]),
    ).resolves.toBeDefined();
  });
});
```

- [x] **Step 2: Write the failing client test**

In `apps/web-client/src/api/rooms.unit.test.ts`, add (reuse the file's existing `fetch` stub helper; if it has none, stub `globalThis.fetch` with `vi.fn().mockResolvedValue(new Response(JSON.stringify(body)))` as the file's other cases do):

```ts
describe('loadRoomWorkspace', () => {
  const base = {
    entryId: 'e'.repeat(32), resourceId: 'r'.repeat(32), parentFolderId: null,
    displayName: 'Teaser', description: '', revision: 1, stagedRemoved: false, depth: 0,
    position: 1, canMoveUp: false, canMoveDown: false, changeKinds: [],
    hasPublishableVersion: true, isPublished: false,
  };

  it('keeps a document revision that differs from the entry revision', async () => {
    stubJson({ entries: [{ ...base, resourceKind: 'document', documentRevision: 4 }], trash: [], retentionDays: 30 });
    const { entries } = await loadRoomWorkspace('x'.repeat(32));
    expect(entries[0]).toMatchObject({ resourceKind: 'document', revision: 1, documentRevision: 4 });
  });

  it.each([
    [{ ...base, resourceKind: 'document', documentRevision: null }],
    [{ ...base, resourceKind: 'folder', documentRevision: 2 }],
  ])('fails closed on a revision that contradicts the kind', async (entry) => {
    stubJson({ entries: [entry], trash: [], retentionDays: 30 });
    await expect(loadRoomWorkspace('x'.repeat(32))).rejects.toMatchObject({ failure: 'unavailable' });
  });
});
```

- [x] **Step 3: Run both to verify they fail**

```bash
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-administration.test.ts -t "document revision"
npx vitest run --project unit --maxWorkers=2 rooms.unit
```

Expected: FAIL — `column "document_revision" does not exist`; the client casts entries and accepts contradictions.

- [x] **Step 4: Append the reader change to migration 022**

The return type changes, so the function is dropped and recreated. The body is `006_member_workspace_readers.sql:115-165` with one output column and one select item added:

```sql
-- The structure reader returns the revision document writers compare. The entry revision
-- and the document revision are distinct counters and a download override moves only the
-- second.
DROP FUNCTION read_member_working_structure(text,text);
CREATE FUNCTION read_member_working_structure(p_actor_id text,p_room_id text)
RETURNS TABLE(entry_id text,resource_kind text,resource_id text,parent_folder_id text,
  display_name text,description text,revision integer,document_revision integer,
  staged_removed boolean,depth integer,sibling_position integer,can_move_up boolean,
  can_move_down boolean,change_kinds text[],has_publishable_version boolean,is_published boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH RECURSIVE authorized AS (
    SELECT member_can_mutate_room(p_actor_id,p_room_id,false) allowed
  ), tree AS (
    SELECT e.*,0 AS depth FROM working_structure_entry e
    WHERE e.room_id=p_room_id AND e.parent_folder_id IS NULL
      AND (SELECT allowed FROM authorized)
    UNION ALL
    SELECT child.*,parent.depth+1 FROM tree parent JOIN working_structure_entry child
      ON child.parent_folder_id=parent.folder_id
    WHERE child.room_id=p_room_id AND parent.depth<5
  ), ordered AS (
    SELECT t.*,
      CASE WHEN t.staged_removed THEN NULL ELSE row_number() OVER (
        PARTITION BY t.parent_folder_id,t.staged_removed ORDER BY t.order_key,t.id
      )::integer END sibling_position,
      count(*) FILTER (WHERE NOT t.staged_removed) OVER (
        PARTITION BY t.parent_folder_id
      )::integer sibling_count
    FROM tree t
  )
  SELECT o.id,
    CASE WHEN o.folder_id IS NOT NULL THEN 'folder' ELSE 'document' END,
    COALESCE(o.folder_id,o.document_id),o.parent_folder_id,o.display_name,
    CASE WHEN o.folder_id IS NOT NULL THEN f.description ELSE d.description END,
    o.revision,d.revision,o.staged_removed,o.depth,o.sibling_position,
    COALESCE(o.sibling_position>1,false),
    COALESCE(o.sibling_position<o.sibling_count,false),
    COALESCE(c.changes,ARRAY[]::text[]),
    o.folder_id IS NOT NULL OR (d.working_version_id IS NOT NULL
      AND version_has_publication_evidence(d.working_version_id,d.id)),
    EXISTS(SELECT 1 FROM published_structure_entry p
      WHERE p.room_id=p_room_id AND p.entry_id=o.id)
  FROM ordered o
  LEFT JOIN folder f ON f.id=o.folder_id
  LEFT JOIN document d ON d.id=o.document_id
  LEFT JOIN publication_change_set(p_room_id) c ON c.entry_id=o.id
  ORDER BY o.depth,o.parent_folder_id NULLS FIRST,o.sibling_position,o.id
$$;
REVOKE ALL ON FUNCTION read_member_working_structure(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_member_working_structure(text,text) TO duefold_runtime;
ALTER FUNCTION read_member_working_structure(text,text) OWNER TO duefold_migration;
```

Before writing it, diff the body against the current definition (`git grep -n "read_member_working_structure" modules/*/migrations`) — if any migration after 006 replaced it, copy that body instead.

- [x] **Step 5: Carry the field through the server**

In `modules/rooms-documents/src/workspace-reads.ts`, add `readonly documentRevision: number | null;` to `WorkingStructureEntry` after `revision`, `readonly document_revision: number | null;` to its row type, and `documentRevision: row.document_revision,` to the mapping after `revision`. In `modules/rooms-documents/src/routes/room-workspace.ts`, add to the entry object after `revision`:

```ts
              documentRevision: Type.Union([Type.Integer(), Type.Null()]),
```

- [x] **Step 6: Make the client entry a union and parse it**

In `apps/web-client/src/api/rooms.ts`, replace `export interface WorkingEntry {...}` with:

```ts
interface EntryFacts {
  readonly entryId: string;
  readonly resourceId: string;
  readonly parentFolderId: string | null;
  readonly displayName: string;
  readonly description: string;
  /** The structure entry's revision, which structure mutations compare. */
  readonly revision: number;
  readonly stagedRemoved: boolean;
  readonly depth: number;
  readonly position: number;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly changeKinds: readonly PublicationChangeKind[];
  readonly hasPublishableVersion: boolean;
  readonly isPublished: boolean;
}
export type FolderEntry = EntryFacts & {
  readonly resourceKind: 'folder';
  readonly documentRevision: null;
};
/** `documentRevision` is what document metadata and download policy writers compare. */
export type DocumentEntry = EntryFacts & {
  readonly resourceKind: 'document';
  readonly documentRevision: number;
};
export type WorkingEntry = FolderEntry | DocumentEntry;

const CHANGE_KINDS: readonly PublicationChangeKind[] = [
  'add', 'remove', 'rename', 'move', 'reorder', 'description', 'version', 'replace',
];

function parseEntry(value: unknown): WorkingEntry {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const changeKinds = requireArray(value, 'changeKinds');
  if (!changeKinds.every((kind) => (CHANGE_KINDS as readonly unknown[]).includes(kind)))
    throw new ApiError('unavailable');
  const parent = value['parentFolderId'];
  if (parent !== null && typeof parent !== 'string') throw new ApiError('unavailable');
  for (const key of ['stagedRemoved', 'canMoveUp', 'canMoveDown', 'hasPublishableVersion', 'isPublished'])
    if (typeof value[key] !== 'boolean') throw new ApiError('unavailable');
  if (typeof value['description'] !== 'string') throw new ApiError('unavailable');
  const facts: EntryFacts = {
    entryId: requireString(value, 'entryId'),
    resourceId: requireString(value, 'resourceId'),
    parentFolderId: parent,
    displayName: requireString(value, 'displayName'),
    description: value['description'],
    revision: requireNumber(value, 'revision'),
    stagedRemoved: value['stagedRemoved'] as boolean,
    depth: requireNumber(value, 'depth'),
    position: requireNumber(value, 'position'),
    canMoveUp: value['canMoveUp'] as boolean,
    canMoveDown: value['canMoveDown'] as boolean,
    changeKinds: changeKinds as readonly PublicationChangeKind[],
    hasPublishableVersion: value['hasPublishableVersion'] as boolean,
    isPublished: value['isPublished'] as boolean,
  };
  const documentRevision = value['documentRevision'];
  if (value['resourceKind'] === 'document' && typeof documentRevision === 'number')
    return { ...facts, resourceKind: 'document', documentRevision };
  if (value['resourceKind'] === 'folder' && documentRevision === null)
    return { ...facts, resourceKind: 'folder', documentRevision: null };
  throw new ApiError('unavailable');
}
```

Check the `PublicationChangeKind` union at the top of the file and make `CHANGE_KINDS` list exactly its members. In `loadRoomWorkspace`, replace the cast with `entries: requireArray(payload, 'entries').map(parseEntry),`.

- [x] **Step 7: Send the document revision**

In `apps/web-client/src/components/StructureControls.tsx`, change `MetadataInput.entry` and `MetadataFormProps.entry` to `DocumentEntry` (import it from `../api/client.ts`; add `DocumentEntry`, `FolderEntry` to the `rooms.ts` re-export in `client.ts`). In `StructureTable.tsx:335`, narrow before rendering the form:

```tsx
                    {editingMetadata === entry.entryId &&
                    onMetadata !== undefined &&
                    entry.resourceKind === 'document' ? (
```

In `RoomView.tsx:645`, send the document's own counter:

```ts
                    expectedDocumentRevision: input.entry.documentRevision,
```

Then add `documentRevision` to every `WorkingEntry` fixture the compiler now rejects — `null` for folders, the fixture's `revision` for documents:

```bash
npm run typecheck 2>&1 | grep -E "documentRevision|WorkingEntry" | cut -d'(' -f1 | sort -u
```

- [x] **Step 8: Run the tests to verify they pass**

```bash
npm run compose
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-administration.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/workspace-readers.test.ts
npx vitest run --project unit --maxWorkers=2
npm run typecheck && npm run lint
```

Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add modules/rooms-documents apps/web-client/src test/authz/room-administration.test.ts
git commit -m "Send the document revision that document writers compare"
```

---
### Task 4: Room settings reader and its capabilities

**Files:**
- Create: `modules/participants-access/migrations/023_room_settings.sql`
- Modify: `modules/participants-access/src/declaration.ts` (migrations; routes)
- Create: `modules/participants-access/src/room-settings.ts`
- Create: `modules/participants-access/src/routes/room-settings.ts`
- Create: `test/authz/room-settings.test.ts`
- Modify: `docs/room-administration-http-contract.md` (append)

**Interfaces:**
- Consumes: `member_can_mutate_room`; `room`, `room_purge` (rooms-documents); `organization.installation_download_policy`, `room.download_policy`, `room.default_grant_expires_at`, `document.download_policy` (participants-access columns from 007).
- Produces:
  - `room_settings_capabilities(p_actor_id text, p_room_id text) RETURNS jsonb` — `{publish, archive, returnToDraft, setRetention, schedulePurge, cancelPurge}`, all booleans.
  - `read_room_settings(p_actor_id text, p_room_id text) RETURNS TABLE(room_id, state, revision, published_revision, audit_retention_years smallint, default_grant_expires_at, download_policy, installation_download_policy, purge_id, purge_state, purge_after, capabilities jsonb)` — Room Manager; `42501` otherwise, identical for an unknown room.
  - `read_room_download_overrides(p_actor_id text, p_room_id text) RETURNS TABLE(document_id text, download_policy text)` — Room Manager; only documents with an explicit policy.
  - `readRoomSettings({pool, identity, roomId}): Promise<RoomSettingsRead>` in `room-settings.ts`, with the exported types `RoomSettings`, `RoomCapabilities`, `DownloadOverride`, `DownloadPolicy`, `RoomState`, `PurgeState`.
  - `GET /api/rooms/settings?roomId=` → `200 {settings, downloadOverrides}`.

Each capability mirrors exactly one function's refusals, and the Settings surface renders a control only where its key is true. `publish`, `archive` and `returnToDraft` mirror `apply_room_visibility`, which Task 5 adds; their mirror test lives there.

- [x] **Step 1: Write the failing tests**

Create `test/authz/room-settings.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  app,
  closeRoutePools,
  databasePool,
  headers,
  memberSession,
  migrationPool,
} from './support/route-fixture.ts';
import {
  resetRoomSchema,
  roomRevision,
  seedMember,
  seedRoom,
  seedViewerWithRoomGrant,
  staffRoom,
} from './support/room-fixture.ts';

let ownerId = '';
let adminId = '';
let managerId = '';
let contributorId = '';
let plainMemberId = '';
let roomId = '';

beforeAll(async () => {
  ownerId = await resetRoomSchema('Room settings');
  adminId = await seedMember('admin', 'settings.admin');
  managerId = await seedMember('member', 'settings.manager');
  contributorId = await seedMember('member', 'settings.contributor');
  plainMemberId = await seedMember('member', 'settings.plain');
  roomId = await seedRoom(ownerId, 'Settings room');
  await staffRoom(managerId, roomId, 'manager', ownerId);
  await staffRoom(contributorId, roomId, 'contributor', ownerId);
});
afterAll(closeRoutePools);

interface SettingsRow {
  readonly state: string;
  readonly download_policy: string | null;
  readonly installation_download_policy: string;
  readonly purge_id: string | null;
  readonly capabilities: Record<string, boolean>;
}

async function settingsAs(memberId: string, id = roomId): Promise<SettingsRow> {
  const row = (
    await databasePool.query<SettingsRow>('SELECT * FROM read_room_settings($1,$2)', [memberId, id])
  ).rows[0];
  if (row === undefined) throw new Error('no settings row');
  return row;
}

async function setState(id: string, state: 'draft' | 'published' | 'archived'): Promise<void> {
  await migrationPool.query('UPDATE room SET state=$2,revision=revision+1 WHERE id=$1', [id, state]);
}

async function schedulePurge(id: string): Promise<string> {
  const purgeId = createOpaqueId();
  await databasePool.query('SELECT schedule_room_purge($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
    purgeId, ownerId, id, new Date(), await roomRevision(id), 'SCHEDULE ROOM PURGE',
    `system/deletion-markers/v1/${id}/${purgeId}.json`,
    createOpaqueId(), createOpaqueId(), createCorrelationId(),
  ]);
  return purgeId;
}

async function cancelPurge(purgeId: string): Promise<void> {
  await databasePool.query('SELECT cancel_room_purge($1,$2,$3,$4,$5)', [
    purgeId, ownerId, 'CANCEL ROOM PURGE', createOpaqueId(), createCorrelationId(),
  ]);
}

describe('read_room_settings', () => {
  it.each([['Owner'], ['Admin'], ['Room Manager']])('answers the %s', async (who) => {
    const actor = { Owner: ownerId, Admin: adminId, 'Room Manager': managerId }[who] ?? '';
    const row = await settingsAs(actor);
    expect(row).toMatchObject({
      state: 'draft',
      download_policy: null,
      installation_download_policy: 'deny',
      purge_id: null,
    });
  });

  it('refuses a Contributor, a plain member, and an unknown room alike', async () => {
    await expect(settingsAs(contributorId)).rejects.toMatchObject({ code: '42501' });
    await expect(settingsAs(plainMemberId)).rejects.toMatchObject({ code: '42501' });
    await expect(settingsAs(ownerId, createOpaqueId())).rejects.toMatchObject({ code: '42501' });
  });
});

describe('room_settings_capabilities', () => {
  it('offers a Manager archiving but not publication before any structure is published', async () => {
    expect((await settingsAs(managerId)).capabilities).toStrictEqual({
      publish: false,
      archive: true,
      returnToDraft: false,
      setRetention: false,
      schedulePurge: false,
      cancelPurge: false,
    });
  });

  it('offers the Owner retention while draft, and publication once structure is published', async () => {
    const id = await seedRoom(ownerId, 'Publishable');
    await migrationPool.query('UPDATE room SET published_revision=1 WHERE id=$1', [id]);
    expect((await settingsAs(ownerId, id)).capabilities).toMatchObject({
      publish: true,
      setRetention: true,
    });
    expect((await settingsAs(adminId, id)).capabilities).toMatchObject({
      publish: true,
      setRetention: false,
    });
  });

  it('offers purge on an archived room, then only cancellation while it is live', async () => {
    const id = await seedRoom(ownerId, 'Archived');
    await setState(id, 'archived');
    expect((await settingsAs(ownerId, id)).capabilities).toMatchObject({
      schedulePurge: true,
      cancelPurge: false,
      returnToDraft: true,
    });
    const purgeId = await schedulePurge(id);
    expect((await settingsAs(ownerId, id)).capabilities).toMatchObject({
      schedulePurge: false,
      cancelPurge: true,
      returnToDraft: false,
    });
    expect((await settingsAs(adminId, id)).capabilities).toMatchObject({
      schedulePurge: false,
      cancelPurge: false,
    });
    await cancelPurge(purgeId);
    expect((await settingsAs(ownerId, id)).capabilities).toMatchObject({ schedulePurge: true });
  });

  it('mirrors apply_audit_retention: setRetention is true exactly when the call is accepted', async () => {
    for (const actor of [ownerId, adminId, managerId]) {
      const id = await seedRoom(ownerId, `Retention ${actor.slice(0, 6)}`);
      await staffRoom(managerId, id, 'manager', ownerId);
      const offered = (await settingsAs(actor, id)).capabilities['setRetention'];
      const accepted = await databasePool
        .query('SELECT apply_audit_retention($1,$2,$3,$4,$5,$6,$7,$8)', [
          actor, id, 5, new Date(), await roomRevision(id), 'SET AUDIT RETENTION TO 5 YEARS',
          createOpaqueId(), createCorrelationId(),
        ])
        .then(() => true, () => false);
      expect(accepted).toBe(offered);
    }
  });
});

describe('GET /api/rooms/settings', () => {
  it('returns settings and the document download overrides to a Room Manager', async () => {
    const documentId = createOpaqueId();
    await databasePool.query('SELECT create_document_entry($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      createOpaqueId(), documentId, null, 'Management accounts', 1, managerId,
      (await migrationPool.query<{ working_revision: number }>(
        'SELECT working_revision FROM room WHERE id=$1', [roomId],
      )).rows[0]?.working_revision,
      createOpaqueId(), createCorrelationId(),
    ]);
    await databasePool.query('SELECT set_document_download_policy($1,$2,$3,$4,$5,$6)', [
      managerId, documentId, 'allow', 1, createOpaqueId(), createCorrelationId(),
    ]);
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: `/api/rooms/settings?roomId=${roomId}`,
      headers: headers(await memberSession(managerId), false),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      settings: Record<string, unknown>;
      downloadOverrides: unknown[];
    }>();
    expect(body.settings).toMatchObject({
      roomId,
      state: 'draft',
      downloadPolicy: null,
      installationDownloadPolicy: 'deny',
      purge: null,
      auditRetentionYears: 7,
    });
    expect(body.downloadOverrides).toStrictEqual([{ documentId, policy: 'allow' }]);
    await instance.close();
  });

  it('refuses a Contributor with the uniform 403', async () => {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: `/api/rooms/settings?roomId=${roomId}`,
      headers: headers(await memberSession(contributorId), false),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
    await instance.close();
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

```bash
npm run compose
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-settings.test.ts
```

Expected: FAIL with `function read_room_settings(unknown, unknown) does not exist`.

- [x] **Step 3: Write migration 023, part 1**

Create `modules/participants-access/migrations/023_room_settings.sql`:

```sql
-- Duefold room settings, visibility, and counterparties. Immutable after application.

/*
 * What the actor may change about this room. Each key mirrors exactly one function's
 * refusals, so a control the surface offers and a call the database accepts cannot
 * drift:
 *
 *   publish        apply_room_visibility(published): Room Manager; room is draft; its
 *                  structure has been published at least once.
 *   archive        apply_room_visibility(archived): Room Manager; room is draft or published.
 *   returnToDraft  apply_room_visibility(draft): Room Manager; room is published or
 *                  archived; no live purge pins it.
 *   setRetention   apply_audit_retention: Owner; room is draft.
 *   schedulePurge  schedule_room_purge: Owner; room is archived; no uncancelled purge.
 *   cancelPurge    cancel_room_purge: Owner; a scheduled purge inside its window.
 */
CREATE FUNCTION room_settings_capabilities(p_actor_id text,p_room_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object(
    'publish', facts.is_manager AND r.state='draft' AND r.published_revision>0,
    'archive', facts.is_manager AND r.state IN ('draft','published'),
    'returnToDraft', facts.is_manager AND r.state IN ('published','archived') AND NOT facts.pinned,
    'setRetention', facts.is_owner AND r.state='draft',
    'schedulePurge', facts.is_owner AND r.state='archived' AND NOT facts.purge_held,
    'cancelPurge', facts.is_owner AND facts.cancellable)
  FROM room r
  CROSS JOIN LATERAL (
    SELECT
      member_can_mutate_room(p_actor_id,r.id,true) AS is_manager,
      EXISTS(SELECT 1 FROM member m
              WHERE m.id=p_actor_id AND m.state='active' AND m.global_role='owner') AS is_owner,
      EXISTS(SELECT 1 FROM room_purge p WHERE p.room_id=r.id
                AND p.state IN ('scheduled','marker_pending','purging')) AS pinned,
      EXISTS(SELECT 1 FROM room_purge p WHERE p.room_id=r.id AND p.state<>'cancelled') AS purge_held,
      EXISTS(SELECT 1 FROM room_purge p WHERE p.room_id=r.id AND p.state='scheduled'
                AND p.purge_after>statement_timestamp()) AS cancellable
  ) facts
  WHERE r.id=p_room_id
$$;

CREATE FUNCTION read_room_settings(p_actor_id text,p_room_id text)
RETURNS TABLE(room_id text,state text,revision integer,published_revision integer,
              audit_retention_years smallint,default_grant_expires_at timestamptz,
              download_policy text,installation_download_policy text,
              purge_id text,purge_state text,purge_after timestamptz,capabilities jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
    SELECT r.id,r.state,r.revision,r.published_revision,r.audit_retention_years,
           r.default_grant_expires_at,r.download_policy,o.installation_download_policy,
           p.id,p.state,p.purge_after,room_settings_capabilities(p_actor_id,r.id)
      FROM room r
     CROSS JOIN organization o
      LEFT JOIN room_purge p ON p.room_id=r.id AND p.state<>'cancelled'
     WHERE r.id=p_room_id;
END $$;

CREATE FUNCTION read_room_download_overrides(p_actor_id text,p_room_id text)
RETURNS TABLE(document_id text,download_policy text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
    SELECT d.id,d.download_policy FROM document d
     WHERE d.room_id=p_room_id AND d.download_policy IS NOT NULL
     ORDER BY d.id;
END $$;

REVOKE ALL ON FUNCTION room_settings_capabilities(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_room_settings(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_room_download_overrides(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_room_settings(text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION read_room_download_overrides(text,text) TO duefold_runtime;
ALTER FUNCTION room_settings_capabilities(text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_room_settings(text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_room_download_overrides(text,text) OWNER TO duefold_migration;
```

`room_settings_capabilities` is not granted to the runtime: it is reached only through `read_room_settings`, which authorizes first.

Register the migration in `modules/participants-access/src/declaration.ts`:

```ts
    { id: '023_room_settings', file: '023_room_settings.sql' },
```

- [x] **Step 4: Write the wrapper**

Create `modules/participants-access/src/room-settings.ts`:

```ts
/**
 * Room settings, visibility, download policy, default expiry, and counterparties.
 *
 * Thin wrappers. Authority, validation, freshness and audit are decided by the
 * `SECURITY DEFINER` functions; a wrapper throws only when a function that must return
 * a row returned none.
 */
import type { Pool } from 'pg';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';

export type DownloadPolicy = 'allow' | 'deny';
export type RoomState = 'draft' | 'published' | 'archived';
export type PurgeState = 'scheduled' | 'marker_pending' | 'purging' | 'purged' | 'failed';

export interface RoomCapabilities {
  readonly publish: boolean;
  readonly archive: boolean;
  readonly returnToDraft: boolean;
  readonly setRetention: boolean;
  readonly schedulePurge: boolean;
  readonly cancelPurge: boolean;
}

export interface RoomSettings {
  readonly roomId: string;
  readonly state: RoomState;
  readonly revision: number;
  readonly publishedRevision: number;
  readonly auditRetentionYears: number;
  readonly defaultGrantExpiresAt: string | null;
  /** Null when the room inherits `installationDownloadPolicy`. */
  readonly downloadPolicy: DownloadPolicy | null;
  readonly installationDownloadPolicy: DownloadPolicy;
  readonly purge: {
    readonly purgeId: string;
    readonly state: PurgeState;
    readonly purgeAfter: string;
  } | null;
  readonly capabilities: RoomCapabilities;
}

export interface DownloadOverride {
  readonly documentId: string;
  readonly policy: DownloadPolicy;
}

export interface RoomSettingsRead {
  readonly settings: RoomSettings;
  readonly downloadOverrides: readonly DownloadOverride[];
}

interface SettingsRow {
  readonly room_id: string;
  readonly state: RoomState;
  readonly revision: number;
  readonly published_revision: number;
  readonly audit_retention_years: number;
  readonly default_grant_expires_at: Date | null;
  readonly download_policy: DownloadPolicy | null;
  readonly installation_download_policy: DownloadPolicy;
  readonly purge_id: string | null;
  readonly purge_state: PurgeState | null;
  readonly purge_after: Date | null;
  readonly capabilities: RoomCapabilities;
}

export async function readRoomSettings(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
}): Promise<RoomSettingsRead> {
  const parameters = [input.identity.id, input.roomId];
  const row = (
    await input.pool.query<SettingsRow>('SELECT * FROM read_room_settings($1,$2)', parameters)
  ).rows[0];
  if (row === undefined) throw new Error('ROOM_SETTINGS_UNAVAILABLE');
  const overrides = await input.pool.query<{ document_id: string; download_policy: DownloadPolicy }>(
    'SELECT * FROM read_room_download_overrides($1,$2)',
    parameters,
  );
  return {
    settings: {
      roomId: row.room_id,
      state: row.state,
      revision: row.revision,
      publishedRevision: row.published_revision,
      auditRetentionYears: row.audit_retention_years,
      defaultGrantExpiresAt: row.default_grant_expires_at?.toISOString() ?? null,
      downloadPolicy: row.download_policy,
      installationDownloadPolicy: row.installation_download_policy,
      purge:
        row.purge_id === null || row.purge_state === null || row.purge_after === null
          ? null
          : { purgeId: row.purge_id, state: row.purge_state, purgeAfter: row.purge_after.toISOString() },
      capabilities: row.capabilities,
    },
    downloadOverrides: overrides.rows.map((override) => ({
      documentId: override.document_id,
      policy: override.download_policy,
    })),
  };
}
```

`purge_id`, `purge_state` and `purge_after` come from one joined row and are null together; the combined check narrows all three rather than trusting one.

- [x] **Step 5: Add the route**

Create `modules/participants-access/src/routes/room-settings.ts`:

```ts
import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { readRoomSettings } from '../room-settings.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const POLICY = Type.Union([Type.Literal('allow'), Type.Literal('deny')]);
const INSTANT = Type.String({ format: 'date-time' });

export const SETTINGS = Type.Object(
  {
    roomId: ID,
    state: Type.Union([Type.Literal('draft'), Type.Literal('published'), Type.Literal('archived')]),
    revision: Type.Integer({ minimum: 1 }),
    publishedRevision: Type.Integer({ minimum: 0 }),
    auditRetentionYears: Type.Integer({ minimum: 1, maximum: 10 }),
    defaultGrantExpiresAt: Type.Union([INSTANT, Type.Null()]),
    downloadPolicy: Type.Union([POLICY, Type.Null()]),
    installationDownloadPolicy: POLICY,
    purge: Type.Union([
      Type.Object(
        {
          purgeId: ID,
          state: Type.Union([
            Type.Literal('scheduled'),
            Type.Literal('marker_pending'),
            Type.Literal('purging'),
            Type.Literal('purged'),
            Type.Literal('failed'),
          ]),
          purgeAfter: INSTANT,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    capabilities: Type.Object(
      {
        publish: Type.Boolean(),
        archive: Type.Boolean(),
        returnToDraft: Type.Boolean(),
        setRetention: Type.Boolean(),
        schedulePurge: Type.Boolean(),
        cancelPurge: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const schema = {
  querystring: Type.Object({ roomId: ID }, { additionalProperties: false }),
  response: {
    200: Type.Object(
      {
        settings: SETTINGS,
        downloadOverrides: Type.Array(
          Type.Object({ documentId: ID, policy: POLICY }, { additionalProperties: false }),
        ),
      },
      { additionalProperties: false },
    ),
  },
};

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const { roomId } = request.query as { readonly roomId: string };
    return readRoomSettings({ pool: runtime.pool, identity, roomId });
  };
}
export function handler(): never {
  throw new Error('room settings route runtime not initialized');
}
```

Declare it in `modules/participants-access/src/declaration.ts`, in `routes`:

```ts
    {
      id: 'room.settings.read',
      method: 'GET',
      path: '/api/rooms/settings',
      audience: 'member',
      handler: 'routes/room-settings.ts',
      handlerFactoryExport: 'createHandler',
    },
```

- [x] **Step 6: Append to the contract**

````markdown
## `GET /api/rooms/settings?roomId=<id>`

```
200 {settings:{roomId,state,revision,publishedRevision,auditRetentionYears,
               defaultGrantExpiresAt,downloadPolicy,installationDownloadPolicy,
               purge:{purgeId,state,purgeAfter}|null,
               capabilities:{publish,archive,returnToDraft,setRetention,schedulePurge,cancelPurge}},
     downloadOverrides:[{documentId,policy}]}
```

Room Manager (Owners and Admins hold it everywhere). A Contributor, a plain member and an
unknown room all get the uniform `403`. `downloadPolicy: null` means the room inherits
`installationDownloadPolicy`. `downloadOverrides` lists only documents with an explicit
policy.

**Capabilities are the only reason a control appears.** Each key mirrors one function's
refusals — `publish`, `archive`, `returnToDraft`: `apply_room_visibility`;
`setRetention`: `apply_audit_retention`; `schedulePurge`: `schedule_room_purge`;
`cancelPurge`: `cancel_room_purge`. A true key does not skip that function's own checks:
freshness, the typed phrase and the expected revision are still decided on apply.
````

- [x] **Step 7: Run the tests to verify they pass**

```bash
npm run compose
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-settings.test.ts
npm run typecheck && npm run lint
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add modules/participants-access test/authz/room-settings.test.ts docs/room-administration-http-contract.md
git commit -m "Read room settings with the capabilities that decide each control"
```

---

### Task 5: Room visibility — publish, archive, return to draft

**Files:**
- Modify: `modules/participants-access/migrations/023_room_settings.sql` (append)
- Modify: `modules/rooms-documents/migrations/022_room_administration.sql` (append the revoke)
- Modify: `modules/rooms-documents/src/structure.ts` (delete `changeRoomState`, lines 267-288)
- Modify: `modules/participants-access/src/room-settings.ts` (append)
- Create: `modules/participants-access/src/routes/room-visibility.ts`
- Modify: `modules/participants-access/src/declaration.ts` (routes)
- Modify: `test/authz/published-structure.test.ts:230,489,703`, `test/authz/workspace-readers.test.ts:183`, `test/authz/upload-intents.test.ts:174,196`, `test/integration/room-structure.test.ts:560` — `runtimePool` → `migrationPool` on the `change_room_state` call only
- Test: `test/authz/room-settings.test.ts` (extend)
- Modify: `docs/room-administration-http-contract.md` (append)

**Interfaces:**
- Consumes: `change_room_state` (004), `effective_access_grants` (007), `published_structure_entry`, `room_settings_capabilities` (Task 4), `read_member_room` (Task 1).
- Produces:
  - `dry_run_room_visibility(p_actor_id text, p_room_id text, p_state text) RETURNS jsonb` — `p_state` is `published` or `archived`; returns `{roomId, currentState, proposedState, viewerCount, publishedDocumentCount, requiresFreshAuthentication, expectedRevision, confirmation}`.
  - `apply_room_visibility(p_actor_id text, p_room_id text, p_state text, p_expected_revision integer, p_oidc_authenticated_at timestamptz, p_confirmation text, p_audit_id text, p_correlation_id text) RETURNS integer` — the new room revision.
  - `dryRunRoomVisibility`, `applyRoomVisibility` in `room-settings.ts`; type `VisibilityImpact`.
  - `POST /api/rooms/visibility`.

The confirmations are asymmetric (spec §5): publishing needs a dry run, the phrase `PUBLISH ROOM` and a fresh sign-in, because it is the direction that exposes content; archiving needs a dry run and `ARCHIVE ROOM`; returning to draft is the kill switch (§10.1) and needs none of them. The phrases are constants: the apply is bound to what the dry run saw by `expectedRevision`, which every grant, invitation and counterparty change advances. `change_room_state` loses its runtime grant, so no caller can reach a state change without these rules.

- [x] **Step 1: Write the failing tests**

Append to `test/authz/room-settings.test.ts`:

```ts
describe('room visibility', () => {
  let visibleRoomId = '';

  async function visibility(memberId: string, payload: Record<string, unknown>, authenticatedAt?: Date) {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/rooms/visibility',
      headers: headers(await memberSession(memberId, authenticatedAt)),
      payload: { roomId: visibleRoomId, ...payload },
    });
    await instance.close();
    return response;
  }
  const stale = () => new Date(Date.now() - 30 * 60_000);
  const roomState = async () =>
    (await migrationPool.query<{ state: string }>('SELECT state FROM room WHERE id=$1', [visibleRoomId]))
      .rows[0]?.state;

  beforeAll(async () => {
    visibleRoomId = await seedRoom(ownerId, 'Visibility room');
    await staffRoom(managerId, visibleRoomId, 'manager', ownerId);
    await staffRoom(contributorId, visibleRoomId, 'contributor', ownerId);
    await migrationPool.query('UPDATE room SET published_revision=1 WHERE id=$1', [visibleRoomId]);
    await seedViewerWithRoomGrant(visibleRoomId, ownerId, 'visibility.viewer');
  });

  it('previews publication with the viewers who will gain access', async () => {
    const response = await visibility(managerId, { action: 'dry-run', state: 'published' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ impact: unknown }>().impact).toStrictEqual({
      roomId: visibleRoomId,
      currentState: 'draft',
      proposedState: 'published',
      viewerCount: 1,
      publishedDocumentCount: 0,
      requiresFreshAuthentication: true,
      expectedRevision: await roomRevision(visibleRoomId),
      confirmation: 'PUBLISH ROOM',
    });
  });

  it('refuses a Contributor as forbidden, even on a stale sign-in', async () => {
    for (const payload of [
      { action: 'dry-run', state: 'published' },
      { action: 'apply', state: 'published', expectedRevision: 1, confirmation: 'PUBLISH ROOM' },
    ]) {
      const response = await visibility(contributorId, payload, stale());
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });

  it('asks a Manager on a stale sign-in to sign in again before publishing', async () => {
    const response = await visibility(
      managerId,
      { action: 'apply', state: 'published', expectedRevision: await roomRevision(visibleRoomId), confirmation: 'PUBLISH ROOM' },
      stale(),
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FRESH_AUTHENTICATION_REQUIRED' } });
  });

  it('refuses a mistyped phrase and a stale revision', async () => {
    const revision = await roomRevision(visibleRoomId);
    expect(
      (await visibility(managerId, { action: 'apply', state: 'published', expectedRevision: revision, confirmation: 'publish room' })).statusCode,
    ).toBe(400);
    expect(
      (await visibility(managerId, { action: 'apply', state: 'published', expectedRevision: revision - 1, confirmation: 'PUBLISH ROOM' })).statusCode,
    ).toBe(409);
    expect(await roomState()).toBe('draft');
  });

  it('publishes on a fresh sign-in with the phrase, and audits it', async () => {
    const response = await visibility(managerId, {
      action: 'apply', state: 'published',
      expectedRevision: await roomRevision(visibleRoomId), confirmation: 'PUBLISH ROOM',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ revision: await roomRevision(visibleRoomId) });
    expect(await roomState()).toBe('published');
    expect(
      (await migrationPool.query(
        "SELECT actor_id FROM audit_event WHERE event_type='room.state' AND room_id=$1 AND reason_code='ROOM_PUBLISHED'",
        [visibleRoomId],
      )).rows,
    ).toEqual([{ actor_id: managerId }]);
  });

  it('returns to draft on a stale sign-in with no dry run and no phrase', async () => {
    const response = await visibility(
      managerId,
      { action: 'apply', state: 'draft', expectedRevision: await roomRevision(visibleRoomId) },
      stale(),
    );
    expect(response.statusCode).toBe(200);
    expect(await roomState()).toBe('draft');
  });

  it('refuses a phrase on the kill switch, and a change to the current state', async () => {
    const revision = await roomRevision(visibleRoomId);
    expect(
      (await visibility(managerId, { action: 'apply', state: 'draft', expectedRevision: revision, confirmation: 'ARCHIVE ROOM' })).statusCode,
    ).toBe(400);
    expect(
      (await visibility(managerId, { action: 'apply', state: 'draft', expectedRevision: revision })).statusCode,
    ).toBe(409);
  });

  it('archives on a stale sign-in with its phrase, and stays archived while a purge is live', async () => {
    const archived = await visibility(
      managerId,
      { action: 'apply', state: 'archived', expectedRevision: await roomRevision(visibleRoomId), confirmation: 'ARCHIVE ROOM' },
      stale(),
    );
    expect(archived.statusCode).toBe(200);
    const purgeId = await schedulePurge(visibleRoomId);
    const pinned = await visibility(managerId, {
      action: 'apply', state: 'draft', expectedRevision: await roomRevision(visibleRoomId),
    });
    expect(pinned.statusCode).toBe(409);
    await cancelPurge(purgeId);
    expect(
      (await visibility(managerId, { action: 'apply', state: 'draft', expectedRevision: await roomRevision(visibleRoomId) })).statusCode,
    ).toBe(200);
  });

  it('leaves the runtime no direct path to change_room_state', async () => {
    await expect(
      databasePool.query('SELECT change_room_state($1,$2,$3,$4,$5,$6)', [
        visibleRoomId, 'published', managerId, await roomRevision(visibleRoomId),
        createOpaqueId(), createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('visibility capabilities mirror apply_room_visibility', () => {
  /** Whether apply accepts, decided inside a transaction that is always rolled back. */
  async function accepted(actorId: string, id: string, state: 'draft' | 'published' | 'archived') {
    const client = await databasePool.connect();
    try {
      await client.query('BEGIN');
      const revision = (
        await client.query<{ revision: number }>('SELECT revision FROM read_member_room($1,$2)', [actorId, id])
      ).rows[0]?.revision;
      const confirmation = { draft: null, published: 'PUBLISH ROOM', archived: 'ARCHIVE ROOM' }[state];
      return await client
        .query('SELECT apply_room_visibility($1,$2,$3,$4,$5,$6,$7,$8)', [
          actorId, id, state, revision, new Date(), confirmation, createOpaqueId(), createCorrelationId(),
        ])
        .then(() => true, () => false);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it.each([
    ['a never-published draft', 'draft', 0, false],
    ['a publishable draft', 'draft', 1, false],
    ['a published room', 'published', 1, false],
    ['an archived room', 'archived', 1, false],
    ['an archived room with a live purge', 'archived', 1, true],
  ] as const)('for a Manager in %s', async (label, state, publishedRevision, livePurge) => {
    const id = await seedRoom(ownerId, `Mirror ${label}`);
    await staffRoom(managerId, id, 'manager', ownerId);
    await migrationPool.query('UPDATE room SET published_revision=$2 WHERE id=$1', [id, publishedRevision]);
    if (state !== 'draft') await setState(id, state);
    if (livePurge) await schedulePurge(id);
    const offered = (await settingsAs(managerId, id)).capabilities;
    expect(offered['publish']).toBe(await accepted(managerId, id, 'published'));
    expect(offered['archive']).toBe(await accepted(managerId, id, 'archived'));
    expect(offered['returnToDraft']).toBe(await accepted(managerId, id, 'draft'));
  });
});
```

`setState` moves a draft straight to `published` through the migration role, which the transition trigger allows; the case only needs the state to exist, not to have been reached through the product.

- [x] **Step 2: Run the tests to verify they fail**

```bash
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-settings.test.ts
```

Expected: FAIL — `/api/rooms/visibility` is 404 and `apply_room_visibility` does not exist.

- [x] **Step 3: Append the visibility functions to migration 023**

```sql
-- Visibility. Publishing or archiving is reviewed first; the review counts the viewers
-- whose access the change grants or ends, which is participants-access data and why
-- these functions live in this module.
CREATE FUNCTION dry_run_room_visibility(p_actor_id text,p_room_id text,p_state text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected room%ROWTYPE; reach integer; documents integer;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  IF p_state IS NULL OR p_state NOT IN ('published','archived') THEN
    RAISE EXCEPTION 'visibility review names published or archived' USING ERRCODE='22023';
  END IF;
  SELECT * INTO selected FROM room WHERE id=p_room_id;
  IF (p_state='published' AND (selected.state<>'draft' OR selected.published_revision=0))
     OR (p_state='archived' AND selected.state NOT IN ('draft','published')) THEN
    RAISE EXCEPTION 'visibility change unavailable from this state' USING ERRCODE='55000';
  END IF;
  SELECT count(*)::integer INTO reach FROM viewer_room_membership m
   WHERE m.room_id=p_room_id AND m.state='active'
     AND EXISTS(SELECT 1 FROM effective_access_grants(m.viewer_id,p_room_id));
  SELECT count(*)::integer INTO documents FROM published_structure_entry e
   WHERE e.room_id=p_room_id AND e.resource_kind='document';
  RETURN jsonb_build_object(
    'roomId',p_room_id,
    'currentState',selected.state,
    'proposedState',p_state,
    -- Viewers who gain access by publishing, or lose it by archiving a published room.
    'viewerCount',CASE WHEN p_state='published' OR selected.state='published' THEN reach ELSE 0 END,
    'publishedDocumentCount',documents,
    'requiresFreshAuthentication',p_state='published',
    'expectedRevision',selected.revision,
    'confirmation',CASE p_state WHEN 'published' THEN 'PUBLISH ROOM' ELSE 'ARCHIVE ROOM' END);
END $$;

-- Returning to draft is the kill switch: no review, no phrase, no freshness. Publishing
-- exposes content, so it alone needs a fresh sign-in. Authority is checked first, so a
-- caller who may not act is never told to sign in again.
CREATE FUNCTION apply_room_visibility(
  p_actor_id text,p_room_id text,p_state text,p_expected_revision integer,
  p_oidc_authenticated_at timestamptz,p_confirmation text,p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_state text; impact jsonb;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  IF p_state IS NULL OR p_state NOT IN ('draft','published','archived')
     OR (p_state='draft') <> (p_confirmation IS NULL) THEN
    RAISE EXCEPTION 'invalid visibility change' USING ERRCODE='22023';
  END IF;
  SELECT r.state INTO current_state FROM room r WHERE r.id=p_room_id FOR UPDATE;
  IF current_state=p_state THEN
    RAISE EXCEPTION 'room already has that visibility' USING ERRCODE='55000';
  END IF;
  IF p_state='published' AND (p_oidc_authenticated_at IS NULL
       OR p_oidc_authenticated_at>statement_timestamp()
       OR p_oidc_authenticated_at<=statement_timestamp()-interval '15 minutes') THEN
    RAISE EXCEPTION 'fresh OIDC required' USING ERRCODE='42501';
  END IF;
  IF p_state<>'draft' THEN
    impact:=dry_run_room_visibility(p_actor_id,p_room_id,p_state);
    IF p_confirmation IS DISTINCT FROM impact->>'confirmation' THEN
      RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE='22023';
    END IF;
  END IF;
  RETURN change_room_state(p_room_id,p_state,p_actor_id,p_expected_revision,p_audit_id,p_correlation_id);
END $$;

REVOKE ALL ON FUNCTION dry_run_room_visibility(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_room_visibility(text,text,text,integer,timestamptz,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dry_run_room_visibility(text,text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION apply_room_visibility(text,text,text,integer,timestamptz,text,text,text) TO duefold_runtime;
ALTER FUNCTION dry_run_room_visibility(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION apply_room_visibility(text,text,text,integer,timestamptz,text,text,text) OWNER TO duefold_migration;
```

`change_room_state` still checks the revision (`40001`) and the published-structure rule, and writes the `room.state` audit row; the live-purge trigger (Task 2) refuses leaving `archived` with `55000`.

Append to `modules/rooms-documents/migrations/022_room_administration.sql`:

```sql
-- change_room_state is a building block for SECURITY DEFINER callers. A runtime grant
-- would let any caller change visibility without the review, phrase and freshness rules.
REVOKE EXECUTE ON FUNCTION change_room_state(text,text,text,integer,text,text) FROM duefold_runtime;
```

- [x] **Step 4: Move the existing suites off the revoked grant**

In each call site listed under **Files**, change the pool on the `change_room_state` query from `runtimePool` to `migrationPool` and nothing else. `change_room_state` still authorizes its `p_actor_id` argument, and `room-structure.test.ts:560` still asserts `40001` for a stale revision. Then delete `changeRoomState` from `modules/rooms-documents/src/structure.ts`; `git grep -n changeRoomState` must return nothing afterwards.

- [x] **Step 5: Append the wrappers**

Append to `modules/participants-access/src/room-settings.ts` (add the imports at the top):

```ts
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';

export type ReviewedVisibility = 'published' | 'archived';

export interface VisibilityImpact {
  readonly roomId: string;
  readonly currentState: RoomState;
  readonly proposedState: ReviewedVisibility;
  readonly viewerCount: number;
  readonly publishedDocumentCount: number;
  readonly requiresFreshAuthentication: boolean;
  readonly expectedRevision: number;
  readonly confirmation: string;
}

export async function dryRunRoomVisibility(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly state: ReviewedVisibility;
}): Promise<VisibilityImpact> {
  const impact = (
    await input.pool.query<{ impact: VisibilityImpact }>(
      'SELECT dry_run_room_visibility($1,$2,$3) AS impact',
      [input.identity.id, input.roomId, input.state],
    )
  ).rows[0]?.impact;
  if (impact === undefined) throw new Error('VISIBILITY_IMPACT_UNAVAILABLE');
  return impact;
}

export async function applyRoomVisibility(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly state: RoomState;
  readonly expectedRevision: number;
  /** Null exactly when `state` is `draft`. */
  readonly confirmation: string | null;
}): Promise<{ readonly revision: number }> {
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT apply_room_visibility($1,$2,$3,$4,$5,$6,$7,$8) AS revision',
      [
        input.identity.id,
        input.roomId,
        input.state,
        input.expectedRevision,
        input.identity.oidcAuthenticatedAt ?? null,
        input.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('VISIBILITY_CHANGE_UNAVAILABLE');
  return { revision };
}
```

- [x] **Step 6: Add the route**

Create `modules/participants-access/src/routes/room-visibility.ts`:

```ts
import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import {
  applyRoomVisibility,
  dryRunRoomVisibility,
  type ReviewedVisibility,
} from '../room-settings.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const STATE = Type.Union([Type.Literal('draft'), Type.Literal('published'), Type.Literal('archived')]);
const REVIEWED = Type.Union([Type.Literal('published'), Type.Literal('archived')]);
const REVISION = Type.Integer({ minimum: 1 });

/**
 * Room visibility. The body union carries the asymmetry: a reviewed change names its
 * phrase, and the kill switch has no field for one.
 */
export const schema = {
  body: Type.Union([
    Type.Object({ action: Type.Literal('dry-run'), roomId: ID, state: REVIEWED }, { additionalProperties: false }),
    Type.Object(
      {
        action: Type.Literal('apply'),
        roomId: ID,
        state: REVIEWED,
        expectedRevision: REVISION,
        confirmation: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal('apply'), roomId: ID, state: Type.Literal('draft'), expectedRevision: REVISION },
      { additionalProperties: false },
    ),
  ]),
  response: {
    200: Type.Object(
      {
        impact: Type.Optional(
          Type.Object(
            {
              roomId: ID,
              currentState: STATE,
              proposedState: REVIEWED,
              viewerCount: Type.Integer({ minimum: 0 }),
              publishedDocumentCount: Type.Integer({ minimum: 0 }),
              requiresFreshAuthentication: Type.Boolean(),
              expectedRevision: REVISION,
              confirmation: Type.String(),
            },
            { additionalProperties: false },
          ),
        ),
        revision: Type.Optional(REVISION),
      },
      { additionalProperties: false },
    ),
  },
};

type Body =
  | { readonly action: 'dry-run'; readonly roomId: string; readonly state: ReviewedVisibility }
  | {
      readonly action: 'apply';
      readonly roomId: string;
      readonly state: ReviewedVisibility;
      readonly expectedRevision: number;
      readonly confirmation: string;
    }
  | { readonly action: 'apply'; readonly roomId: string; readonly state: 'draft'; readonly expectedRevision: number };

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const body = request.body as Body;
    if (body.action === 'dry-run')
      return {
        impact: await dryRunRoomVisibility({ pool: runtime.pool, identity, roomId: body.roomId, state: body.state }),
      };
    return applyRoomVisibility({
      pool: runtime.pool,
      identity,
      roomId: body.roomId,
      state: body.state,
      expectedRevision: body.expectedRevision,
      confirmation: body.state === 'draft' ? null : body.confirmation,
    });
  };
}
export function handler(): never {
  throw new Error('room visibility route runtime not initialized');
}
```

Declare it:

```ts
    {
      id: 'room.visibility',
      method: 'POST',
      path: '/api/rooms/visibility',
      audience: 'member',
      handler: 'routes/room-visibility.ts',
      handlerFactoryExport: 'createHandler',
    },
```

- [x] **Step 7: Append to the contract**

````markdown
## `POST /api/rooms/visibility`

```
{action:'dry-run', roomId, state:'published'|'archived'}
  → 200 {impact:{roomId,currentState,proposedState,viewerCount,publishedDocumentCount,
                 requiresFreshAuthentication,expectedRevision,confirmation}}
{action:'apply', roomId, state:'published'|'archived', expectedRevision, confirmation}  → 200 {revision}
{action:'apply', roomId, state:'draft', expectedRevision}                               → 200 {revision}
```

Room Manager. Publishing needs the dry run's phrase (`PUBLISH ROOM`) and a sign-in within
15 minutes; archiving needs `ARCHIVE ROOM`; returning to draft — the viewer-access kill
switch — needs neither and refuses a phrase. `viewerCount` counts viewers whose access the
change grants (publish) or ends (archive a published room). The apply is bound to what the
review saw by `expectedRevision`: any grant, invitation or counterparty change in between
answers `409`. A change to the current state is `409`; so is returning a room to draft
while its purge is live. Publishing requires the structure to have been published at least
once (`409` otherwise).

`change_room_state` is not executable by the web credential; this route is the only path
to a room state change.
````

- [x] **Step 8: Run the tests to verify they pass**

```bash
npm run compose
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-settings.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/published-structure.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/workspace-readers.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/upload-intents.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2 test/integration/room-structure.test.ts
npm run typecheck && npm run lint
```

Expected: PASS.

- [x] **Step 9: Commit**

```bash
git add modules test docs/room-administration-http-contract.md
git commit -m "Change room visibility through a reviewed, audited path only"
```

---

### Task 6: Room download policy, document exceptions, default grant expiry

**Files:**
- Modify: `modules/participants-access/migrations/023_room_settings.sql` (append)
- Modify: `modules/participants-access/src/room-settings.ts` (append)
- Create: `modules/participants-access/src/routes/policies.ts`
- Modify: `modules/participants-access/src/declaration.ts` (routes)
- Create: `test/authz/room-policies.test.ts`
- Modify: `docs/room-administration-http-contract.md` (append)

**Interfaces:**
- Consumes: `set_room_download_policy`, `set_document_download_policy`, `dry_run_room_default_expiry`, `apply_room_default_expiry` (007).
- Produces:
  - `set_room_download_policy` and `set_document_download_policy` replaced (same signatures): authorize first (`42501`), refuse a change to the current value (`55000`).
  - `setRoomDownloadPolicy`, `setDocumentDownloadPolicy`, `dryRunDefaultExpiry`, `applyDefaultExpiry` in `room-settings.ts`; type `DefaultExpiryImpact`.
  - `POST /api/policies` union: `room-download`, `document-download`, `default-expiry-dry-run`, `default-expiry-apply`.

`set_room_download_policy` folds authorization into its `UPDATE ... WHERE`, so a Contributor is told `409` — "reload and try again", a false recovery instruction — instead of `403`. Both setters also audit a change to the value already held, which is evidence of a change that never happened. The replacements fix both. The installation-wide default stays with milestone 3.

- [x] **Step 1: Write the failing tests**

Create `test/authz/room-policies.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  app,
  closeRoutePools,
  databasePool,
  headers,
  memberSession,
  migrationPool,
} from './support/route-fixture.ts';
import {
  resetRoomSchema,
  roomRevision,
  seedMember,
  seedRoom,
  seedViewerWithRoomGrant,
  staffRoom,
} from './support/room-fixture.ts';

let ownerId = '';
let managerId = '';
let contributorId = '';
let roomId = '';
let documentId = '';

beforeAll(async () => {
  ownerId = await resetRoomSchema('Room policies');
  managerId = await seedMember('member', 'policy.manager');
  contributorId = await seedMember('member', 'policy.contributor');
  roomId = await seedRoom(ownerId, 'Policy room');
  await staffRoom(managerId, roomId, 'manager', ownerId);
  await staffRoom(contributorId, roomId, 'contributor', ownerId);
  documentId = createOpaqueId();
  await databasePool.query('SELECT create_document_entry($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
    createOpaqueId(), documentId, null, 'Information memorandum', 1, managerId,
    (await migrationPool.query<{ working_revision: number }>(
      'SELECT working_revision FROM room WHERE id=$1', [roomId],
    )).rows[0]?.working_revision,
    createOpaqueId(), createCorrelationId(),
  ]);
});
afterAll(closeRoutePools);

async function policies(memberId: string, payload: Record<string, unknown>) {
  const instance = await app();
  const response = await instance.inject({
    method: 'POST',
    url: '/api/policies',
    headers: headers(await memberSession(memberId)),
    payload,
  });
  await instance.close();
  return response;
}
const documentRevision = async () =>
  (await migrationPool.query<{ revision: number }>('SELECT revision FROM document WHERE id=$1', [documentId]))
    .rows[0]?.revision;

describe('room download policy', () => {
  it('refuses a Contributor as forbidden, not as a conflict', async () => {
    const response = await policies(contributorId, {
      action: 'room-download', roomId, policy: 'allow', expectedRoomRevision: await roomRevision(roomId),
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets a Manager allow downloads, audits it, and refuses the same value again', async () => {
    const before = await roomRevision(roomId);
    const response = await policies(managerId, {
      action: 'room-download', roomId, policy: 'allow', expectedRoomRevision: before,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toStrictEqual({ roomRevision: before + 1 });
    expect(
      (await migrationPool.query(
        "SELECT reason_code FROM audit_event WHERE room_id=$1 AND event_type='download.policy'",
        [roomId],
      )).rows,
    ).toEqual([{ reason_code: 'ROOM_DOWNLOAD_POLICY_CHANGED' }]);
    const again = await policies(managerId, {
      action: 'room-download', roomId, policy: 'allow', expectedRoomRevision: before + 1,
    });
    expect(again.statusCode).toBe(409);
  });

  it('returns the room to the installation default with a null policy', async () => {
    const response = await policies(managerId, {
      action: 'room-download', roomId, policy: null, expectedRoomRevision: await roomRevision(roomId),
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a stale revision', async () => {
    const response = await policies(managerId, {
      action: 'room-download', roomId, policy: 'deny', expectedRoomRevision: (await roomRevision(roomId)) - 1,
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('document download exception', () => {
  it('sets and clears an exception against the document revision', async () => {
    const set = await policies(managerId, {
      action: 'document-download', documentId, policy: 'deny', expectedDocumentRevision: await documentRevision(),
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toStrictEqual({ documentRevision: await documentRevision() });
    const cleared = await policies(managerId, {
      action: 'document-download', documentId, policy: null, expectedDocumentRevision: await documentRevision(),
    });
    expect(cleared.statusCode).toBe(200);
  });

  it('refuses a Contributor', async () => {
    const response = await policies(contributorId, {
      action: 'document-download', documentId, policy: 'allow', expectedDocumentRevision: await documentRevision(),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('default grant expiry', () => {
  const inAYear = () => new Date(Date.now() + 365 * 86_400_000).toISOString();

  it('reviews the exact inherited instant, then applies it with the phrase', async () => {
    const expiresAt = inAYear();
    const review = await policies(managerId, { action: 'default-expiry-dry-run', roomId, expiresAt });
    expect(review.statusCode).toBe(200);
    const { impact } = review.json<{ impact: { confirmation: string; resolvedExpiresAt: string } }>();
    expect(impact.confirmation).toBe('CHANGE DEFAULT EXPIRY FOR 1 ROOM');
    expect(new Date(impact.resolvedExpiresAt).toISOString()).toBe(expiresAt);
    const before = await roomRevision(roomId);
    const applied = await policies(managerId, {
      action: 'default-expiry-apply', roomId, expiresAt, expectedRoomRevision: before, confirmation: impact.confirmation,
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json<{ impact: { roomRevision: number } }>().impact.roomRevision).toBe(before + 1);
  });

  it('refuses a past instant and a Contributor', async () => {
    expect(
      (await policies(managerId, { action: 'default-expiry-dry-run', roomId, expiresAt: '2020-01-01T00:00:00.000Z' })).statusCode,
    ).toBe(400);
    expect(
      (await policies(contributorId, { action: 'default-expiry-dry-run', roomId, expiresAt: inAYear() })).statusCode,
    ).toBe(403);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

```bash
npm run compose
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-policies.test.ts
```

Expected: FAIL — `/api/policies` is 404.

- [x] **Step 3: Append the replacements to migration 023**

```sql
-- Download policy setters authorize before anything else, and refuse a change to the
-- value already held: an audit row is evidence of a change.
CREATE OR REPLACE FUNCTION set_room_download_policy(p_actor_id text,p_room_id text,p_policy text,
  p_expected_room_revision integer,p_audit_id text,p_correlation_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_policy text; next_revision integer;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  IF p_policy IS NOT NULL AND p_policy NOT IN ('allow','deny') THEN
    RAISE EXCEPTION 'invalid download policy' USING ERRCODE='22023';
  END IF;
  SELECT r.download_policy INTO current_policy FROM room r WHERE r.id=p_room_id FOR UPDATE;
  IF current_policy IS NOT DISTINCT FROM p_policy THEN
    RAISE EXCEPTION 'room already has that download policy' USING ERRCODE='55000';
  END IF;
  UPDATE room SET download_policy=p_policy,revision=revision+1
   WHERE id=p_room_id AND revision=p_expected_room_revision
  RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN RAISE EXCEPTION 'stale room revision' USING ERRCODE='40001'; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
                          result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'download.policy','member',p_actor_id,p_room_id,'room',p_room_id,'success',
         'ROOM_DOWNLOAD_POLICY_CHANGED',p_correlation_id,
         jsonb_build_object('policy',p_policy,'roomRevision',next_revision));
  RETURN next_revision;
END $$;

CREATE OR REPLACE FUNCTION set_document_download_policy(p_actor_id text,p_document_id text,p_policy text,
  p_expected_document_revision integer,p_audit_id text,p_correlation_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE selected_room text; current_policy text; next_revision integer;
BEGIN
  SELECT d.room_id,d.download_policy INTO selected_room,current_policy
    FROM document d WHERE d.id=p_document_id;
  IF selected_room IS NULL OR NOT member_can_mutate_room(p_actor_id,selected_room,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  IF p_policy IS NOT NULL AND p_policy NOT IN ('allow','deny') THEN
    RAISE EXCEPTION 'invalid download policy' USING ERRCODE='22023';
  END IF;
  IF current_policy IS NOT DISTINCT FROM p_policy THEN
    RAISE EXCEPTION 'document already has that download policy' USING ERRCODE='55000';
  END IF;
  UPDATE document SET download_policy=p_policy,revision=revision+1
   WHERE id=p_document_id AND revision=p_expected_document_revision
  RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN RAISE EXCEPTION 'stale document revision' USING ERRCODE='40001'; END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,
                          result,reason_code,correlation_id,detail)
  VALUES(p_audit_id,'download.policy','member',p_actor_id,selected_room,'document',p_document_id,
         'success','DOCUMENT_DOWNLOAD_POLICY_CHANGED',p_correlation_id,
         jsonb_build_object('policy',p_policy,'documentRevision',next_revision));
  RETURN next_revision;
END $$;
```

The no-op check reads the value before the revision check, so a no-op on a stale revision reports `409` either way; the order matters only for which `409`.

- [x] **Step 4: Append the wrappers**

Append to `modules/participants-access/src/room-settings.ts`:

```ts
export interface DefaultExpiryImpact {
  readonly affectedCount: number;
  readonly paths: readonly string[];
  readonly resolvedExpiresAt: string | null;
  readonly confirmation: string;
  readonly message: string;
  readonly roomRevision?: number;
}

export async function setRoomDownloadPolicy(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly policy: DownloadPolicy | null;
  readonly expectedRoomRevision: number;
}): Promise<{ readonly roomRevision: number }> {
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT set_room_download_policy($1,$2,$3,$4,$5,$6) AS revision',
      [input.identity.id, input.roomId, input.policy, input.expectedRoomRevision, createOpaqueId(), createCorrelationId()],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('ROOM_POLICY_UNAVAILABLE');
  return { roomRevision: revision };
}

export async function setDocumentDownloadPolicy(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly documentId: string;
  readonly policy: DownloadPolicy | null;
  readonly expectedDocumentRevision: number;
}): Promise<{ readonly documentRevision: number }> {
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT set_document_download_policy($1,$2,$3,$4,$5,$6) AS revision',
      [input.identity.id, input.documentId, input.policy, input.expectedDocumentRevision, createOpaqueId(), createCorrelationId()],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('DOCUMENT_POLICY_UNAVAILABLE');
  return { documentRevision: revision };
}

export async function dryRunDefaultExpiry(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly expiresAt: Date | null;
}): Promise<DefaultExpiryImpact> {
  const impact = (
    await input.pool.query<{ impact: DefaultExpiryImpact }>(
      'SELECT dry_run_room_default_expiry($1,$2,$3) AS impact',
      [input.identity.id, input.roomId, input.expiresAt],
    )
  ).rows[0]?.impact;
  if (impact === undefined) throw new Error('EXPIRY_IMPACT_UNAVAILABLE');
  return impact;
}

export async function applyDefaultExpiry(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly expiresAt: Date | null;
  readonly expectedRoomRevision: number;
  readonly confirmation: string;
}): Promise<DefaultExpiryImpact> {
  const impact = (
    await input.pool.query<{ impact: DefaultExpiryImpact }>(
      'SELECT apply_room_default_expiry($1,$2,$3,$4,$5,$6,$7) AS impact',
      [input.identity.id, input.roomId, input.expiresAt, input.expectedRoomRevision, input.confirmation,
       createOpaqueId(), createCorrelationId()],
    )
  ).rows[0]?.impact;
  if (impact === undefined) throw new Error('EXPIRY_CHANGE_UNAVAILABLE');
  return impact;
}
```

`resolvedExpiresAt` arrives from `to_jsonb(timestamptz)` as `2027-09-21T10:00:00+00:00`; the route schema's `date-time` format accepts the offset form and the client parses it with `Date`.

- [x] **Step 5: Add the route**

Create `modules/participants-access/src/routes/policies.ts`:

```ts
import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import {
  applyDefaultExpiry,
  dryRunDefaultExpiry,
  setDocumentDownloadPolicy,
  setRoomDownloadPolicy,
  type DownloadPolicy,
} from '../room-settings.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const POLICY = Type.Union([Type.Literal('allow'), Type.Literal('deny'), Type.Null()]);
const EXPIRY = Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);
const REVISION = Type.Integer({ minimum: 1 });

export const schema = {
  body: Type.Union([
    Type.Object(
      { action: Type.Literal('room-download'), roomId: ID, policy: POLICY, expectedRoomRevision: REVISION },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal('document-download'), documentId: ID, policy: POLICY, expectedDocumentRevision: REVISION },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal('default-expiry-dry-run'), roomId: ID, expiresAt: EXPIRY },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('default-expiry-apply'),
        roomId: ID,
        expiresAt: EXPIRY,
        expectedRoomRevision: REVISION,
        confirmation: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
  ]),
  response: {
    200: Type.Object(
      {
        roomRevision: Type.Optional(REVISION),
        documentRevision: Type.Optional(REVISION),
        impact: Type.Optional(
          Type.Object(
            {
              affectedCount: Type.Integer({ minimum: 0 }),
              paths: Type.Array(Type.String()),
              resolvedExpiresAt: EXPIRY,
              confirmation: Type.String(),
              message: Type.String(),
              roomRevision: Type.Optional(REVISION),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
};

type Body =
  | { readonly action: 'room-download'; readonly roomId: string; readonly policy: DownloadPolicy | null; readonly expectedRoomRevision: number }
  | { readonly action: 'document-download'; readonly documentId: string; readonly policy: DownloadPolicy | null; readonly expectedDocumentRevision: number }
  | { readonly action: 'default-expiry-dry-run'; readonly roomId: string; readonly expiresAt: string | null }
  | {
      readonly action: 'default-expiry-apply';
      readonly roomId: string;
      readonly expiresAt: string | null;
      readonly expectedRoomRevision: number;
      readonly confirmation: string;
    };

const instant = (value: string | null): Date | null => (value === null ? null : new Date(value));

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const body = request.body as Body;
    const pool = runtime.pool;
    switch (body.action) {
      case 'room-download':
        return setRoomDownloadPolicy({ pool, identity, ...body });
      case 'document-download':
        return setDocumentDownloadPolicy({ pool, identity, ...body });
      case 'default-expiry-dry-run':
        return { impact: await dryRunDefaultExpiry({ pool, identity, roomId: body.roomId, expiresAt: instant(body.expiresAt) }) };
      case 'default-expiry-apply':
        return {
          impact: await applyDefaultExpiry({
            pool,
            identity,
            roomId: body.roomId,
            expiresAt: instant(body.expiresAt),
            expectedRoomRevision: body.expectedRoomRevision,
            confirmation: body.confirmation,
          }),
        };
    }
  };
}
export function handler(): never {
  throw new Error('policies route runtime not initialized');
}
```

Declare it:

```ts
    {
      id: 'policy.change',
      method: 'POST',
      path: '/api/policies',
      audience: 'member',
      handler: 'routes/policies.ts',
      handlerFactoryExport: 'createHandler',
    },
```

- [x] **Step 6: Append to the contract**

````markdown
## `POST /api/policies`

```
{action:'room-download', roomId, policy:'allow'|'deny'|null, expectedRoomRevision}          → 200 {roomRevision}
{action:'document-download', documentId, policy:'allow'|'deny'|null, expectedDocumentRevision} → 200 {documentRevision}
{action:'default-expiry-dry-run', roomId, expiresAt:instant|null}                            → 200 {impact}
{action:'default-expiry-apply', roomId, expiresAt, expectedRoomRevision, confirmation}      → 200 {impact:{...,roomRevision}}
```

Room Manager. Policy resolves document → room → installation (§9.3); `null` removes the
override at that level. `expectedDocumentRevision` is the **document** revision from the
structure reader's `documentRevision`, never the entry revision. Setting the value already
held is `409`. The default-expiry review returns the exact instant new grants will inherit
(§9.2) and the phrase `CHANGE DEFAULT EXPIRY FOR 1 ROOM`; a past instant is `400`. The
installation default joins this union in milestone 3.
````

- [x] **Step 7: Run the tests to verify they pass**

```bash
npm run compose
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-policies.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/participant-grants.test.ts
npm run typecheck && npm run lint
```

Expected: PASS. `participant-grants.test.ts` exercises the 007 setters; if a case asserts `40001` for a forbidden room-policy change, it now gets `42501` — update the expectation, since `403` is the correct answer.

- [x] **Step 8: Commit**

```bash
git add modules/participants-access test/authz docs/room-administration-http-contract.md
git commit -m "Expose room download policy, document exceptions and default expiry"
```

---

### Task 7: Counterparties — list, create, place, remove

**Files:**
- Modify: `modules/participants-access/migrations/023_room_settings.sql` (append)
- Modify: `apps/web/src/failure-mapping.ts` (`SQLSTATE_STATUS`), `apps/web/src/failure-mapping.unit.test.ts`
- Test: `test/authz/member-action-routes.test.ts` (milestone 1's duplicate invitation, at the HTTP boundary)
- Modify: `modules/participants-access/src/room-settings.ts` (append)
- Create: `modules/participants-access/src/routes/counterparties.ts`
- Modify: `modules/participants-access/src/routes/participant-list.ts` (response and handler)
- Modify: `modules/participants-access/src/declaration.ts` (routes)
- Test: `test/authz/room-policies.test.ts` (extend)
- Modify: `docs/room-administration-http-contract.md` (append)

**Interfaces:**
- Consumes: `create_counterparty`, `assign_viewer_counterparty` (007); `one_active_counterparty_per_viewer_room`; `counterparty (room_id, normalized_name)` uniqueness.
- Produces:
  - `read_room_counterparties(p_actor_id text, p_room_id text) RETURNS TABLE(counterparty_id text, name text, revision integer, viewer_count integer)` — Room Manager.
  - `remove_viewer_counterparty(p_actor_id text, p_room_id text, p_viewer_id text, p_expected_room_revision integer, p_audit_id text, p_correlation_id text) RETURNS integer` — Room Manager; revokes the active placement, never deletes; `55000` when the viewer is in none.
  - `SQLSTATE 23505` maps to `409 CONFLICT`.
  - `createCounterparty`, `placeViewer`, `removeViewerFromCounterparty`, `readRoomCounterparties` in `room-settings.ts`; type `Counterparty`.
  - `POST /api/counterparties`; `GET /api/participants` gains `counterparties`.

A counterparty with no viewers is invisible to `read_room_participants`, and nothing removes a viewer from one. Two uniqueness rules are the database's — one name per room after normalization, one counterparty per viewer per room — and they raise `23505`, which the failure mapping does not know, so a duplicate currently reaches the client as **500**. Mapping `23505` to `409` fixes that everywhere it occurs, including `invite_member`'s duplicate-address refusal from milestone 1.

- [x] **Step 1: Write the failing tests**

Add to `apps/web/src/failure-mapping.unit.test.ts`:

```ts
it('reports a unique violation as a conflict, not a fault', () => {
  expect(classifyFailure({ code: '23505', message: 'duplicate key value' })).toStrictEqual({
    status: 409,
    body: {
      code: 'CONFLICT',
      message: 'The resource changed before this request completed. Reload and try again.',
    },
  });
});
```

Add to `test/authz/member-action-routes.test.ts`, inside `describe('POST /api/members/actions', …)`. `invite_member` raises `23505` for an address that is already invited or already a member; today that reaches the Admin as a 500. The fixture seeds `route.invited@example.test` as a pending invitation and `route.member@example.test` as a member:

```ts
  it('answers an already-invited or already-provisioned address as a conflict', async () => {
    const session = await memberSession(adminId);
    const instance = await app();
    for (const email of ['route.invited@example.test', 'route.member@example.test']) {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/members/actions',
        headers: headers(session),
        payload: { action: 'invite', email, intendedRole: 'member' },
      });
      expect(response.statusCode, email).toBe(409);
      expect(response.json()).toStrictEqual({
        error: {
          code: 'CONFLICT',
          message: 'The resource changed before this request completed. Reload and try again.',
        },
      });
    }
    await instance.close();
  });
```

Append to `test/authz/room-policies.test.ts`:

```ts
describe('counterparties', () => {
  let viewerId = '';
  let buyerId = '';

  async function counterparties(memberId: string, payload: Record<string, unknown>) {
    const instance = await app();
    const response = await instance.inject({
      method: 'POST',
      url: '/api/counterparties',
      headers: headers(await memberSession(memberId)),
      payload: { roomId, ...payload },
    });
    await instance.close();
    return response;
  }
  async function roster(memberId: string) {
    const instance = await app();
    const response = await instance.inject({
      method: 'GET',
      url: `/api/participants?roomId=${roomId}`,
      headers: headers(await memberSession(memberId), false),
    });
    await instance.close();
    return response;
  }

  beforeAll(async () => {
    viewerId = await seedViewerWithRoomGrant(roomId, managerId, 'counterparty.viewer');
  });

  it('creates a counterparty and lists it before anyone is placed in it', async () => {
    const created = await counterparties(managerId, {
      action: 'create', name: 'Buyer A', expectedRoomRevision: await roomRevision(roomId),
    });
    expect(created.statusCode).toBe(201);
    buyerId = created.json<{ counterpartyId: string }>().counterpartyId;
    const listed = await roster(managerId);
    expect(listed.json<{ counterparties: unknown[] }>().counterparties).toStrictEqual([
      { counterpartyId: buyerId, name: 'Buyer A', revision: 1, viewerCount: 0 },
    ]);
  });

  it('refuses a second counterparty with the same name after normalization', async () => {
    const duplicate = await counterparties(managerId, {
      action: 'create', name: 'buyer a', expectedRoomRevision: await roomRevision(roomId),
    });
    expect(duplicate.statusCode).toBe(409);
  });

  it('refuses a name that is only spaces', async () => {
    const blank = await counterparties(managerId, {
      action: 'create', name: '   ', expectedRoomRevision: await roomRevision(roomId),
    });
    expect(blank.statusCode).toBe(400);
  });

  it('places a viewer, refuses a second placement in the same room, and removes without deleting', async () => {
    const placed = await counterparties(managerId, {
      action: 'assign-viewer', counterpartyId: buyerId, viewerId, expectedRoomRevision: await roomRevision(roomId),
    });
    expect(placed.statusCode).toBe(200);

    const other = await counterparties(managerId, {
      action: 'create', name: 'Buyer B', expectedRoomRevision: await roomRevision(roomId),
    });
    const second = await counterparties(managerId, {
      action: 'assign-viewer',
      counterpartyId: other.json<{ counterpartyId: string }>().counterpartyId,
      viewerId,
      expectedRoomRevision: await roomRevision(roomId),
    });
    expect(second.statusCode).toBe(409);

    const removed = await counterparties(managerId, {
      action: 'remove-viewer', viewerId, expectedRoomRevision: await roomRevision(roomId),
    });
    expect(removed.statusCode).toBe(200);
    expect(
      (await migrationPool.query(
        'SELECT state FROM counterparty_viewer WHERE viewer_id=$1 AND room_id=$2', [viewerId, roomId],
      )).rows,
    ).toEqual([{ state: 'revoked' }]);
    expect(
      (await migrationPool.query(
        "SELECT resource_id FROM audit_event WHERE event_type='participant.counterparty.remove' AND subject_id=$1",
        [viewerId],
      )).rows,
    ).toEqual([{ resource_id: buyerId }]);

    const again = await counterparties(managerId, {
      action: 'remove-viewer', viewerId, expectedRoomRevision: await roomRevision(roomId),
    });
    expect(again.statusCode).toBe(409);
  });

  it('refuses a Contributor every counterparty action and the roster', async () => {
    expect(
      (await counterparties(contributorId, { action: 'create', name: 'Nope', expectedRoomRevision: await roomRevision(roomId) })).statusCode,
    ).toBe(403);
    expect((await roster(contributorId)).statusCode).toBe(403);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run --project unit --maxWorkers=2 failure-mapping
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-policies.test.ts -t counterparties
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/member-action-routes.test.ts -t conflict
```

Expected: FAIL — `classifyFailure` returns `null` for `23505`, so the duplicate invitation answers 500; `/api/counterparties` is 404.

- [x] **Step 3: Map `23505`**

In `apps/web/src/failure-mapping.ts`, add to `SQLSTATE_STATUS`:

```ts
  ['23505', { status: 409, code: 'CONFLICT' }],
```

- [x] **Step 4: Append the counterparty functions to migration 023**

```sql
-- A room's counterparties, including those nobody has been placed in yet.
CREATE FUNCTION read_room_counterparties(p_actor_id text,p_room_id text)
RETURNS TABLE(counterparty_id text,name text,revision integer,viewer_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
    SELECT c.id,c.name,c.revision,
           (SELECT count(*)::integer FROM counterparty_viewer cv
             WHERE cv.counterparty_id=c.id AND cv.state='active')
      FROM counterparty c
     WHERE c.room_id=p_room_id
     ORDER BY c.normalized_name,c.id;
END $$;

-- Removing a viewer from their counterparty ends the access that counterparty's grants
-- gave them. The placement is revoked, not deleted, so the history stays reconstructable.
CREATE FUNCTION remove_viewer_counterparty(p_actor_id text,p_room_id text,p_viewer_id text,
  p_expected_room_revision integer,p_audit_id text,p_correlation_id text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_revision integer; removed_counterparty text;
BEGIN
  IF NOT member_can_mutate_room(p_actor_id,p_room_id,true) THEN
    RAISE EXCEPTION 'room management forbidden' USING ERRCODE='42501';
  END IF;
  UPDATE room SET revision=revision+1
   WHERE id=p_room_id AND revision=p_expected_room_revision
  RETURNING revision INTO next_revision;
  IF next_revision IS NULL THEN RAISE EXCEPTION 'stale room revision' USING ERRCODE='40001'; END IF;
  UPDATE counterparty_viewer SET state='revoked',revision=revision+1
   WHERE room_id=p_room_id AND viewer_id=p_viewer_id AND state='active'
  RETURNING counterparty_id INTO removed_counterparty;
  IF removed_counterparty IS NULL THEN
    RAISE EXCEPTION 'viewer is in no counterparty' USING ERRCODE='55000';
  END IF;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,subject_id,room_id,resource_type,
                          resource_id,result,reason_code,correlation_id)
  VALUES(p_audit_id,'participant.counterparty.remove','member',p_actor_id,p_viewer_id,p_room_id,
         'counterparty',removed_counterparty,'success','COUNTERPARTY_REMOVED',p_correlation_id);
  RETURN next_revision;
END $$;

REVOKE ALL ON FUNCTION read_room_counterparties(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION remove_viewer_counterparty(text,text,text,integer,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_room_counterparties(text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION remove_viewer_counterparty(text,text,text,integer,text,text) TO duefold_runtime;
ALTER FUNCTION read_room_counterparties(text,text) OWNER TO duefold_migration;
ALTER FUNCTION remove_viewer_counterparty(text,text,text,integer,text,text) OWNER TO duefold_migration;
```

The `55000` after the room revision was already advanced is safe: the exception rolls the whole function back.

- [x] **Step 5: Append the wrappers**

Append to `modules/participants-access/src/room-settings.ts`:

```ts
export interface Counterparty {
  readonly counterpartyId: string;
  readonly name: string;
  readonly revision: number;
  readonly viewerCount: number;
}

export async function readRoomCounterparties(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
}): Promise<readonly Counterparty[]> {
  const result = await input.pool.query<{
    counterparty_id: string;
    name: string;
    revision: number;
    viewer_count: number;
  }>('SELECT * FROM read_room_counterparties($1,$2)', [input.identity.id, input.roomId]);
  return result.rows.map((row) => ({
    counterpartyId: row.counterparty_id,
    name: row.name,
    revision: row.revision,
    viewerCount: row.viewer_count,
  }));
}

export async function createCounterparty(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly name: string;
  readonly expectedRoomRevision: number;
}): Promise<{ readonly counterpartyId: string; readonly roomRevision: number }> {
  const counterpartyId = createOpaqueId();
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT create_counterparty($1,$2,$3,$4,$5,$6,$7) AS revision',
      [counterpartyId, input.roomId, input.name, input.identity.id, input.expectedRoomRevision,
       createOpaqueId(), createCorrelationId()],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('COUNTERPARTY_UNAVAILABLE');
  return { counterpartyId, roomRevision: revision };
}

export async function placeViewer(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly counterpartyId: string;
  readonly viewerId: string;
  readonly expectedRoomRevision: number;
}): Promise<{ readonly roomRevision: number }> {
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT assign_viewer_counterparty($1,$2,$3,$4,$5,$6,$7,$8) AS revision',
      [createOpaqueId(), input.counterpartyId, input.viewerId, input.roomId, input.identity.id,
       input.expectedRoomRevision, createOpaqueId(), createCorrelationId()],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('PLACEMENT_UNAVAILABLE');
  return { roomRevision: revision };
}

export async function removeViewerFromCounterparty(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly viewerId: string;
  readonly expectedRoomRevision: number;
}): Promise<{ readonly roomRevision: number }> {
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT remove_viewer_counterparty($1,$2,$3,$4,$5,$6) AS revision',
      [input.identity.id, input.roomId, input.viewerId, input.expectedRoomRevision,
       createOpaqueId(), createCorrelationId()],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('PLACEMENT_UNAVAILABLE');
  return { roomRevision: revision };
}
```

- [x] **Step 6: Add the routes**

Create `modules/participants-access/src/routes/counterparties.ts`:

```ts
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { createCounterparty, placeViewer, removeViewerFromCounterparty } from '../room-settings.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const REVISION = Type.Integer({ minimum: 1 });

export const schema = {
  body: Type.Union([
    Type.Object(
      {
        action: Type.Literal('create'),
        roomId: ID,
        /* At least one visible character; the database owns every other name rule. */
        name: Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
        expectedRoomRevision: REVISION,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal('assign-viewer'), roomId: ID, counterpartyId: ID, viewerId: ID, expectedRoomRevision: REVISION },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal('remove-viewer'), roomId: ID, viewerId: ID, expectedRoomRevision: REVISION },
      { additionalProperties: false },
    ),
  ]),
  response: {
    200: Type.Object({ roomRevision: REVISION }, { additionalProperties: false }),
    201: Type.Object({ counterpartyId: ID, roomRevision: REVISION }, { additionalProperties: false }),
  },
};

type Body =
  | { readonly action: 'create'; readonly roomId: string; readonly name: string; readonly expectedRoomRevision: number }
  | {
      readonly action: 'assign-viewer';
      readonly roomId: string;
      readonly counterpartyId: string;
      readonly viewerId: string;
      readonly expectedRoomRevision: number;
    }
  | { readonly action: 'remove-viewer'; readonly roomId: string; readonly viewerId: string; readonly expectedRoomRevision: number };

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Body;
    const pool = runtime.pool;
    if (body.action === 'create') {
      const created = await createCounterparty({ pool, identity, ...body });
      reply.code(201);
      return created;
    }
    if (body.action === 'assign-viewer') return placeViewer({ pool, identity, ...body });
    return removeViewerFromCounterparty({ pool, identity, ...body });
  };
}
export function handler(): never {
  throw new Error('counterparty route runtime not initialized');
}
```

Declare it:

```ts
    {
      id: 'counterparty.change',
      method: 'POST',
      path: '/api/counterparties',
      audience: 'member',
      handler: 'routes/counterparties.ts',
      handlerFactoryExport: 'createHandler',
    },
```

In `modules/participants-access/src/routes/participant-list.ts`, add `counterparties` to the 200 schema after `participants`:

```ts
        counterparties: Type.Array(
          Type.Object(
            {
              counterpartyId: ID,
              name: Type.String({ minLength: 1, maxLength: 200 }),
              revision: Type.Integer({ minimum: 1 }),
              viewerCount: Type.Integer({ minimum: 0 }),
            },
            { additionalProperties: false },
          ),
        ),
```

and to the handler's return value `counterparties: await readRoomCounterparties({ pool: runtime.pool, identity, roomId }),`, importing `readRoomCounterparties` from `../room-settings.ts`. Both readers authorize the same way, so a refusal still arrives before any data.

- [x] **Step 7: Append to the contract**

````markdown
## `POST /api/counterparties`

```
{action:'create', roomId, name, expectedRoomRevision}                          → 201 {counterpartyId, roomRevision}
{action:'assign-viewer', roomId, counterpartyId, viewerId, expectedRoomRevision} → 200 {roomRevision}
{action:'remove-viewer', roomId, viewerId, expectedRoomRevision}               → 200 {roomRevision}
```

Room Manager. Names are unique per room after case and space normalization; a viewer is in
at most one counterparty per room (§9.1). Both are database constraints and a violation is
`409`. Removal revokes the placement row and audits `participant.counterparty.remove`;
removing a viewer who is in no counterparty is `409`. A counterparty grant reaches every
viewer placed in it, so placing or removing a viewer changes that viewer's access
immediately.

`GET /api/participants` also returns `counterparties: [{counterpartyId, name, revision,
viewerCount}]`, including counterparties with no viewers yet.

## Failure mapping

`23505` (a database uniqueness rule) is `409 CONFLICT`, alongside `40001` and `55000`.
````

- [x] **Step 8: Run the tests to verify they pass**

```bash
npm run compose
npx vitest run --project unit --maxWorkers=2 failure-mapping
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-policies.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/member-action-routes.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/phase6-routes.test.ts
npm run typecheck && npm run lint
```

Expected: PASS. `phase6-routes.test.ts` covers `GET /api/participants`; update any `toStrictEqual` on its body to include `counterparties`.

- [x] **Step 9: Commit**

```bash
git add apps/web/src/failure-mapping.ts apps/web/src/failure-mapping.unit.test.ts modules/participants-access test/authz docs/room-administration-http-contract.md
git commit -m "List, create and staff counterparties, and map duplicates to 409"
```

---
### Task 8: New room, and the open room read by id

**Files:**
- Create: `apps/web-client/src/workspace/outcome.ts`, `apps/web-client/src/workspace/outcome.unit.test.ts`
- Create: `apps/web-client/src/components/FailureNotice.tsx`
- Modify: `apps/web-client/src/api/rooms.ts` (append `createRoom`, `loadRoom`), `apps/web-client/src/api/rooms.unit.test.ts`
- Modify: `apps/web-client/src/api/client.ts` (re-export)
- Create: `apps/web-client/src/workspace/useOpenRoom.ts`
- Create: `apps/web-client/src/components/NewRoomDialog.tsx`, `apps/web-client/src/components/NewRoomDialog.unit.test.tsx`
- Modify: `apps/web-client/src/workspace/views/RegisterView.tsx`, `apps/web-client/src/workspace/views/views.unit.test.tsx`
- Modify: `apps/web-client/src/routes/Workspace.tsx:249-250` (open room), `refreshRooms`, the `RegisterView` element
- Modify: `apps/web-client/src/i18n/en.ts`
- Modify: `apps/web-client/src/workspace/useAdministrationSection.ts` (`act`, `assign`; delete `AssignmentOutcome`), `apps/web-client/src/components/MembersPanel.tsx` (`onAssign`), `apps/web-client/src/components/MembersPanel.unit.test.tsx` (`NOOPS`)

**Interfaces:**
- Consumes: `POST /api/rooms`, `GET /api/rooms?roomId=` (Task 1); `presentFailure`, `PresentedFailure` (`workspace/failures.ts`); `OIDC_BEGIN_PATH` (`routes/MemberSignIn.tsx`); `mayAdministerOrganization` (session bootstrap).
- Produces:
  - `Outcome<T>`, `settle(work)`, `committed(work)` in `workspace/outcome.ts` — every later client task uses them, and milestone 1's member assignment batch moves onto them (Step 9).
  - `FailureNotice({failure, onReload?})` — a presented failure plus the one recovery it earns.
  - `createRoom(room: NewRoom)`, `loadRoom(roomId, signal?)`, type `NewRoom` in `api/rooms.ts`.
  - `useOpenRoom(roomId, reloadToken): Load<MemberRoom> | null`.
  - `RegisterViewProps.createRoom: ((room: NewRoom) => Promise<PresentedFailure | null>) | null`.

`New room` is offered on `mayAdministerOrganization`, which is `may_administer_organization`'s answer — the same predicate `create_room` refuses on. The frame reads the open room's row by id, so a room just created is fully usable whichever register page its title lands on.

- [x] **Step 1: Write the failing unit tests**

Create `apps/web-client/src/workspace/outcome.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { committed, settle } from './outcome.ts';

describe('settle', () => {
  it('carries a value', async () => {
    expect(await settle(Promise.resolve(3))).toStrictEqual({ ok: true, value: 3 });
  });

  it('turns a refusal into its designed presentation instead of rejecting', async () => {
    const outcome = await settle(Promise.reject(new ApiError('conflict')));
    expect(outcome).toMatchObject({ ok: false, failure: { kind: 'conflict', offerReload: true } });
  });
});

describe('committed', () => {
  it('is null when the work committed and the failure when it did not', async () => {
    expect(await committed(Promise.resolve({}))).toBeNull();
    expect(await committed(Promise.reject(new ApiError('conflict')))).toMatchObject({ kind: 'conflict' });
  });
});
```

Check `ApiFailure` in `api/transport.ts` for the exact member names and use its conflict member. Append to `apps/web-client/src/api/rooms.unit.test.ts`:

```ts
describe('createRoom', () => {
  it('sends NFC text and returns the new id', async () => {
    const fetch = stubJson({ roomId: 'r'.repeat(32) }, 201);
    expect(await createRoom({ title: 'Café', description: '' })).toStrictEqual({ roomId: 'r'.repeat(32) });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toStrictEqual({ title: 'Café', description: '' });
  });
});

describe('loadRoom', () => {
  it('is null for an unreachable room and fails closed on more than one row', async () => {
    stubJson({ rooms: [] });
    expect(await loadRoom('x'.repeat(32))).toBeNull();
    stubJson({ rooms: [ROOM, ROOM] });
    await expect(loadRoom('x'.repeat(32))).rejects.toMatchObject({ failure: 'unavailable' });
  });
});
```

`stubJson` and `ROOM` follow the helpers the file already uses for `loadRooms`; add them there if they are inline in each case.

Create `apps/web-client/src/components/NewRoomDialog.unit.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { messages } from '../i18n/en.ts';
import { canSubmitRoomTitle, NewRoomForm } from './NewRoomDialog.tsx';

const noop = (): void => undefined;
const form = (overrides: Partial<Parameters<typeof NewRoomForm>[0]> = {}) =>
  renderToStaticMarkup(
    <NewRoomForm
      formId="f"
      title=""
      description=""
      pending={false}
      failure={null}
      onTitleChange={noop}
      onDescriptionChange={noop}
      onSubmit={noop}
      {...overrides}
    />,
  );

describe('NewRoomForm', () => {
  it('says the room starts as a draft before anything is submitted', () => {
    expect(form()).toContain(messages['rooms.new.explain']);
  });

  it('shows a refusal inside the form it belongs to', () => {
    const html = form({
      failure: { kind: 'denied', title: null, body: 'Refused here.', offerReload: false },
    });
    expect(html).toContain('Refused here.');
  });
});

describe('canSubmitRoomTitle', () => {
  it('refuses only a blank title; every other rule is the server’s', () => {
    expect(canSubmitRoomTitle('   ')).toBe(false);
    expect(canSubmitRoomTitle('Series B')).toBe(true);
  });
});
```

Add to `apps/web-client/src/workspace/views/views.unit.test.tsx`, beside the existing `RegisterView` cases:

```tsx
it('offers New room only when the server said this member may create rooms', () => {
  const ready = { kind: 'ready', value: { rooms: [], nextCursor: null } } as const;
  const props = { rooms: ready, loadingMore: false, pageFailure: null, onLoadMore: noop, onOpen: noop, onRetry: noop };
  expect(renderToStaticMarkup(<RegisterView {...props} createRoom={null} />)).not.toContain(messages['rooms.new']);
  expect(
    renderToStaticMarkup(<RegisterView {...props} createRoom={() => Promise.resolve(null)} />),
  ).toContain(messages['rooms.new']);
});
```

- [x] **Step 2: Run them to verify they fail**

```bash
npx vitest run --project unit --maxWorkers=2 outcome rooms.unit NewRoomDialog views.unit
```

Expected: FAIL — modules and exports not found.

- [x] **Step 3: Write `outcome.ts` and `FailureNotice`**

Create `apps/web-client/src/workspace/outcome.ts`:

```ts
/**
 * A request's result as surfaces consume it: resolved, never rejected, with a refusal
 * already turned into its designed presentation.
 */
import { presentFailure, type PresentedFailure } from './failures.ts';

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: PresentedFailure };

export async function settle<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work };
  } catch (error: unknown) {
    return { ok: false, failure: presentFailure(error) };
  }
}

/** Null when the mutation committed; its presented refusal otherwise. */
export async function committed(work: Promise<unknown>): Promise<PresentedFailure | null> {
  const outcome = await settle(work);
  return outcome.ok ? null : outcome.failure;
}
```

Create `apps/web-client/src/components/FailureNotice.tsx`:

```tsx
/**
 * A presented failure and the one recovery its class earns: sign in again when the
 * session cannot succeed, reload when a revision went stale, nothing for a denial.
 */
import { translate } from '../i18n/translate.ts';
import { OIDC_BEGIN_PATH } from '../routes/MemberSignIn.tsx';
import type { PresentedFailure } from '../workspace/failures.ts';
import { Notice } from './Notice.tsx';

export function FailureNotice({
  failure,
  onReload,
}: {
  readonly failure: PresentedFailure;
  readonly onReload?: () => void;
}): React.ReactElement {
  const signIn = failure.kind === 'fresh-oidc' || failure.kind === 'session-ended';
  return (
    <Notice tone="problem" role="alert" {...(failure.title === null ? {} : { title: failure.title })}>
      <p>{failure.body}</p>
      {signIn ? (
        <a className="df-button" href={OIDC_BEGIN_PATH}>
          {translate('failure.signInAgain')}
        </a>
      ) : null}
      {failure.offerReload && onReload !== undefined ? (
        <button type="button" className="df-button" onClick={onReload}>
          {translate('failure.reload')}
        </button>
      ) : null}
    </Notice>
  );
}
```

If importing from `routes/` into `components/` creates a cycle the linter reports, move `OIDC_BEGIN_PATH` into `api/auth.ts` and re-export it from `MemberSignIn.tsx`.

- [x] **Step 4: Add the room client calls**

Append to `apps/web-client/src/api/rooms.ts`:

```ts
export interface NewRoom {
  readonly title: string;
  readonly description: string;
}

/** Creates a draft room. Text is sent as NFC; every other rule is `create_room`'s. */
export async function createRoom(room: NewRoom): Promise<{ readonly roomId: string }> {
  const payload = await json({
    method: 'POST',
    path: '/api/rooms',
    body: { title: room.title.normalize('NFC'), description: room.description.normalize('NFC') },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return { roomId: requireString(payload, 'roomId') };
}

/** One register row by id; null when the room is not reachable, which includes unknown. */
export async function loadRoom(roomId: string, signal?: AbortSignal): Promise<MemberRoom | null> {
  const payload = await json({
    method: 'GET',
    path: `/api/rooms?roomId=${encodeURIComponent(roomId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  const rooms = requireArray(payload, 'rooms').map(parseRoom);
  if (rooms.length > 1) throw new ApiError('unavailable');
  return rooms[0] ?? null;
}
```

Add `createRoom`, `loadRoom` and `type NewRoom` to the `rooms.ts` re-export block in `api/client.ts`.

- [x] **Step 5: Read the open room by id**

Create `apps/web-client/src/workspace/useOpenRoom.ts`:

```ts
/**
 * The open room's register row, read by id.
 *
 * Revision-dependent controls inside a room need this row. Reading it by id rather than
 * finding it in the loaded register page means a room on an unloaded page — including one
 * just created — is as usable as any other. The row is keyed by room id, so switching
 * rooms never shows one room's revision for another.
 */
import { useEffect, useState } from 'react';
import { loadRoom, type MemberRoom } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import { presentFailure } from './failures.ts';
import type { Load } from './state.ts';

export function useOpenRoom(roomId: string | null, reloadToken: number): Load<MemberRoom> | null {
  const [read, setRead] = useState<{ readonly roomId: string; readonly load: Load<MemberRoom> } | null>(null);

  useEffect(() => {
    if (roomId === null) return;
    const controller = new AbortController();
    loadRoom(roomId, controller.signal).then(
      (room) => {
        setRead({
          roomId,
          load: room === null ? { kind: 'failed', failure: translate('rooms.unavailable') } : { kind: 'ready', value: room },
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setRead({ roomId, load: { kind: 'failed', failure: presentFailure(error).body } });
      },
    );
    return () => {
      controller.abort();
    };
  }, [roomId, reloadToken]);

  if (roomId === null) return null;
  return read !== null && read.roomId === roomId ? read.load : { kind: 'loading' };
}
```

In `apps/web-client/src/routes/Workspace.tsx`, replace the `roomList.find` derivation (`:249-250`) with:

```ts
  const [openRoomToken, setOpenRoomToken] = useState(0);
  const openRoomLoad = useOpenRoom(openRoomId, openRoomToken);
  const openRoom = openRoomLoad?.kind === 'ready' ? openRoomLoad.value : null;
```

and make `refreshRooms` also re-read the open row by adding `setOpenRoomToken((token) => token + 1);` to its body. `RoomView` already renders its own load failure for a room it cannot reach, so the frame does not render this one again.

- [x] **Step 6: Write the dialog**

Create `apps/web-client/src/components/NewRoomDialog.tsx`:

```tsx
/**
 * Create a room.
 *
 * The room starts in draft, and the dialog says so before the action: nothing in it is
 * visible to viewers until a Room Manager publishes it. The dialog owns its pending and
 * failure state, closes when creation commits, and cannot be dismissed while a creation
 * is in flight.
 */
import { Dialog } from '@base-ui/react/dialog';
import { useEffect, useId, useRef, useState } from 'react';
import type { NewRoom } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { FailureNotice } from './FailureNotice.tsx';

/** A blank title is not submittable; every other rule is the server's. */
export function canSubmitRoomTitle(title: string): boolean {
  return title.trim() !== '';
}

export interface NewRoomFormProps {
  readonly formId: string;
  readonly title: string;
  readonly description: string;
  readonly pending: boolean;
  readonly failure: PresentedFailure | null;
  readonly firstField?: React.Ref<HTMLInputElement>;
  readonly onTitleChange: (value: string) => void;
  readonly onDescriptionChange: (value: string) => void;
  readonly onSubmit: () => void;
}

export function NewRoomForm({
  formId,
  title,
  description,
  pending,
  failure,
  firstField,
  onTitleChange,
  onDescriptionChange,
  onSubmit,
}: NewRoomFormProps): React.ReactElement {
  const titleField = useId();
  const descriptionField = useId();
  const descriptionHelp = useId();
  return (
    <form
      id={formId}
      className="df-inline-form df-inline-form--stacked"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && canSubmitRoomTitle(title)) onSubmit();
      }}
    >
      <p className="df-field__help">{translate('rooms.new.explain')}</p>
      <div className="df-field">
        <label className="df-field__label" htmlFor={titleField}>
          {translate('rooms.new.titleLabel')}
        </label>
        <input
          id={titleField}
          ref={firstField}
          className="df-field__input"
          required
          maxLength={200}
          value={title}
          disabled={pending}
          onChange={(event) => {
            onTitleChange(event.target.value);
          }}
        />
      </div>
      <div className="df-field">
        <label className="df-field__label" htmlFor={descriptionField}>
          {translate('rooms.new.descriptionLabel')}
        </label>
        <textarea
          id={descriptionField}
          className="df-field__input"
          maxLength={4000}
          aria-describedby={descriptionHelp}
          value={description}
          disabled={pending}
          onChange={(event) => {
            onDescriptionChange(event.target.value);
          }}
        />
        <p id={descriptionHelp} className="df-field__help">
          {translate('rooms.new.descriptionHelp')}
        </p>
      </div>
      {failure === null ? null : <FailureNotice failure={failure} />}
    </form>
  );
}

export interface NewRoomDialogProps {
  readonly open: boolean;
  readonly onCreate: (room: NewRoom) => Promise<PresentedFailure | null>;
  readonly onClose: () => void;
}

export function NewRoomDialog({ open, onCreate, onClose }: NewRoomDialogProps): React.ReactElement {
  const formId = useId();
  const firstField = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<PresentedFailure | null>(null);

  useEffect(() => {
    if (open) return;
    setTitle('');
    setDescription('');
    setFailure(null);
  }, [open]);

  const submit = async (): Promise<void> => {
    setPending(true);
    setFailure(null);
    const refused = await onCreate({ title, description });
    setPending(false);
    if (refused === null) onClose();
    else setFailure(refused);
  };

  return (
    <Dialog.Root
      open={open}
      disablePointerDismissal={pending}
      onOpenChange={(next, eventDetails) => {
        if (!next && pending) {
          eventDetails.cancel();
          return;
        }
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="df-modal__backdrop" />
        <Dialog.Viewport className="df-modal">
          <Dialog.Popup className="df-modal__panel" initialFocus={firstField}>
            <Dialog.Title className="df-modal__title">{translate('rooms.new.title')}</Dialog.Title>
            <NewRoomForm
              formId={formId}
              title={title}
              description={description}
              pending={pending}
              failure={failure}
              firstField={firstField}
              onTitleChange={setTitle}
              onDescriptionChange={setDescription}
              onSubmit={() => {
                void submit();
              }}
            />
            <div className="df-modal__actions">
              <Dialog.Close className="df-button" disabled={pending}>
                {translate('structure.cancel')}
              </Dialog.Close>
              <button
                type="submit"
                form={formId}
                className="df-button df-button--primary"
                data-busy={pending ? 'true' : 'false'}
                disabled={pending || !canSubmitRoomTitle(title)}
              >
                {pending ? translate('rooms.new.pending') : translate('rooms.new.submit')}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

Initial focus goes to the title field, not Cancel: this dialog opens on a constructive task with nothing destructive behind its primary action.

- [x] **Step 7: Offer it on the register**

In `apps/web-client/src/workspace/views/RegisterView.tsx`, add to `RegisterViewProps`:

```ts
  /** Present only when the server said this member may create rooms. */
  readonly createRoom: ((room: NewRoom) => Promise<PresentedFailure | null>) | null;
```

In the component, hold `const [creating, setCreating] = useState(false);` and define, before the load-state branches:

```tsx
  const newRoom =
    createRoom === null ? null : (
      <>
        <div className="df-panel__actions">
          <button
            type="button"
            className="df-button df-button--primary"
            onClick={() => {
              setCreating(true);
            }}
          >
            {translate('rooms.new')}
          </button>
        </div>
        <NewRoomDialog
          open={creating}
          onCreate={createRoom}
          onClose={() => {
            setCreating(false);
          }}
        />
      </>
    );
```

Render `{newRoom}` first inside every branch's returned fragment — loading, failed and ready — so creating a room never depends on the register having loaded. Wrap the loading and failed returns in a fragment to do so.

In `Workspace.tsx`, extract the body of `RegisterView`'s `onOpen` into `const enterRoom = (id: string): void => {...}` and add:

```ts
  const createRoomAndEnter = async (room: NewRoom): Promise<PresentedFailure | null> => {
    const outcome = await settle(createRoom(room));
    if (!outcome.ok) return outcome.failure;
    setStatus(translate('rooms.new.created', { title: room.title }));
    enterRoom(outcome.value.roomId);
    refreshRooms();
    return null;
  };
```

and pass `onOpen={enterRoom}` and `createRoom={mayAdministerOrganization ? createRoomAndEnter : null}` to `RegisterView`.

- [x] **Step 8: Add the copy**

In `apps/web-client/src/i18n/en.ts`:

```ts
  'rooms.new': 'New room',
  'rooms.new.title': 'Create a room',
  'rooms.new.explain':
    'The room starts as a draft. Viewers cannot reach anything in it until it is published.',
  'rooms.new.titleLabel': 'Room title',
  'rooms.new.descriptionLabel': 'Description',
  'rooms.new.descriptionHelp': 'Optional. Plain text that readers see once the room is published.',
  'rooms.new.submit': 'Create room',
  'rooms.new.pending': 'Creating room…',
  'rooms.new.created': 'Room {title} created.',
  'rooms.unavailable': 'This room is not available to you.',
  'failure.signInAgain': 'Sign in again',
  'failure.reload': 'Reload',
```

- [x] **Step 9: Put the member assignment batch on the same convention**

Milestone 1 returns `AssignmentOutcome` (`{kind: 'applied'} | {kind: 'refused', failure}`) from `assign`, and its `act` helper takes a `reportAtTable` flag to decide whether a refusal also lands in the shared `changeFailure`. With `committed()` in place that is a second convention for the same answer. Fold it in, so the client has one.

In `apps/web-client/src/workspace/useAdministrationSection.ts`, delete `AssignmentOutcome`, import `committed` from `./outcome.ts`, and replace `act` with:

```ts
  const act = (
    subjectId: string,
    run: () => Promise<unknown>,
    done: () => void,
  ): Promise<PresentedFailure | null> => {
    setBusySubjectId(subjectId);
    setChangeFailure(null);
    return committed(run()).then((failure) => {
      setBusySubjectId(null);
      if (failure === null) {
        done();
        refresh();
      }
      return failure;
    });
  };
```

The table-level mutations report their own answer; the dialog's batch hands its answer back to the dialog:

```ts
    revokeInvitation: (invitationId) => {
      void act(
        invitationId,
        () => revokeMemberInvitation(invitationId),
        handlers.onInvitationRevoked,
      ).then(setChangeFailure);
    },
    changeRole: (input) => {
      void act(input.memberId, () => setMemberRole(input), handlers.onRoleChanged).then(
        setChangeFailure,
      );
    },
    changeState: (input) => {
      void act(input.memberId, () => setMemberState(input), handlers.onStateChanged).then(
        setChangeFailure,
      );
    },
    assign: (input) => act(input.memberId, () => applyRoomAssignments(input), handlers.onAssigned),
```

Type `assign` in `AdministrationSection` as `(input: {…}) => Promise<PresentedFailure | null>`, with the doc comment reduced to: "Resolves `null` once the batch committed, or with its presented refusal, which only the submitting dialog shows."

In `apps/web-client/src/components/MembersPanel.tsx`, drop the `AssignmentOutcome` import, type `onAssign` as `(input: AssignmentChange) => Promise<PresentedFailure | null>`, and settle the dialog on the answer:

```tsx
        onApply={(input) => {
          setAssignFailure(null);
          void props.onAssign(input).then((failure) => {
            if (failure === null) closeRooms();
            else setAssignFailure(failure);
          });
        }}
```

In `MembersPanel.unit.test.tsx`, `NOOPS.onAssign` becomes `() => Promise.resolve(null)`. `git grep -n "AssignmentOutcome\|reportAtTable" apps/web-client` must return nothing.

- [x] **Step 10: Run the tests to verify they pass**

```bash
npx vitest run --project unit --maxWorkers=2
npm run typecheck && npm run lint
node --env-file=.env ./node_modules/@playwright/test/cli.js test test/browser/members.spec.ts --project=chromium
wc -l apps/web-client/src/routes/Workspace.tsx
```

Expected: PASS — the assignment dialog still stays open on a refused batch and closes on a committed one — and `Workspace.tsx` at most 30 lines over its 494-line baseline.

- [x] **Step 11: Commit**

```bash
git add apps/web-client/src
git commit -m "Create a room from the register and open it by id"
```

---

### Task 9: One confirmation dialog, and the Settings section with visibility

**Files:**
- Create: `apps/web-client/src/api/room-settings.ts`, `apps/web-client/src/api/room-settings.unit.test.ts`
- Modify: `apps/web-client/src/api/client.ts` (re-export)
- Create: `apps/web-client/src/components/ConfirmationDialog.tsx`, `apps/web-client/src/components/ConfirmationDialog.unit.test.tsx`
- Create: `apps/web-client/src/workspace/useRoomSettings.ts`
- Create: `apps/web-client/src/workspace/room-settings.ts`, `apps/web-client/src/workspace/room-settings.unit.test.ts`
- Create: `apps/web-client/src/components/RoomSettingsPanel.tsx`
- Create: `apps/web-client/src/components/RoomVisibilityControls.tsx`
- Modify: `apps/web-client/src/workspace/views/RoomView.tsx` (core tabs, hook, render)
- Modify: `apps/web-client/src/i18n/en.ts`

**Interfaces:**
- Consumes: `GET /api/rooms/settings` (Task 4), `POST /api/rooms/visibility` (Task 5); `settle`, `committed`, `FailureNotice` (Task 8); `classifyLoad` (`workspace/views/load-state.ts`).
- Produces:
  - Client types `RoomSettings`, `RoomCapabilities`, `RoomSettingsView` (`downloadOverrides: ReadonlyMap<string, DownloadPolicy>`), `VisibilityImpact`, `VisibilityChange`, `ReviewedVisibility`, `DownloadPolicy`, `PurgeState`; calls `loadRoomSettings`, `reviewVisibility`, `applyVisibility`.
  - `ConfirmationDialog`, `ConfirmationBody`, and the types `ConfirmationContent`, `Confirmation`.
  - `useRoomSettings(roomId: string | null, onChanged: () => void): RoomSettingsSection | null`, with `load`, `failure`, `reload`, `reviewVisibility`, `applyVisibility`. Tasks 10–12 extend `RoomSettingsSection`.
  - `visibilityNotes(settings): readonly MessageKey[]` in `workspace/room-settings.ts`.

One dialog serves every confirmation in this milestone. Its ready content carries the consequence and a `Confirmation` that either has the server's phrase or has none — the kill switch and download exceptions take one deliberate press and no phrase, and the type makes a phrase-less `confirm` impossible to call with text and vice versa.

- [x] **Step 1: Write the failing unit tests**

Create `apps/web-client/src/api/room-settings.unit.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRoomSettings, reviewVisibility } from './room-settings.ts';

const ID = 'r'.repeat(32);
const SETTINGS = {
  roomId: ID, state: 'draft', revision: 3, publishedRevision: 0, auditRetentionYears: 7,
  defaultGrantExpiresAt: null, downloadPolicy: null, installationDownloadPolicy: 'deny', purge: null,
  capabilities: { publish: false, archive: true, returnToDraft: false, setRetention: true, schedulePurge: false, cancelPurge: false },
};

function stub(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadRoomSettings', () => {
  it('parses settings and indexes download overrides by document', async () => {
    stub({ settings: SETTINGS, downloadOverrides: [{ documentId: 'd'.repeat(32), policy: 'allow' }] });
    const view = await loadRoomSettings(ID);
    expect(view.settings.capabilities.archive).toBe(true);
    expect(view.downloadOverrides.get('d'.repeat(32))).toBe('allow');
  });

  it.each([
    [{ ...SETTINGS, state: 'live' }],
    [{ ...SETTINGS, capabilities: { ...SETTINGS.capabilities, publish: 'yes' } }],
    [{ ...SETTINGS, downloadPolicy: 'sometimes' }],
    [{ ...SETTINGS, purge: { purgeId: ID, state: 'scheduled' } }],
  ])('fails closed on a value this client does not recognize', async (settings) => {
    stub({ settings, downloadOverrides: [] });
    await expect(loadRoomSettings(ID)).rejects.toMatchObject({ failure: 'unavailable' });
  });
});

describe('reviewVisibility', () => {
  it('parses the impact the server computed', async () => {
    stub({
      impact: {
        roomId: ID, currentState: 'draft', proposedState: 'published', viewerCount: 2,
        publishedDocumentCount: 5, requiresFreshAuthentication: true, expectedRevision: 3,
        confirmation: 'PUBLISH ROOM',
      },
    });
    expect(await reviewVisibility(ID, 'published')).toMatchObject({ viewerCount: 2, confirmation: 'PUBLISH ROOM' });
  });
});
```

If `api/transport.ts` reads the CSRF cookie through `document`, stub it the way `api/administration.unit.test.ts` does for POSTs.

Create `apps/web-client/src/components/ConfirmationDialog.unit.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { messages } from '../i18n/en.ts';
import { ConfirmationBody, type ConfirmationContent } from './ConfirmationDialog.tsx';

const noop = (): void => undefined;
const body = (content: ConfirmationContent, failure = null) =>
  renderToStaticMarkup(
    <ConfirmationBody
      content={content}
      consequenceId="c"
      typed=""
      pending={false}
      failure={failure}
      onTypedChange={noop}
      onReload={noop}
    />,
  );

describe('ConfirmationBody', () => {
  it('states the consequence before the field that unlocks the action', () => {
    const html = body({
      kind: 'ready',
      consequence: <p>Viewers lose access.</p>,
      confirmation: { phrase: 'ARCHIVE ROOM', confirm: () => Promise.resolve(null) },
    });
    expect(html.indexOf('Viewers lose access.')).toBeLessThan(html.indexOf('ARCHIVE ROOM'));
  });

  it('asks for nothing to be typed when the change has no phrase', () => {
    const html = body({
      kind: 'ready',
      consequence: <p>Every viewer loses access now.</p>,
      confirmation: { phrase: null, confirm: () => Promise.resolve(null) },
    });
    expect(html).not.toContain('<input');
  });

  it('reports a failed review rather than an empty dialog', () => {
    const html = body({
      kind: 'failed',
      failure: { kind: 'conflict', title: null, body: 'Changed meanwhile.', offerReload: true },
    });
    expect(html).toContain('Changed meanwhile.');
    expect(html).toContain(messages['failure.reload']);
  });
});
```

Create `apps/web-client/src/workspace/room-settings.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RoomSettings } from '../api/client.ts';
import { visibilityNotes } from './room-settings.ts';

const base: RoomSettings = {
  roomId: 'r'.repeat(32), state: 'draft', revision: 1, publishedRevision: 0, auditRetentionYears: 7,
  defaultGrantExpiresAt: null, downloadPolicy: null, installationDownloadPolicy: 'deny', purge: null,
  capabilities: { publish: false, archive: true, returnToDraft: false, setRetention: false, schedulePurge: false, cancelPurge: false },
};

describe('visibilityNotes', () => {
  it('explains why a never-published draft cannot be published yet', () => {
    expect(visibilityNotes(base)).toStrictEqual(['settings.visibility.publishStructureFirst']);
  });

  it('explains why a room held by its purge cannot return to draft', () => {
    expect(
      visibilityNotes({
        ...base,
        state: 'archived',
        publishedRevision: 1,
        purge: { purgeId: 'p'.repeat(32), state: 'scheduled', purgeAfter: '2026-10-21T00:00:00.000Z' },
      }),
    ).toStrictEqual(['settings.visibility.pinnedByPurge']);
  });
});
```

- [x] **Step 2: Run them to verify they fail**

```bash
npx vitest run --project unit --maxWorkers=2 room-settings ConfirmationDialog
```

Expected: FAIL — modules not found.

- [x] **Step 3: Write the client calls**

Create `apps/web-client/src/api/room-settings.ts`:

```ts
/**
 * Room settings, visibility, policy, and lifecycle calls.
 *
 * Every response is parsed field by field and a value this client does not recognize
 * fails closed: capabilities decide which controls appear, so an unparsed capability
 * would be a control the server never offered.
 */
import type { RoomState } from './rooms.ts';
import { ApiError, isRecord, json, requireArray, requireNumber, requireString } from './transport.ts';

export type DownloadPolicy = 'allow' | 'deny';
export type ReviewedVisibility = 'published' | 'archived';
export type PurgeState = 'scheduled' | 'marker_pending' | 'purging' | 'purged' | 'failed';

export interface RoomCapabilities {
  readonly publish: boolean;
  readonly archive: boolean;
  readonly returnToDraft: boolean;
  readonly setRetention: boolean;
  readonly schedulePurge: boolean;
  readonly cancelPurge: boolean;
}

export interface RoomSettings {
  readonly roomId: string;
  readonly state: RoomState;
  readonly revision: number;
  readonly publishedRevision: number;
  readonly auditRetentionYears: number;
  readonly defaultGrantExpiresAt: string | null;
  readonly downloadPolicy: DownloadPolicy | null;
  readonly installationDownloadPolicy: DownloadPolicy;
  readonly purge: { readonly purgeId: string; readonly state: PurgeState; readonly purgeAfter: string } | null;
  readonly capabilities: RoomCapabilities;
}

export interface RoomSettingsView {
  readonly settings: RoomSettings;
  readonly downloadOverrides: ReadonlyMap<string, DownloadPolicy>;
}

export interface VisibilityImpact {
  readonly roomId: string;
  readonly currentState: RoomState;
  readonly proposedState: ReviewedVisibility;
  readonly viewerCount: number;
  readonly publishedDocumentCount: number;
  readonly requiresFreshAuthentication: boolean;
  readonly expectedRevision: number;
  readonly confirmation: string;
}

export type VisibilityChange =
  | { readonly state: 'draft'; readonly expectedRevision: number }
  | { readonly state: ReviewedVisibility; readonly expectedRevision: number; readonly confirmation: string };

const STATES: readonly RoomState[] = ['draft', 'published', 'archived'];
const POLICIES: readonly DownloadPolicy[] = ['allow', 'deny'];
const PURGE_STATES: readonly PurgeState[] = ['scheduled', 'marker_pending', 'purging', 'purged', 'failed'];
const REVIEWED: readonly ReviewedVisibility[] = ['published', 'archived'];

export function oneOf<T>(values: readonly T[], value: unknown): T {
  if (!(values as readonly unknown[]).includes(value)) throw new ApiError('unavailable');
  return value as T;
}

export function instantOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new ApiError('unavailable');
  return value;
}

export function requireRecord(value: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
  const nested = value[key];
  if (!isRecord(nested)) throw new ApiError('unavailable');
  return nested;
}

export function requireBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean {
  const flag = value[key];
  if (typeof flag !== 'boolean') throw new ApiError('unavailable');
  return flag;
}

function parseSettings(value: Readonly<Record<string, unknown>>): RoomSettings {
  const capabilities = requireRecord(value, 'capabilities');
  const purge = value['purge'];
  return {
    roomId: requireString(value, 'roomId'),
    state: oneOf(STATES, value['state']),
    revision: requireNumber(value, 'revision'),
    publishedRevision: requireNumber(value, 'publishedRevision'),
    auditRetentionYears: requireNumber(value, 'auditRetentionYears'),
    defaultGrantExpiresAt: instantOrNull(value['defaultGrantExpiresAt']),
    downloadPolicy: value['downloadPolicy'] === null ? null : oneOf(POLICIES, value['downloadPolicy']),
    installationDownloadPolicy: oneOf(POLICIES, value['installationDownloadPolicy']),
    purge:
      purge === null
        ? null
        : (() => {
            if (!isRecord(purge)) throw new ApiError('unavailable');
            const purgeAfter = instantOrNull(purge['purgeAfter']);
            if (purgeAfter === null) throw new ApiError('unavailable');
            return {
              purgeId: requireString(purge, 'purgeId'),
              state: oneOf(PURGE_STATES, purge['state']),
              purgeAfter,
            };
          })(),
    capabilities: {
      publish: requireBoolean(capabilities, 'publish'),
      archive: requireBoolean(capabilities, 'archive'),
      returnToDraft: requireBoolean(capabilities, 'returnToDraft'),
      setRetention: requireBoolean(capabilities, 'setRetention'),
      schedulePurge: requireBoolean(capabilities, 'schedulePurge'),
      cancelPurge: requireBoolean(capabilities, 'cancelPurge'),
    },
  };
}

export async function loadRoomSettings(roomId: string, signal?: AbortSignal): Promise<RoomSettingsView> {
  const payload = await json({
    method: 'GET',
    path: `/api/rooms/settings?roomId=${encodeURIComponent(roomId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const overrides = requireArray(payload, 'downloadOverrides').map((entry) => {
    if (!isRecord(entry)) throw new ApiError('unavailable');
    return [requireString(entry, 'documentId'), oneOf(POLICIES, entry['policy'])] as const;
  });
  return { settings: parseSettings(requireRecord(payload, 'settings')), downloadOverrides: new Map(overrides) };
}

export async function reviewVisibility(roomId: string, state: ReviewedVisibility): Promise<VisibilityImpact> {
  const payload = await json({
    method: 'POST',
    path: '/api/rooms/visibility',
    body: { action: 'dry-run', roomId, state },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const impact = requireRecord(payload, 'impact');
  return {
    roomId: requireString(impact, 'roomId'),
    currentState: oneOf(STATES, impact['currentState']),
    proposedState: oneOf(REVIEWED, impact['proposedState']),
    viewerCount: requireNumber(impact, 'viewerCount'),
    publishedDocumentCount: requireNumber(impact, 'publishedDocumentCount'),
    requiresFreshAuthentication: requireBoolean(impact, 'requiresFreshAuthentication'),
    expectedRevision: requireNumber(impact, 'expectedRevision'),
    confirmation: requireString(impact, 'confirmation'),
  };
}

export async function applyVisibility(roomId: string, change: VisibilityChange): Promise<void> {
  const payload = await json({
    method: 'POST',
    path: '/api/rooms/visibility',
    body: { action: 'apply', roomId, ...change },
  });
  if (!isRecord(payload) || typeof payload['revision'] !== 'number') throw new ApiError('unavailable');
}
```

Re-export the calls and types from `api/client.ts`.

- [x] **Step 4: Write the dialog**

Create `apps/web-client/src/components/ConfirmationDialog.tsx`:

```tsx
/**
 * One dialog for every reviewed or typed confirmation in room administration.
 *
 * The consequence is stated before the field that unlocks the action (§6.3). A phrase,
 * when the change has one, is the server's: compared exactly and submitted exactly as
 * typed. A change without one still states its consequence and takes one deliberate press.
 *
 * The dialog owns its pending and failure state: it closes when `confirm` resolves null
 * and otherwise stays open showing the refusal. Dismissal is suppressed while a change is
 * in flight so its outcome is never lost. Cancel takes initial focus.
 */
import { Dialog } from '@base-ui/react/dialog';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { translate } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { FailureNotice } from './FailureNotice.tsx';

export type Confirmation =
  | { readonly phrase: string; readonly confirm: (typed: string) => Promise<PresentedFailure | null> }
  | { readonly phrase: null; readonly confirm: () => Promise<PresentedFailure | null> };

export type ConfirmationContent =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: PresentedFailure }
  | { readonly kind: 'ready'; readonly consequence: ReactNode; readonly confirmation: Confirmation };

export interface ConfirmationBodyProps {
  readonly content: ConfirmationContent;
  readonly consequenceId: string;
  readonly typed: string;
  readonly pending: boolean;
  readonly failure: PresentedFailure | null;
  readonly onTypedChange: (value: string) => void;
  readonly onReload: () => void;
}

export function ConfirmationBody({
  content,
  consequenceId,
  typed,
  pending,
  failure,
  onTypedChange,
  onReload,
}: ConfirmationBodyProps): React.ReactElement {
  const fieldId = useId();
  if (content.kind === 'loading')
    return (
      <p className="df-field__help" role="status">
        {translate('confirm.loading')}
      </p>
    );
  if (content.kind === 'failed') return <FailureNotice failure={content.failure} onReload={onReload} />;
  const { phrase } = content.confirmation;
  return (
    <>
      <div id={consequenceId}>{content.consequence}</div>
      {phrase === null ? null : (
        <div className="df-field">
          <label className="df-field__label" htmlFor={fieldId}>
            {translate('confirm.typeToConfirm', { phrase })}
          </label>
          <input
            id={fieldId}
            className="df-field__input"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            disabled={pending}
            onChange={(event) => {
              onTypedChange(event.target.value);
            }}
          />
        </div>
      )}
      {failure === null ? null : <FailureNotice failure={failure} onReload={onReload} />}
    </>
  );
}

export interface ConfirmationDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly submitLabel: string;
  readonly pendingLabel: string;
  readonly content: ConfirmationContent;
  readonly onClose: () => void;
  readonly onReload: () => void;
}

export function ConfirmationDialog({
  open,
  title,
  submitLabel,
  pendingLabel,
  content,
  onClose,
  onReload,
}: ConfirmationDialogProps): React.ReactElement {
  const consequenceId = useId();
  const cancel = useRef<HTMLButtonElement | null>(null);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<PresentedFailure | null>(null);

  useEffect(() => {
    if (open) return;
    setTyped('');
    setFailure(null);
  }, [open]);

  const run = async (confirmation: Confirmation): Promise<void> => {
    setPending(true);
    setFailure(null);
    const refused = await (confirmation.phrase === null ? confirmation.confirm() : confirmation.confirm(typed));
    setPending(false);
    if (refused === null) onClose();
    else setFailure(refused);
  };

  const ready = content.kind === 'ready' ? content.confirmation : null;
  const unlocked = ready !== null && (ready.phrase === null || typed === ready.phrase);

  return (
    <Dialog.Root
      open={open}
      disablePointerDismissal={pending}
      onOpenChange={(next, eventDetails) => {
        if (!next && pending) {
          eventDetails.cancel();
          return;
        }
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="df-modal__backdrop" />
        <Dialog.Viewport className="df-modal">
          <Dialog.Popup
            className="df-modal__panel"
            initialFocus={cancel}
            aria-describedby={ready === null ? undefined : consequenceId}
          >
            <Dialog.Title className="df-modal__title">{title}</Dialog.Title>
            <ConfirmationBody
              content={content}
              consequenceId={consequenceId}
              typed={typed}
              pending={pending}
              failure={failure}
              onTypedChange={setTyped}
              onReload={onReload}
            />
            <div className="df-modal__actions">
              <Dialog.Close className="df-button" ref={cancel} disabled={pending}>
                {translate('structure.cancel')}
              </Dialog.Close>
              {ready === null ? null : (
                <button
                  type="button"
                  className="df-button df-button--primary"
                  data-busy={pending ? 'true' : 'false'}
                  disabled={pending || !unlocked}
                  onClick={() => {
                    void run(ready);
                  }}
                >
                  {pending ? pendingLabel : submitLabel}
                </button>
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [x] **Step 5: Write the hook and the pure helper**

Create `apps/web-client/src/workspace/useRoomSettings.ts`:

```ts
/**
 * One room's settings: the load, and every change a Room Manager can make to them.
 *
 * Reads return an `Outcome`; mutations return null when they committed. A committed
 * change re-reads the settings and tells the frame, because the room revision other
 * sections send has moved. No state here describes a mutation in flight: the dialog that
 * started it owns that.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  applyVisibility,
  loadRoomSettings,
  reviewVisibility,
  type ReviewedVisibility,
  type RoomSettingsView,
  type VisibilityChange,
  type VisibilityImpact,
} from '../api/client.ts';
import { presentFailure, type PresentedFailure } from './failures.ts';
import { committed, settle, type Outcome } from './outcome.ts';
import type { Load } from './state.ts';

export interface RoomSettingsSection {
  readonly load: Load<RoomSettingsView>;
  /** The presented cause of a failed load, for choosing its recovery. */
  readonly failure: PresentedFailure | null;
  readonly reload: () => void;
  readonly reviewVisibility: (state: ReviewedVisibility) => Promise<Outcome<VisibilityImpact>>;
  readonly applyVisibility: (change: VisibilityChange) => Promise<PresentedFailure | null>;
}

interface Read {
  readonly roomId: string;
  readonly load: Load<RoomSettingsView>;
  readonly failure: PresentedFailure | null;
}

export function useRoomSettings(roomId: string | null, onChanged: () => void): RoomSettingsSection | null {
  const [token, setToken] = useState(0);
  const [read, setRead] = useState<Read | null>(null);

  useEffect(() => {
    if (roomId === null) return;
    const controller = new AbortController();
    loadRoomSettings(roomId, controller.signal).then(
      (value) => {
        setRead({ roomId, load: { kind: 'ready', value }, failure: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const failure = presentFailure(error);
        setRead({ roomId, load: { kind: 'failed', failure: failure.body }, failure });
      },
    );
    return () => {
      controller.abort();
    };
  }, [roomId, token]);

  const reload = useCallback(() => {
    setToken((current) => current + 1);
  }, []);

  const commit = useCallback(
    async (work: Promise<unknown>): Promise<PresentedFailure | null> => {
      const failure = await committed(work);
      if (failure === null) {
        reload();
        onChanged();
      }
      return failure;
    },
    [reload, onChanged],
  );

  if (roomId === null) return null;
  const current = read !== null && read.roomId === roomId ? read : null;
  return {
    load: current?.load ?? { kind: 'loading' },
    failure: current?.failure ?? null,
    reload,
    reviewVisibility: (state) => settle(reviewVisibility(roomId, state)),
    applyVisibility: (change) => commit(applyVisibility(roomId, change)),
  };
}
```

`current?.load ?? { kind: 'loading' }` is the defined state before the first read for this room completes, not a substitute for a failure: a failed read is stored and returned as `failed`.

Create `apps/web-client/src/workspace/room-settings.ts`:

```ts
/** Pure derivations for the Settings section, kept testable without a DOM. */
import type { DownloadPolicy, RoomSettings } from '../api/client.ts';
import type { MessageKey } from '../i18n/translate.ts';

const LIVE_PURGE = new Set(['scheduled', 'marker_pending', 'purging']);

/** Why a visibility control the member might expect is absent, stated from server facts. */
export function visibilityNotes(settings: RoomSettings): readonly MessageKey[] {
  const notes: MessageKey[] = [];
  if (settings.state === 'draft' && settings.publishedRevision === 0)
    notes.push('settings.visibility.publishStructureFirst');
  if (settings.state === 'archived' && settings.purge !== null && LIVE_PURGE.has(settings.purge.state))
    notes.push('settings.visibility.pinnedByPurge');
  return notes;
}

/** The policy a document without its own exception resolves to (§9.3). */
export function roomDownloadPolicy(settings: RoomSettings): DownloadPolicy {
  return settings.downloadPolicy ?? settings.installationDownloadPolicy;
}
```

`roomDownloadPolicy` is the resolution order the spec defines, not a fallback: an unset room policy *means* the installation default.

- [x] **Step 6: Write the visibility controls and the panel**

Create `apps/web-client/src/components/RoomVisibilityControls.tsx`:

```tsx
/**
 * Publish, archive, return to draft — each offered only where its capability is true.
 *
 * Publishing and archiving open the dialog on the server's review; returning to draft is
 * the kill switch and opens it on a stated consequence with no phrase. A review that
 * resolves after its dialog was closed or replaced is dropped.
 */
import { useState } from 'react';
import type {
  RoomSettings,
  RoomState,
  VisibilityChange,
  VisibilityImpact,
} from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { visibilityNotes } from '../workspace/room-settings.ts';
import type { RoomSettingsSection } from '../workspace/useRoomSettings.ts';
import { ConfirmationDialog, type ConfirmationContent } from './ConfirmationDialog.tsx';

const STATE_COPY: Readonly<Record<RoomState, { readonly name: MessageKey; readonly explain: MessageKey }>> = {
  draft: { name: 'rooms.state.draft', explain: 'rooms.state.draft.explain' },
  published: { name: 'rooms.state.published', explain: 'rooms.state.published.explain' },
  archived: { name: 'rooms.state.archived', explain: 'rooms.state.archived.explain' },
};

const COPY: Readonly<Record<RoomState, { readonly action: MessageKey; readonly title: MessageKey; readonly done: MessageKey }>> = {
  published: {
    action: 'settings.visibility.publish',
    title: 'settings.visibility.publish.title',
    done: 'settings.visibility.done.published',
  },
  archived: {
    action: 'settings.visibility.archive',
    title: 'settings.visibility.archive.title',
    done: 'settings.visibility.done.archived',
  },
  draft: {
    action: 'settings.visibility.returnToDraft',
    title: 'settings.visibility.draft.title',
    done: 'settings.visibility.done.draft',
  },
};

function VisibilityConsequence({ impact }: { readonly impact: VisibilityImpact }): React.ReactElement {
  const values = { viewers: impact.viewerCount, documents: impact.publishedDocumentCount };
  return (
    <>
      <p>
        {impact.proposedState === 'published'
          ? translate('settings.visibility.publish.consequence', values)
          : translate('settings.visibility.archive.consequence', values)}
      </p>
      {impact.requiresFreshAuthentication ? (
        <p className="df-field__help">{translate('settings.visibility.freshSignIn')}</p>
      ) : null}
    </>
  );
}

export interface RoomVisibilityControlsProps {
  readonly settings: RoomSettings;
  readonly section: RoomSettingsSection;
  readonly onStatus: (message: string) => void;
}

export function RoomVisibilityControls({
  settings,
  section,
  onStatus,
}: RoomVisibilityControlsProps): React.ReactElement {
  const [dialogue, setDialogue] = useState<{ readonly state: RoomState; readonly content: ConfirmationContent } | null>(null);
  const capabilities = settings.capabilities;

  const finish = async (change: VisibilityChange): Promise<PresentedFailure | null> => {
    const failure = await section.applyVisibility(change);
    if (failure === null) onStatus(translate(COPY[change.state].done));
    return failure;
  };

  const begin = (state: RoomState): void => {
    if (state === 'draft') {
      setDialogue({
        state,
        content: {
          kind: 'ready',
          consequence: <p>{translate('settings.visibility.draft.consequence')}</p>,
          confirmation: {
            phrase: null,
            confirm: () => finish({ state: 'draft', expectedRevision: settings.revision }),
          },
        },
      });
      return;
    }
    setDialogue({ state, content: { kind: 'loading' } });
    void section.reviewVisibility(state).then((outcome) => {
      setDialogue((current) =>
        current?.state !== state
          ? current
          : {
              state,
              content: outcome.ok
                ? {
                    kind: 'ready',
                    consequence: <VisibilityConsequence impact={outcome.value} />,
                    confirmation: {
                      phrase: outcome.value.confirmation,
                      confirm: (typed) =>
                        finish({ state, expectedRevision: outcome.value.expectedRevision, confirmation: typed }),
                    },
                  }
                : { kind: 'failed', failure: outcome.failure },
            },
      );
    });
  };

  const offered: readonly [RoomState, boolean][] = [
    ['published', capabilities.publish],
    ['archived', capabilities.archive],
    ['draft', capabilities.returnToDraft],
  ];

  return (
    <div className="df-panel__block">
      <h3 className="df-panel__subheading">{translate('settings.visibility.heading')}</h3>
      <p>
        <strong>{translate(STATE_COPY[settings.state].name)}</strong> —{' '}
        {translate(STATE_COPY[settings.state].explain)}
      </p>
      {visibilityNotes(settings).map((note) => (
        <p key={note} className="df-field__help">
          {translate(note)}
        </p>
      ))}
      <div className="df-panel__actions">
        {offered
          .filter(([, allowed]) => allowed)
          .map(([state]) => (
            <button
              key={state}
              type="button"
              className={state === 'draft' ? 'df-button' : 'df-button df-button--primary'}
              onClick={() => {
                begin(state);
              }}
            >
              {translate(COPY[state].action)}
            </button>
          ))}
      </div>
      <ConfirmationDialog
        open={dialogue !== null}
        title={dialogue === null ? '' : translate(COPY[dialogue.state].title)}
        submitLabel={dialogue === null ? '' : translate(COPY[dialogue.state].action)}
        pendingLabel={translate('settings.pending')}
        content={dialogue?.content ?? { kind: 'loading' }}
        onClose={() => {
          setDialogue(null);
        }}
        onReload={section.reload}
      />
    </div>
  );
}
```

Create `apps/web-client/src/components/RoomSettingsPanel.tsx`:

```tsx
/**
 * The room Settings section. It owns its state through `useRoomSettings`; the room view
 * only chooses whether to offer it.
 */
import { useId } from 'react';
import { translate } from '../i18n/translate.ts';
import type { RoomSettingsSection } from '../workspace/useRoomSettings.ts';
import { classifyLoad } from '../workspace/views/load-state.ts';
import { FailureNotice } from './FailureNotice.tsx';
import { Notice } from './Notice.tsx';
import { RoomVisibilityControls } from './RoomVisibilityControls.tsx';

export interface RoomSettingsPanelProps {
  readonly section: RoomSettingsSection;
  readonly onStatus: (message: string) => void;
}

export function RoomSettingsPanel({ section, onStatus }: RoomSettingsPanelProps): React.ReactElement {
  const headingId = useId();
  const load = section.load;
  const heading = (
    <h2 id={headingId} className="df-section__heading">
      {translate('settings.heading')}
    </h2>
  );

  if (load.kind === 'loading')
    return (
      <section aria-labelledby={headingId}>
        {heading}
        <p className="df-field__help">{translate('settings.loading')}</p>
      </section>
    );

  if (load.kind === 'failed') {
    const state = classifyLoad({ failed: true, failure: section.failure });
    return (
      <section aria-labelledby={headingId}>
        {heading}
        {state.denied ? (
          <Notice tone="caution" role="status">
            {translate('settings.denied')}
          </Notice>
        ) : section.failure === null ? null : (
          <FailureNotice failure={section.failure} onReload={section.reload} />
        )}
        {/* A stale revision already offers Reload inside the notice. */}
        {state.recovery === 'retry' && section.failure?.offerReload !== true ? (
          <button type="button" className="df-button" onClick={section.reload}>
            {translate('app.retry')}
          </button>
        ) : null}
      </section>
    );
  }

  const { settings } = load.value;
  return (
    <section aria-labelledby={headingId}>
      {heading}
      <RoomVisibilityControls settings={settings} section={section} onStatus={onStatus} />
    </section>
  );
}
```

- [x] **Step 7: Offer the section on Room Manager authority**

In `apps/web-client/src/workspace/views/RoomView.tsx`:

1. Move the core tab literal out of the component into a module constant `CORE_ROOM_TABS` (same entries, same `as const satisfies readonly SectionTab[]`), and add beside it:

```ts
const SETTINGS_TAB = {
  id: 'settings',
  scope: 'room',
  label: () => translate('workspace.tab.settings'),
  /* After the branding contribution (50): Settings closes the strip. */
  order: 60,
} as const satisfies SectionTab;
```

2. After the existing section hooks:

```ts
  /* Offered on Room Manager authority, the register row's `canPublish`. The reader
     refuses anyone else independently. */
  const settings = useRoomSettings(room?.canPublish === true ? roomId : null, onRoomsChanged);
```

3. Compose with it:

```ts
  const sections = composeSections(
    [...CORE_ROOM_TABS, ...(settings === null ? [] : [SETTINGS_TAB])],
    contributedSections('room'),
  );
```

4. Before the contributed-section render line:

```tsx
      {currentId === 'settings' && settings !== null ? (
        <RoomSettingsPanel section={settings} onStatus={onStatus} />
      ) : null}
```

- [x] **Step 8: Add the copy**

```ts
  'workspace.tab.settings': 'Settings',
  'settings.heading': 'Room settings',
  'settings.loading': 'Loading room settings',
  'settings.denied': 'Room settings are not available to your role.',
  'settings.pending': 'Applying…',
  'settings.visibility.heading': 'Visibility',
  'settings.visibility.publish': 'Publish room',
  'settings.visibility.archive': 'Archive room',
  'settings.visibility.returnToDraft': 'Return to draft',
  'settings.visibility.publish.title': 'Publish this room',
  'settings.visibility.archive.title': 'Archive this room',
  'settings.visibility.draft.title': 'Return this room to draft',
  'settings.visibility.publish.consequence':
    'Viewers with a grant will be able to read the published collection. Viewers who gain access: {viewers}. Published documents: {documents}.',
  'settings.visibility.archive.consequence':
    'Viewers lose all content access now. Records and exports remain, and the room can return to draft later. Viewers who lose access: {viewers}.',
  'settings.visibility.draft.consequence':
    'Every viewer loses access to this room immediately. Nothing is deleted, and the room can be published again.',
  'settings.visibility.freshSignIn': 'Publishing needs a sign-in from the last 15 minutes.',
  'settings.visibility.publishStructureFirst':
    'Publish the collection at least once before making the room visible to viewers.',
  'settings.visibility.pinnedByPurge':
    'A purge is scheduled. Cancel it before returning this room to draft.',
  'settings.visibility.done.published': 'Room published.',
  'settings.visibility.done.archived': 'Room archived.',
  'settings.visibility.done.draft': 'Room returned to draft. Viewers no longer have access.',
  'confirm.loading': 'Preparing the review…',
  'confirm.typeToConfirm': 'Type {phrase} to confirm',
```

- [x] **Step 9: Run the tests to verify they pass**

```bash
npx vitest run --project unit --maxWorkers=2
npm run typecheck && npm run lint
wc -l apps/web-client/src/workspace/views/RoomView.tsx
```

Expected: PASS.

- [x] **Step 10: Commit**

```bash
git add apps/web-client/src
git commit -m "Add the room Settings section with reviewed visibility changes"
```

---

### Task 10: Room download policy and default grant expiry

**Files:**
- Modify: `apps/web-client/src/api/room-settings.ts` (append), `apps/web-client/src/api/room-settings.unit.test.ts`
- Modify: `apps/web-client/src/workspace/useRoomSettings.ts` (extend `RoomSettingsSection`)
- Create: `apps/web-client/src/components/RoomPolicyControls.tsx`
- Modify: `apps/web-client/src/components/RoomSettingsPanel.tsx` (render it)
- Modify: `apps/web-client/src/workspace/room-settings.ts`, `room-settings.unit.test.ts` (`expiryDisplay`)
- Modify: `apps/web-client/src/i18n/en.ts`

**Interfaces:**
- Consumes: `POST /api/policies` (Task 6); `expiryInstant`, `formatDate` from `workspace/grants.ts`.
- Produces:
  - Calls `setRoomDownloadPolicy(roomId, policy, expectedRoomRevision)`, `reviewDefaultExpiry(roomId, expiresAt)`, `applyDefaultExpiry(roomId, expiresAt, expectedRoomRevision, confirmation)`; type `DefaultExpiryImpact`.
  - `RoomSettingsSection` gains `setRoomDownloadPolicy(policy, expectedRoomRevision)`, `reviewDefaultExpiry(expiresAt)`, `applyDefaultExpiry(expiresAt, expectedRoomRevision, confirmation)`.
  - `expiryDisplay(instant: string): {local: string; utc: string}` — §9.2's localized time with the UTC value.
  - `parseExpiryField(value)` — `{ok: true, expiresAt}` or `{ok: false}`.

The download choice is three-valued and says what "inherit" resolves to. Allowing downloads widens access to original bytes, so saving opens the confirmation dialog on a stated consequence; the value is applied by one deliberate press, with no phrase, because §9.4 does not list download policy as high-consequence. Default expiry shows the exact inherited instant before confirmation (§9.2) and uses the server's phrase.

- [x] **Step 1: Write the failing unit tests**

Append to `apps/web-client/src/api/room-settings.unit.test.ts`:

```ts
describe('reviewDefaultExpiry', () => {
  it('keeps the exact instant new grants will inherit', async () => {
    stub({
      impact: {
        affectedCount: 1, paths: ['Series A'], resolvedExpiresAt: '2027-09-21T23:59:59.999+00:00',
        confirmation: 'CHANGE DEFAULT EXPIRY FOR 1 ROOM', message: 'x',
      },
    });
    const impact = await reviewDefaultExpiry(ID, '2027-09-21T23:59:59.999Z');
    expect(impact.resolvedExpiresAt).toBe('2027-09-21T23:59:59.999+00:00');
  });
});
```

Append to `apps/web-client/src/workspace/room-settings.unit.test.ts`:

```ts
describe('expiryDisplay', () => {
  it('always carries the UTC value beside the localized one', () => {
    expect(expiryDisplay('2027-09-21T23:59:59.999+00:00').utc).toBe('2027-09-21 23:59 UTC');
  });
});

describe('parseExpiryField', () => {
  it('reads empty as no default and a date as the end of that UTC day', () => {
    expect(parseExpiryField('')).toStrictEqual({ ok: true, expiresAt: null });
    expect(parseExpiryField('2027-09-21')).toStrictEqual({ ok: true, expiresAt: '2027-09-21T23:59:59.999Z' });
  });

  it('never turns an unreadable date into no default', () => {
    expect(parseExpiryField('21/09/2027')).toStrictEqual({ ok: false });
  });
});
```

- [x] **Step 2: Run them to verify they fail**

```bash
npx vitest run --project unit --maxWorkers=2 room-settings
```

Expected: FAIL — `reviewDefaultExpiry`, `expiryDisplay` and `parseExpiryField` do not exist.

- [x] **Step 3: Append the calls**

Append to `apps/web-client/src/api/room-settings.ts`:

```ts
export interface DefaultExpiryImpact {
  readonly resolvedExpiresAt: string | null;
  readonly confirmation: string;
}

function parseExpiryImpact(payload: unknown): DefaultExpiryImpact {
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const impact = requireRecord(payload, 'impact');
  return {
    resolvedExpiresAt: instantOrNull(impact['resolvedExpiresAt']),
    confirmation: requireString(impact, 'confirmation'),
  };
}

export async function setRoomDownloadPolicy(
  roomId: string,
  policy: DownloadPolicy | null,
  expectedRoomRevision: number,
): Promise<void> {
  const payload = await json({
    method: 'POST',
    path: '/api/policies',
    body: { action: 'room-download', roomId, policy, expectedRoomRevision },
  });
  if (!isRecord(payload) || typeof payload['roomRevision'] !== 'number') throw new ApiError('unavailable');
}

export async function reviewDefaultExpiry(roomId: string, expiresAt: string | null): Promise<DefaultExpiryImpact> {
  return parseExpiryImpact(
    await json({ method: 'POST', path: '/api/policies', body: { action: 'default-expiry-dry-run', roomId, expiresAt } }),
  );
}

export async function applyDefaultExpiry(
  roomId: string,
  expiresAt: string | null,
  expectedRoomRevision: number,
  confirmation: string,
): Promise<void> {
  parseExpiryImpact(
    await json({
      method: 'POST',
      path: '/api/policies',
      body: { action: 'default-expiry-apply', roomId, expiresAt, expectedRoomRevision, confirmation },
    }),
  );
}
```

Extend `RoomSettingsSection` and the hook's returned object:

```ts
  readonly setRoomDownloadPolicy: (policy: DownloadPolicy | null, expectedRoomRevision: number) => Promise<PresentedFailure | null>;
  readonly reviewDefaultExpiry: (expiresAt: string | null) => Promise<Outcome<DefaultExpiryImpact>>;
  readonly applyDefaultExpiry: (
    expiresAt: string | null,
    expectedRoomRevision: number,
    confirmation: string,
  ) => Promise<PresentedFailure | null>;
```

```ts
    setRoomDownloadPolicy: (policy, expected) => commit(setRoomDownloadPolicy(roomId, policy, expected)),
    reviewDefaultExpiry: (expiresAt) => settle(reviewDefaultExpiry(roomId, expiresAt)),
    applyDefaultExpiry: (expiresAt, expected, confirmation) =>
      commit(applyDefaultExpiry(roomId, expiresAt, expected, confirmation)),
```

Append to `apps/web-client/src/workspace/room-settings.ts`:

```ts
import { expiryInstant, formatDate } from './grants.ts';

/**
 * The default-expiry field: empty means no default, a date means the end of that UTC day,
 * anything else is not reviewable. Never collapses an unreadable date into "no default".
 */
export function parseExpiryField(
  value: string,
): { readonly ok: true; readonly expiresAt: string | null } | { readonly ok: false } {
  if (value === '') return { ok: true, expiresAt: null };
  const instant = expiryInstant(value);
  return instant === null ? { ok: false } : { ok: true, expiresAt: instant.toISOString() };
}

/** §9.2: localized time, with the UTC value always available beside it. */
export function expiryDisplay(instant: string): { readonly local: string; readonly utc: string } {
  const iso = new Date(instant).toISOString();
  return { local: formatDate(instant), utc: `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` };
}
```

Check `formatDate`'s signature in `grants.ts` and pass what it takes.

- [x] **Step 4: Write the controls**

Create `apps/web-client/src/components/RoomPolicyControls.tsx`:

```tsx
/**
 * Room download policy and default grant expiry.
 *
 * Inheriting is a real choice with a stated value, not an absence. Both changes open the
 * confirmation dialog on their consequence; default expiry shows the exact instant new
 * grants will inherit (§9.2) and requires the server's phrase.
 */
import { useId, useState } from 'react';
import type { DownloadPolicy, RoomSettings } from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';
import { expiryDisplay, parseExpiryField } from '../workspace/room-settings.ts';
import type { RoomSettingsSection } from '../workspace/useRoomSettings.ts';
import { ConfirmationDialog, type ConfirmationContent } from './ConfirmationDialog.tsx';

type Choice = DownloadPolicy | 'inherit';

const CONSEQUENCE: Readonly<Record<Choice, MessageKey>> = {
  allow: 'settings.download.consequence.allow',
  deny: 'settings.download.consequence.deny',
  inherit: 'settings.download.consequence.inherit',
};
const POLICY_WORD: Readonly<Record<DownloadPolicy, MessageKey>> = {
  allow: 'settings.download.word.allow',
  deny: 'settings.download.word.deny',
};

export interface RoomPolicyControlsProps {
  readonly settings: RoomSettings;
  readonly overrideCount: number;
  readonly section: RoomSettingsSection;
  readonly onStatus: (message: string) => void;
}

export function RoomPolicyControls({
  settings,
  overrideCount,
  section,
  onStatus,
}: RoomPolicyControlsProps): React.ReactElement {
  const legendId = useId();
  const expiryField = useId();
  const current: Choice = settings.downloadPolicy ?? 'inherit';
  const [choice, setChoice] = useState<Choice>(current);
  const [expiresOn, setExpiresOn] = useState('');
  const [dialogue, setDialogue] = useState<{
    readonly title: MessageKey;
    readonly submit: MessageKey;
    readonly content: ConfirmationContent;
  } | null>(null);
  const installation = translate(POLICY_WORD[settings.installationDownloadPolicy]);

  const saveDownloads = (): void => {
    setDialogue({
      title: 'settings.download.title',
      submit: 'settings.download.save',
      content: {
        kind: 'ready',
        consequence: <p>{translate(CONSEQUENCE[choice], { policy: installation })}</p>,
        confirmation: {
          phrase: null,
          confirm: async () => {
            const failure = await section.setRoomDownloadPolicy(choice === 'inherit' ? null : choice, settings.revision);
            if (failure === null) onStatus(translate('settings.download.done'));
            return failure;
          },
        },
      },
    });
  };

  const expiry = parseExpiryField(expiresOn);

  const reviewExpiry = (expiresAt: string | null): void => {
    setDialogue({ title: 'settings.expiry.title', submit: 'settings.expiry.apply', content: { kind: 'loading' } });
    void section.reviewDefaultExpiry(expiresAt).then((outcome) => {
      setDialogue((open) =>
        open?.title !== 'settings.expiry.title'
          ? open
          : {
              ...open,
              content: outcome.ok
                ? {
                    kind: 'ready',
                    consequence: (
                      <p>
                        {outcome.value.resolvedExpiresAt === null
                          ? translate('settings.expiry.consequenceNone')
                          : translate('settings.expiry.consequence', expiryDisplay(outcome.value.resolvedExpiresAt))}
                      </p>
                    ),
                    confirmation: {
                      phrase: outcome.value.confirmation,
                      confirm: async (typed) => {
                        const failure = await section.applyDefaultExpiry(expiresAt, settings.revision, typed);
                        if (failure === null) onStatus(translate('settings.expiry.done'));
                        return failure;
                      },
                    },
                  }
                : { kind: 'failed', failure: outcome.failure },
            },
      );
    });
  };

  return (
    <>
      <fieldset className="df-panel__block" aria-labelledby={legendId}>
        <legend id={legendId} className="df-panel__subheading">
          {translate('settings.download.heading')}
        </legend>
        {(['inherit', 'allow', 'deny'] as const).map((value) => (
          <label key={value} className="df-field__choice">
            <input
              type="radio"
              name={legendId}
              value={value}
              checked={choice === value}
              onChange={() => {
                setChoice(value);
              }}
            />
            {value === 'inherit'
              ? translate('settings.download.inherit', { policy: installation })
              : translate(value === 'allow' ? 'settings.download.allow' : 'settings.download.deny')}
          </label>
        ))}
        <p className="df-field__help">{translate('settings.download.exceptions', { count: overrideCount })}</p>
        <div className="df-panel__actions">
          <button type="button" className="df-button" disabled={choice === current} onClick={saveDownloads}>
            {translate('settings.download.save')}
          </button>
        </div>
      </fieldset>

      <div className="df-panel__block">
        <h3 className="df-panel__subheading">{translate('settings.expiry.heading')}</h3>
        <p>
          {settings.defaultGrantExpiresAt === null
            ? translate('settings.expiry.none')
            : translate('settings.expiry.current', expiryDisplay(settings.defaultGrantExpiresAt))}
        </p>
        <div className="df-field">
          <label className="df-field__label" htmlFor={expiryField}>
            {translate('settings.expiry.label')}
          </label>
          <input
            id={expiryField}
            type="date"
            className="df-field__input"
            value={expiresOn}
            onChange={(event) => {
              setExpiresOn(event.target.value);
            }}
          />
          <p className="df-field__help">{translate('settings.expiry.help')}</p>
        </div>
        <div className="df-panel__actions">
          <button
            type="button"
            className="df-button"
            disabled={!expiry.ok}
            onClick={() => {
              if (expiry.ok) reviewExpiry(expiry.expiresAt);
            }}
          >
            {translate('settings.expiry.review')}
          </button>
        </div>
      </div>

      <ConfirmationDialog
        open={dialogue !== null}
        title={dialogue === null ? '' : translate(dialogue.title)}
        submitLabel={dialogue === null ? '' : translate(dialogue.submit)}
        pendingLabel={translate('settings.pending')}
        content={dialogue?.content ?? { kind: 'loading' }}
        onClose={() => {
          setDialogue(null);
        }}
        onReload={section.reload}
      />
    </>
  );
}
```

The empty field means "no default expiry", which the server accepts as `null`; a non-empty field that is not a date is not reviewable at all, so it can never be sent as "no default". After a committed change the settings re-read, so `choice` must follow: key `RoomPolicyControls` on `settings.revision` in `RoomSettingsPanel` so its local choice resets to the new value.

Render it in `RoomSettingsPanel` after the visibility controls:

```tsx
      <RoomPolicyControls
        key={settings.revision}
        settings={settings}
        overrideCount={load.value.downloadOverrides.size}
        section={section}
        onStatus={onStatus}
      />
```

- [x] **Step 5: Add the copy**

```ts
  'settings.download.heading': 'Original downloads',
  'settings.download.inherit': 'Use the installation default ({policy})',
  'settings.download.allow': 'Allow downloads',
  'settings.download.deny': 'Deny downloads',
  'settings.download.word.allow': 'allowed',
  'settings.download.word.deny': 'denied',
  'settings.download.exceptions': 'Documents with their own download policy: {count}.',
  'settings.download.save': 'Save download policy',
  'settings.download.title': 'Change the download policy',
  'settings.download.consequence.allow':
    'Viewers who can read a document in this room will be able to download its original, unless the document has its own policy.',
  'settings.download.consequence.deny':
    'Viewers will not be able to download originals from this room, unless a document has its own policy.',
  'settings.download.consequence.inherit':
    'This room will follow the installation default, which is currently {policy}.',
  'settings.download.done': 'Download policy saved.',
  'settings.expiry.heading': 'Default grant expiry',
  'settings.expiry.none': 'New grants do not expire unless they set their own date.',
  'settings.expiry.current': 'New grants expire at {local} ({utc}).',
  'settings.expiry.label': 'New grants expire at the end of',
  'settings.expiry.help': 'Leave empty for no default. Existing grants keep their own expiry.',
  'settings.expiry.review': 'Review expiry change',
  'settings.expiry.apply': 'Change default expiry',
  'settings.expiry.title': 'Change the default grant expiry',
  'settings.expiry.consequence':
    'New grants without their own date will expire at {local} ({utc}). Existing grants are unchanged.',
  'settings.expiry.consequenceNone':
    'New grants will not expire unless they set their own date. Existing grants are unchanged.',
  'settings.expiry.done': 'Default grant expiry changed.',
```

If `df-field__choice` does not exist in the stylesheet, use the radio markup the grant form in `ParticipantsPanel.tsx` uses.

- [x] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run --project unit --maxWorkers=2
npm run typecheck && npm run lint
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/web-client/src
git commit -m "Set a room's download policy and default grant expiry"
```

---

### Task 11: Audit retention and whole-room purge

**Files:**
- Modify: `apps/web-client/src/api/room-settings.ts` (append), `apps/web-client/src/api/room-settings.unit.test.ts`
- Modify: `apps/web-client/src/workspace/useRoomSettings.ts` (extend)
- Modify: `apps/web-client/src/workspace/room-settings.ts`, `room-settings.unit.test.ts` (`formatByteSize`)
- Create: `apps/web-client/src/components/RoomLifecycleControls.tsx`
- Modify: `apps/web-client/src/components/RoomSettingsPanel.tsx` (render it)
- Modify: `apps/web-client/src/i18n/en.ts`

**Interfaces:**
- Consumes: `POST /api/rooms/lifecycle` (`modules/rooms-documents/src/routes/lifecycle.ts`: `retention-dry-run`, `retention-apply`, `purge-dry-run`, `purge-schedule`, `purge-cancel`); the constant phrase `SCHEDULE ROOM PURGE` (Task 2).
- Produces:
  - Calls `reviewRetention`, `applyRetention`, `reviewPurge`, `schedulePurge`, `cancelPurge`; types `RetentionImpact`, `PurgeImpact`.
  - `RoomSettingsSection` gains the five matching members.
  - `formatByteSize(bytes: number): string`.

Retention and purge are Owner-only and freshly authenticated; both are typed and dry-run first (§15.4, §15.5). `cancel_room_purge` compares a constant phrase no dry run returns, so the client holds `CANCEL_PURGE_PHRASE`; its value is asserted end-to-end by the browser journey in Task 14.

- [x] **Step 1: Write the failing unit tests**

Append to `apps/web-client/src/api/room-settings.unit.test.ts`:

```ts
describe('reviewPurge', () => {
  it('parses what the purge will remove', async () => {
    stub({
      purge: {
        roomId: ID, documentCount: 12, viewerCount: 4, sourceBytes: 2_500_000,
        cancellationDays: 30, confirmation: 'SCHEDULE ROOM PURGE',
      },
    });
    expect(await reviewPurge(ID)).toMatchObject({ documentCount: 12, confirmation: 'SCHEDULE ROOM PURGE' });
  });

  it('fails closed on a cancellation period this client does not know', async () => {
    stub({
      purge: {
        roomId: ID, documentCount: 1, viewerCount: 0, sourceBytes: 1,
        cancellationDays: 7, confirmation: 'SCHEDULE ROOM PURGE',
      },
    });
    await expect(reviewPurge(ID)).rejects.toMatchObject({ failure: 'unavailable' });
  });
});
```

Append to `apps/web-client/src/workspace/room-settings.unit.test.ts`:

```ts
describe('formatByteSize', () => {
  it.each([[512, '512 B'], [2_500_000, '2.5 MB'], [3 * 1024 ** 3, '3.2 GB']])('formats %i', (bytes, text) => {
    expect(formatByteSize(bytes)).toBe(text);
  });
});
```

(`formatByteSize` uses decimal units — 1 MB is 10⁶ bytes — so 3 GiB reads 3.2 GB.)

- [x] **Step 2: Run them to verify they fail**

```bash
npx vitest run --project unit --maxWorkers=2 room-settings
```

Expected: FAIL.

- [x] **Step 3: Append the calls and the helper**

Append to `apps/web-client/src/api/room-settings.ts`:

```ts
export interface RetentionImpact {
  readonly currentYears: number;
  readonly proposedYears: number;
  readonly confirmation: string;
}

export interface PurgeImpact {
  readonly documentCount: number;
  readonly viewerCount: number;
  readonly sourceBytes: number;
  readonly cancellationDays: 30;
  readonly confirmation: string;
}

/** `cancel_room_purge` compares this constant; no dry run returns it. */
export const CANCEL_PURGE_PHRASE = 'CANCEL ROOM PURGE';

async function lifecycle(body: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
  const payload = await json({ method: 'POST', path: '/api/rooms/lifecycle', body });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return payload;
}

function parseRetention(payload: Readonly<Record<string, unknown>>): RetentionImpact {
  const impact = requireRecord(payload, 'retention');
  if (impact['existingAuditRowsUnaffected'] !== true) throw new ApiError('unavailable');
  return {
    currentYears: requireNumber(impact, 'currentYears'),
    proposedYears: requireNumber(impact, 'proposedYears'),
    confirmation: requireString(impact, 'confirmation'),
  };
}

function parsePurge(payload: Readonly<Record<string, unknown>>): PurgeImpact {
  const impact = requireRecord(payload, 'purge');
  if (impact['cancellationDays'] !== 30) throw new ApiError('unavailable');
  return {
    documentCount: requireNumber(impact, 'documentCount'),
    viewerCount: requireNumber(impact, 'viewerCount'),
    sourceBytes: requireNumber(impact, 'sourceBytes'),
    cancellationDays: 30,
    confirmation: requireString(impact, 'confirmation'),
  };
}

export async function reviewRetention(roomId: string, years: number): Promise<RetentionImpact> {
  return parseRetention(await lifecycle({ action: 'retention-dry-run', roomId, years }));
}

export async function applyRetention(
  roomId: string, years: number, expectedRevision: number, confirmation: string,
): Promise<void> {
  parseRetention(await lifecycle({ action: 'retention-apply', roomId, years, expectedRevision, confirmation }));
}

export async function reviewPurge(roomId: string): Promise<PurgeImpact> {
  return parsePurge(await lifecycle({ action: 'purge-dry-run', roomId }));
}

export async function schedulePurge(roomId: string, expectedRevision: number, confirmation: string): Promise<void> {
  parsePurge(await lifecycle({ action: 'purge-schedule', roomId, expectedRevision, confirmation }));
}

export async function cancelPurge(purgeId: string): Promise<void> {
  const payload = await lifecycle({ action: 'purge-cancel', purgeId, confirmation: CANCEL_PURGE_PHRASE });
  if (payload['cancelled'] !== true) throw new ApiError('unavailable');
}
```

`cancelPurge` sends the constant because the dialog has already required the Owner to type it exactly; the dialog compares, the server compares again.

Extend `RoomSettingsSection` and the hook:

```ts
  readonly reviewRetention: (years: number) => Promise<Outcome<RetentionImpact>>;
  readonly applyRetention: (years: number, expectedRevision: number, confirmation: string) => Promise<PresentedFailure | null>;
  readonly reviewPurge: () => Promise<Outcome<PurgeImpact>>;
  readonly schedulePurge: (expectedRevision: number, confirmation: string) => Promise<PresentedFailure | null>;
  readonly cancelPurge: (purgeId: string) => Promise<PresentedFailure | null>;
```

```ts
    reviewRetention: (years) => settle(reviewRetention(roomId, years)),
    applyRetention: (years, expected, confirmation) => commit(applyRetention(roomId, years, expected, confirmation)),
    reviewPurge: () => settle(reviewPurge(roomId)),
    schedulePurge: (expected, confirmation) => commit(schedulePurge(roomId, expected, confirmation)),
    cancelPurge: (purgeId) => commit(cancelPurge(purgeId)),
```

Append to `apps/web-client/src/workspace/room-settings.ts`:

```ts
const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const;

/** Decimal units, one significant decimal above bytes. */
export function formatByteSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}
```

- [x] **Step 4: Write the controls**

Create `apps/web-client/src/components/RoomLifecycleControls.tsx`:

```tsx
/**
 * Audit retention and whole-room purge (§15.4, §15.5).
 *
 * Owner-only and freshly authenticated, each reviewed before it is typed. Retention shows
 * its current value always and explains, from server facts, why it cannot change here.
 * Purge appears only for an archived room or a room that already holds one, and a live
 * purge is stated with its exact instant.
 */
import { useId, useState } from 'react';
import { CANCEL_PURGE_PHRASE, type RoomSettings } from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';
import type { Outcome } from '../workspace/outcome.ts';
import { expiryDisplay, formatByteSize } from '../workspace/room-settings.ts';
import type { RoomSettingsSection } from '../workspace/useRoomSettings.ts';
import { ConfirmationDialog, type ConfirmationContent } from './ConfirmationDialog.tsx';
import { Notice } from './Notice.tsx';

type Dialogue = {
  readonly kind: 'retention' | 'schedule' | 'cancel';
  readonly content: ConfirmationContent;
};

const COPY: Readonly<Record<Dialogue['kind'], { readonly title: MessageKey; readonly submit: MessageKey }>> = {
  retention: { title: 'settings.retention.title', submit: 'settings.retention.apply' },
  schedule: { title: 'settings.purge.title', submit: 'settings.purge.schedule' },
  cancel: { title: 'settings.purge.cancelTitle', submit: 'settings.purge.cancel' },
};

const PURGE_STATUS: Readonly<Record<NonNullable<RoomSettings['purge']>['state'], MessageKey>> = {
  scheduled: 'settings.purge.status.scheduled',
  marker_pending: 'settings.purge.status.running',
  purging: 'settings.purge.status.running',
  purged: 'settings.purge.status.purged',
  failed: 'settings.purge.status.failed',
};

export interface RoomLifecycleControlsProps {
  readonly settings: RoomSettings;
  readonly section: RoomSettingsSection;
  readonly onStatus: (message: string) => void;
}

export function RoomLifecycleControls({ settings, section, onStatus }: RoomLifecycleControlsProps): React.ReactElement {
  const yearsField = useId();
  const [years, setYears] = useState(settings.auditRetentionYears);
  const [dialogue, setDialogue] = useState<Dialogue | null>(null);
  const capabilities = settings.capabilities;
  const freshNote = <p className="df-field__help">{translate('settings.lifecycle.freshSignIn')}</p>;

  const review = <T,>(
    kind: Dialogue['kind'],
    load: () => Promise<Outcome<T>>,
    ready: (value: T) => ConfirmationContent,
  ): void => {
    setDialogue({ kind, content: { kind: 'loading' } });
    void load().then((outcome) => {
      setDialogue((open) =>
        open?.kind !== kind ? open : { kind, content: outcome.ok ? ready(outcome.value) : { kind: 'failed', failure: outcome.failure } },
      );
    });
  };

  const reviewRetention = (): void => {
    review('retention', () => section.reviewRetention(years), (impact) => ({
      kind: 'ready',
      consequence: (
        <>
          <p>{translate('settings.retention.consequence', { years: impact.proposedYears })}</p>
          {freshNote}
        </>
      ),
      confirmation: {
        phrase: impact.confirmation,
        confirm: async (typed) => {
          const failure = await section.applyRetention(years, settings.revision, typed);
          if (failure === null) onStatus(translate('settings.retention.done'));
          return failure;
        },
      },
    }));
  };

  const reviewPurge = (): void => {
    review('schedule', () => section.reviewPurge(), (impact) => ({
      kind: 'ready',
      consequence: (
        <>
          <p>{translate('settings.purge.consequence')}</p>
          <p>
            {translate('settings.purge.counts', {
              documents: impact.documentCount,
              viewers: impact.viewerCount,
              size: formatByteSize(impact.sourceBytes),
            })}
          </p>
          {freshNote}
        </>
      ),
      confirmation: {
        phrase: impact.confirmation,
        confirm: async (typed) => {
          const failure = await section.schedulePurge(settings.revision, typed);
          if (failure === null) onStatus(translate('settings.purge.scheduled'));
          return failure;
        },
      },
    }));
  };

  const beginCancel = (purgeId: string): void => {
    setDialogue({
      kind: 'cancel',
      content: {
        kind: 'ready',
        consequence: <p>{translate('settings.purge.cancelConsequence')}</p>,
        confirmation: {
          phrase: CANCEL_PURGE_PHRASE,
          confirm: async () => {
            const failure = await section.cancelPurge(purgeId);
            if (failure === null) onStatus(translate('settings.purge.cancelled'));
            return failure;
          },
        },
      },
    });
  };

  const purge = settings.purge;
  const showPurge = settings.state === 'archived' || purge !== null;

  return (
    <>
      <div className="df-panel__block">
        <h3 className="df-panel__subheading">{translate('settings.retention.heading')}</h3>
        <p>{translate('settings.retention.current', { years: settings.auditRetentionYears })}</p>
        {capabilities.setRetention ? (
          <>
            <div className="df-field">
              <label className="df-field__label" htmlFor={yearsField}>
                {translate('settings.retention.label')}
              </label>
              <select
                id={yearsField}
                className="df-field__input"
                value={years}
                onChange={(event) => {
                  setYears(Number(event.target.value));
                }}
              >
                {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
                  <option key={value} value={value}>
                    {translate('settings.retention.years', { years: value })}
                  </option>
                ))}
              </select>
            </div>
            <div className="df-panel__actions">
              <button type="button" className="df-button" disabled={years === settings.auditRetentionYears} onClick={reviewRetention}>
                {translate('settings.retention.review')}
              </button>
            </div>
          </>
        ) : (
          <p className="df-field__help">
            {translate(settings.state === 'draft' ? 'settings.retention.ownerOnly' : 'settings.retention.locked')}
          </p>
        )}
      </div>

      {showPurge ? (
        <div className="df-panel__block">
          <h3 className="df-panel__subheading">{translate('settings.purge.heading')}</h3>
          {purge === null ? (
            <p>{translate('settings.purge.none')}</p>
          ) : (
            <Notice tone="caution" role="status">
              {translate(PURGE_STATUS[purge.state], expiryDisplay(purge.purgeAfter))}
            </Notice>
          )}
          <div className="df-panel__actions">
            {capabilities.schedulePurge ? (
              <button type="button" className="df-button" onClick={reviewPurge}>
                {translate('settings.purge.schedule')}
              </button>
            ) : null}
            {capabilities.cancelPurge && purge !== null ? (
              <button
                type="button"
                className="df-button df-button--primary"
                onClick={() => {
                  beginCancel(purge.purgeId);
                }}
              >
                {translate('settings.purge.cancel')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <ConfirmationDialog
        open={dialogue !== null}
        title={dialogue === null ? '' : translate(COPY[dialogue.kind].title)}
        submitLabel={dialogue === null ? '' : translate(COPY[dialogue.kind].submit)}
        pendingLabel={translate('settings.pending')}
        content={dialogue?.content ?? { kind: 'loading' }}
        onClose={() => {
          setDialogue(null);
        }}
        onReload={section.reload}
      />
    </>
  );
}
```

`settings.retention.ownerOnly` is explanatory copy chosen from server facts (the room is draft and the capability is false); it is not an authorization decision.

Render it in `RoomSettingsPanel` after the policy controls, keyed the same way:

```tsx
      <RoomLifecycleControls key={`lifecycle-${settings.revision}`} settings={settings} section={section} onStatus={onStatus} />
```

- [x] **Step 5: Add the copy**

```ts
  'settings.lifecycle.freshSignIn': 'This change needs a sign-in from the last 15 minutes.',
  'settings.retention.heading': 'Audit retention',
  'settings.retention.current': 'Audit records for this room are kept for {years} years.',
  'settings.retention.label': 'Keep audit records for',
  'settings.retention.years': '{years} years',
  'settings.retention.review': 'Review retention change',
  'settings.retention.apply': 'Change retention',
  'settings.retention.title': 'Change audit retention',
  'settings.retention.consequence':
    'Audit records written from now on are kept for {years} years. Records already written keep their current retention.',
  'settings.retention.locked': 'Retention is fixed while the room is published or archived.',
  'settings.retention.ownerOnly': 'Only the Owner changes audit retention.',
  'settings.retention.done': 'Audit retention changed.',
  'settings.purge.heading': 'Purge',
  'settings.purge.none': 'No purge is scheduled.',
  'settings.purge.schedule': 'Schedule purge',
  'settings.purge.title': 'Schedule a purge of this room',
  'settings.purge.consequence':
    'After a 30-day cancellation period, every document, version, preview, reader membership and grant in this room is permanently deleted. Pseudonymized audit records remain for the retention period. Provider backups follow their own retention.',
  'settings.purge.counts': 'Documents: {documents}. Readers: {viewers}. Stored originals: {size}.',
  'settings.purge.scheduled': 'Purge scheduled. It can be cancelled for 30 days.',
  'settings.purge.status.scheduled': 'Purge scheduled. Everything in this room will be deleted after {local} ({utc}).',
  'settings.purge.status.running': 'Purge in progress.',
  'settings.purge.status.purged': 'This room has been purged.',
  'settings.purge.status.failed': 'The purge did not complete. Contact the installation operator before changing this room.',
  'settings.purge.cancel': 'Cancel purge',
  'settings.purge.cancelTitle': 'Cancel the scheduled purge',
  'settings.purge.cancelConsequence':
    'Nothing will be deleted. The room stays archived and a purge can be scheduled again later.',
  'settings.purge.cancelled': 'Purge cancelled.',
```

`settings.retention.locked` says "while published or archived" because the SQL gate is `state='draft'`; see the open question in the plan's closing notes.

- [x] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run --project unit --maxWorkers=2
npm run typecheck && npm run lint
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add apps/web-client/src
git commit -m "Change audit retention and schedule or cancel a purge"
```

---
### Task 12: Per-document download exceptions in the collection

**Files:**
- Modify: `apps/web-client/src/api/room-settings.ts` (append `setDocumentDownloadPolicy`)
- Modify: `apps/web-client/src/workspace/room-settings.ts` (`StructureDownloads`)
- Modify: `apps/web-client/src/workspace/useRoomSettings.ts` (`structureDownloads`)
- Create: `apps/web-client/src/components/DownloadOverrideControl.tsx`, `apps/web-client/src/components/DownloadOverrideControl.unit.test.tsx`
- Modify: `apps/web-client/src/components/StructureTable.tsx` (prop, status marker, actions cell)
- Modify: `apps/web-client/src/workspace/views/RoomView.tsx` (the `StructureTable` element)
- Modify: `apps/web-client/src/i18n/en.ts`

**Interfaces:**
- Consumes: `document-download` on `POST /api/policies` (Task 6); `DocumentEntry.documentRevision` (Task 3); `downloadOverrides` from `GET /api/rooms/settings` (Task 4); `ConfirmationDialog` (Task 9); `roomDownloadPolicy` (Task 9).
- Produces:
  - `StructureDownloads { overrides: ReadonlyMap<string, DownloadPolicy>; inherited: DownloadPolicy; change(entry: DocumentEntry, policy: DownloadPolicy | null): Promise<PresentedFailure | null>; reload(): void }`.
  - `RoomSettingsSection.structureDownloads(onDocumentChanged: () => void): StructureDownloads | null` — null until settings are ready, and for anyone who is not a Room Manager (the hook is null for them).
  - `StructureTableProps.downloads: StructureDownloads | null`.

The control lives on the document's own row (spec §6.1), and an exception is marked in words on that row (§9.1: "document-level exceptions are visibly marked in member UI"). A change sends the **document** revision, so it can no longer strand later metadata edits (Task 3). After it commits, the collection re-reads because the document's revision moved.

- [x] **Step 1: Write the failing unit test**

Create `apps/web-client/src/components/DownloadOverrideControl.unit.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DocumentEntry } from '../api/client.ts';
import { DownloadMarker, DownloadOverrideControl } from './DownloadOverrideControl.tsx';

const entry = {
  entryId: 'e'.repeat(32), resourceKind: 'document', resourceId: 'd'.repeat(32), documentRevision: 2,
  parentFolderId: null, displayName: 'Teaser', description: '', revision: 1, stagedRemoved: false,
  depth: 0, position: 1, canMoveUp: false, canMoveDown: false, changeKinds: [],
  hasPublishableVersion: true, isPublished: false,
} satisfies DocumentEntry;

const control = (current: 'allow' | 'deny' | null) =>
  renderToStaticMarkup(
    <DownloadOverrideControl
      entry={entry}
      current={current}
      inherited="deny"
      onChange={() => Promise.resolve(null)}
      onReload={() => undefined}
    />,
  );

describe('DownloadOverrideControl', () => {
  it('names the document it changes and what inheriting resolves to', () => {
    const html = control(null);
    expect(html).toContain('aria-label="Downloads for Teaser"');
    expect(html).toContain('Room default (denied)');
  });

  it('shows an explicit exception as the current choice', () => {
    expect(control('allow')).toMatch(/<option value="allow" selected=""/u);
  });
});

describe('DownloadMarker', () => {
  it('states an exception in words and says nothing when there is none', () => {
    expect(renderToStaticMarkup(<DownloadMarker policy="allow" />)).toContain('Downloads allowed here');
    expect(renderToStaticMarkup(<DownloadMarker policy={null} />)).toBe('');
  });
});
```

- [x] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project unit --maxWorkers=2 DownloadOverrideControl
```

Expected: FAIL — module not found.

- [x] **Step 3: Append the call and extend the hook**

Append to `apps/web-client/src/api/room-settings.ts`:

```ts
export async function setDocumentDownloadPolicy(
  documentId: string,
  policy: DownloadPolicy | null,
  expectedDocumentRevision: number,
): Promise<void> {
  const payload = await json({
    method: 'POST',
    path: '/api/policies',
    body: { action: 'document-download', documentId, policy, expectedDocumentRevision },
  });
  if (!isRecord(payload) || typeof payload['documentRevision'] !== 'number') throw new ApiError('unavailable');
}
```

Append to `apps/web-client/src/workspace/room-settings.ts`:

```ts
import type { DocumentEntry } from '../api/client.ts';
import type { PresentedFailure } from './failures.ts';

/** What the collection needs to show and change per-document download exceptions. */
export interface StructureDownloads {
  readonly overrides: ReadonlyMap<string, DownloadPolicy>;
  /** What a document without its own policy resolves to. */
  readonly inherited: DownloadPolicy;
  readonly change: (entry: DocumentEntry, policy: DownloadPolicy | null) => Promise<PresentedFailure | null>;
  readonly reload: () => void;
}
```

In `useRoomSettings.ts`, add to `RoomSettingsSection`:

```ts
  readonly structureDownloads: (onDocumentChanged: () => void) => StructureDownloads | null;
```

and, beside the other members of the returned object (with `view` computed once before the `return`):

```ts
  const view = current !== null && current.load.kind === 'ready' ? current.load.value : null;
```

```ts
    structureDownloads: (onDocumentChanged) =>
      view === null
        ? null
        : {
            overrides: view.downloadOverrides,
            inherited: roomDownloadPolicy(view.settings),
            change: async (entry, policy) => {
              const failure = await commit(setDocumentDownloadPolicy(entry.resourceId, policy, entry.documentRevision));
              if (failure === null) onDocumentChanged();
              return failure;
            },
            reload: () => {
              reload();
              onDocumentChanged();
            },
          },
```

- [x] **Step 4: Write the control**

Create `apps/web-client/src/components/DownloadOverrideControl.tsx`:

```tsx
/**
 * One document's download exception, on its collection row.
 *
 * Choosing a value opens the confirmation dialog on its consequence; the select keeps
 * showing the current value until the change commits, so a cancelled choice leaves
 * nothing half-applied on screen.
 */
import { useState } from 'react';
import type { DocumentEntry, DownloadPolicy } from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { ConfirmationDialog } from './ConfirmationDialog.tsx';

const CHOICE: Readonly<Record<string, DownloadPolicy | null>> = { inherit: null, allow: 'allow', deny: 'deny' };
const WORD: Readonly<Record<DownloadPolicy, MessageKey>> = {
  allow: 'settings.download.word.allow',
  deny: 'settings.download.word.deny',
};
const MARKER: Readonly<Record<DownloadPolicy, MessageKey>> = {
  allow: 'downloads.marker.allow',
  deny: 'downloads.marker.deny',
};

function consequence(policy: DownloadPolicy | null): MessageKey {
  if (policy === null) return 'downloads.consequence.inherit';
  return policy === 'allow' ? 'downloads.consequence.allow' : 'downloads.consequence.deny';
}

export function DownloadMarker({ policy }: { readonly policy: DownloadPolicy | null }): React.ReactElement | null {
  return policy === null ? null : <span className="df-field__help">{translate(MARKER[policy])}</span>;
}

export interface DownloadOverrideControlProps {
  readonly entry: DocumentEntry;
  /** The document's own policy, or null when it inherits. */
  readonly current: DownloadPolicy | null;
  readonly inherited: DownloadPolicy;
  readonly onChange: (policy: DownloadPolicy | null) => Promise<PresentedFailure | null>;
  readonly onReload: () => void;
}

export function DownloadOverrideControl({
  entry,
  current,
  inherited,
  onChange,
  onReload,
}: DownloadOverrideControlProps): React.ReactElement {
  const [proposed, setProposed] = useState<{ readonly policy: DownloadPolicy | null } | null>(null);
  const inheritedWord = translate(WORD[inherited]);

  return (
    <>
      <select
        className="df-field__input"
        aria-label={translate('downloads.label', { name: entry.displayName })}
        value={current ?? 'inherit'}
        onChange={(event) => {
          const policy = CHOICE[event.target.value];
          if (policy !== undefined && policy !== current) setProposed({ policy });
        }}
      >
        <option value="inherit">{translate('downloads.inherit', { policy: inheritedWord })}</option>
        <option value="allow">{translate('downloads.allow')}</option>
        <option value="deny">{translate('downloads.deny')}</option>
      </select>
      <ConfirmationDialog
        open={proposed !== null}
        title={translate('downloads.title', { name: entry.displayName })}
        submitLabel={translate('downloads.apply')}
        pendingLabel={translate('settings.pending')}
        content={
          proposed === null
            ? { kind: 'loading' }
            : {
                kind: 'ready',
                consequence: <p>{translate(consequence(proposed.policy), { policy: inheritedWord })}</p>,
                confirmation: { phrase: null, confirm: () => onChange(proposed.policy) },
              }
        }
        onClose={() => {
          setProposed(null);
        }}
        onReload={onReload}
      />
    </>
  );
}
```

`current ?? 'inherit'` maps "no exception" onto the option that names it; it is the value's meaning, not a default.

- [x] **Step 5: Put it on the row**

In `apps/web-client/src/components/StructureTable.tsx`:

- add to `StructureTableProps`:

```ts
  /** Present only for a Room Manager once settings are loaded. */
  readonly downloads: StructureDownloads | null;
```

- in the status cell of each row, after the existing status text:

```tsx
                  {downloads !== null && entry.resourceKind === 'document' ? (
                    <DownloadMarker policy={downloads.overrides.get(entry.resourceId) ?? null} />
                  ) : null}
```

- in the actions cell, beside the existing document actions:

```tsx
                    {downloads === null || entry.resourceKind !== 'document' ? null : (
                      <DownloadOverrideControl
                        entry={entry}
                        current={downloads.overrides.get(entry.resourceId) ?? null}
                        inherited={downloads.inherited}
                        onChange={(policy) => downloads.change(entry, policy)}
                        onReload={downloads.reload}
                      />
                    )}
```

`Map.get` returns `undefined` for a document with no exception, which is exactly what `null` means here.

In `RoomView.tsx`, pass to the `StructureTable` element:

```tsx
              downloads={settings === null ? null : settings.structureDownloads(refreshWorkspace)}
```

Every other `StructureTable` render (unit tests, other views) passes `downloads={null}`; `npm run typecheck` lists them.

- [x] **Step 6: Add the copy**

```ts
  'downloads.label': 'Downloads for {name}',
  'downloads.inherit': 'Room default ({policy})',
  'downloads.allow': 'Allowed for this document',
  'downloads.deny': 'Denied for this document',
  'downloads.marker.allow': 'Downloads allowed here',
  'downloads.marker.deny': 'Downloads denied here',
  'downloads.title': 'Change downloads for {name}',
  'downloads.apply': 'Change downloads',
  'downloads.consequence.allow':
    'Viewers who can read this document will be able to download its original, whatever the room policy says.',
  'downloads.consequence.deny':
    'Viewers will not be able to download this document’s original, whatever the room policy says.',
  'downloads.consequence.inherit':
    'This document will follow the room’s policy, which currently resolves to {policy}.',
```

- [x] **Step 7: Run the tests to verify they pass**

```bash
npx vitest run --project unit --maxWorkers=2
npm run typecheck && npm run lint
wc -l apps/web-client/src/workspace/views/RoomView.tsx apps/web-client/src/components/StructureTable.tsx
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add apps/web-client/src
git commit -m "Set a document's download exception from its collection row"
```

---

### Task 13: Counterparties in the Access section

**Files:**
- Modify: `apps/web-client/src/api/participants.ts` (`loadParticipants`, counterparty calls), create `apps/web-client/src/api/participants.unit.test.ts`
- Modify: `apps/web-client/src/workspace/grants.ts` (`Grantee`, `GrantSubmission`, `granteeRequest`, `counterpartyNameTaken`), `apps/web-client/src/workspace/grants.unit.test.ts`
- Modify: `apps/web-client/src/workspace/useParticipantsSection.ts` (roster, grantee, Promise-returning grant and counterparty calls)
- Create: `apps/web-client/src/components/GrantDraftFields.tsx` (moved out of `ParticipantsPanel.tsx`'s `GrantChangeForm`)
- Modify: `apps/web-client/src/components/ParticipantsPanel.tsx` (use `GrantDraftFields`; submissions carry a grantee)
- Create: `apps/web-client/src/components/CounterpartyControls.tsx`, `apps/web-client/src/components/CounterpartyControls.unit.test.tsx`
- Create: `apps/web-client/src/workspace/views/AccessSection.tsx`
- Modify: `apps/web-client/src/workspace/views/RoomView.tsx` (the participants block becomes `AccessSection`)
- Modify: `apps/web-client/src/i18n/en.ts`

**Interfaces:**
- Consumes: `GET /api/participants` with `counterparties`, `POST /api/counterparties` (Task 7); `POST /api/grants` with `granteeKind: 'counterparty'` (007, already routed); `ConfirmationDialog` (Task 9); `settle`, `committed` (Task 8).
- Produces:
  - `ParticipantRoster { participants; counterparties }`, `Counterparty`; calls `createCounterparty`, `placeViewerInCounterparty`, `removeViewerFromCounterparty`.
  - `Grantee` union; `GrantSubmission.grantee` replaces `.participant`; `granteeRequest(grantee)`; `counterpartyNameTaken(name, counterparties)`.
  - `ParticipantsSection.roster: Load<ParticipantRoster>` (replaces `.participants`); `previewGrant`, `commitGrant`, `addCounterparty`, `placeViewer`, `removeViewer`, all Promise-returning.
  - `AccessSection` — `RoomView` renders it instead of `ParticipantsPanel`.

Grants to a counterparty are already routable (`grant-change.ts` accepts `granteeKind: 'counterparty'`) but the client hardcodes `'viewer'`. A counterparty grant reaches every reader placed in it, so it is a broad change: the server requires a fresh sign-in, and the dialog says so. Placing or removing a reader changes that reader's access immediately, so both open the confirmation dialog on the consequence. Creating a counterparty grants nothing and submits directly.

`ParticipantsPanel` (714 lines) does not grow: counterparty work lives in `CounterpartyControls`, `AccessSection` composes the two, and the grant target and expiry fields move to `GrantDraftFields` so both surfaces share them. `RoomView` loses the ~45-line `ParticipantsPanel` element, which pays back what Tasks 9 and 12 added.

- [x] **Step 1: Write the failing unit tests**

Create `apps/web-client/src/api/participants.unit.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadParticipants } from './participants.ts';

const ID = 'c'.repeat(32);
function stub(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadParticipants', () => {
  it('returns counterparties, including those nobody is placed in yet', async () => {
    stub({ participants: [], counterparties: [{ counterpartyId: ID, name: 'Buyer A', revision: 1, viewerCount: 0 }] });
    expect((await loadParticipants('r'.repeat(32))).counterparties).toStrictEqual([
      { counterpartyId: ID, name: 'Buyer A', revision: 1, viewerCount: 0 },
    ]);
  });

  it('fails closed on a counterparty it cannot read', async () => {
    stub({ participants: [], counterparties: [{ counterpartyId: ID, name: 'Buyer A', revision: 1, viewerCount: -1 }] });
    await expect(loadParticipants('r'.repeat(32))).rejects.toMatchObject({ failure: 'unavailable' });
  });
});
```

Append to `apps/web-client/src/workspace/grants.unit.test.ts`:

```ts
describe('granteeRequest', () => {
  it('sends exactly one grantee id, of the grantee’s kind', () => {
    expect(granteeRequest({ kind: 'viewer', viewerId: 'v'.repeat(32), label: 'a@example.test' })).toStrictEqual({
      granteeKind: 'viewer', viewerId: 'v'.repeat(32), counterpartyId: null,
    });
    expect(granteeRequest({ kind: 'counterparty', counterpartyId: 'c'.repeat(32), label: 'Buyer A' })).toStrictEqual({
      granteeKind: 'counterparty', viewerId: null, counterpartyId: 'c'.repeat(32),
    });
  });
});

describe('counterpartyNameTaken', () => {
  it('compares after case and space normalization, as the database does', () => {
    const existing = [{ counterpartyId: 'c'.repeat(32), name: 'Buyer A', revision: 1, viewerCount: 0 }];
    expect(counterpartyNameTaken('  buyer a ', existing)).toBe(true);
    expect(counterpartyNameTaken('Buyer B', existing)).toBe(false);
  });
});
```

Create `apps/web-client/src/components/CounterpartyControls.unit.test.tsx`, rendering `CounterpartyTables` (the static part of `CounterpartyControls`, exported for this purpose):

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Participant } from '../api/client.ts';
import { messages } from '../i18n/en.ts';
import { CounterpartyTables } from './CounterpartyControls.tsx';

const buyer = { counterpartyId: 'c'.repeat(32), name: 'Buyer A', revision: 1, viewerCount: 0 };
const reader = (counterpartyName: string | null): Participant =>
  ({
    viewerId: 'v'.repeat(32), email: 'reader@example.test', membershipState: 'active', membershipRevision: 1,
    counterpartyId: counterpartyName === null ? null : buyer.counterpartyId, counterpartyName, grants: [],
  }) as Participant;
const noop = (): void => undefined;
const tables = (participants: readonly Participant[], counterparties = [buyer]) =>
  renderToStaticMarkup(
    <CounterpartyTables
      roster={{ participants, counterparties }}
      chosen={{}}
      onChoose={noop}
      onPlace={noop}
      onRemove={noop}
      onGrant={noop}
    />,
  );

describe('CounterpartyTables', () => {
  it('lists a counterparty nobody is placed in', () => {
    expect(tables([])).toContain('Buyer A');
  });

  it('offers placement only to a reader in no counterparty, and removal only to one in a counterparty', () => {
    expect(tables([reader(null)])).toContain(messages['counterparty.place']);
    expect(tables([reader('Buyer A')])).not.toContain(messages['counterparty.place']);
    expect(tables([reader('Buyer A')])).toContain('Remove from Buyer A');
  });

  it('offers no placement when the room has no counterparties', () => {
    expect(tables([reader(null)], [])).not.toContain(messages['counterparty.place']);
  });
});
```

- [x] **Step 2: Run them to verify they fail**

```bash
npx vitest run --project unit --maxWorkers=2 participants.unit grants.unit CounterpartyControls
```

Expected: FAIL.

- [x] **Step 3: Carry counterparties through the client**

In `apps/web-client/src/api/participants.ts`:

```ts
export interface Counterparty {
  readonly counterpartyId: string;
  readonly name: string;
  readonly revision: number;
  readonly viewerCount: number;
}

export interface ParticipantRoster {
  readonly participants: readonly Participant[];
  readonly counterparties: readonly Counterparty[];
}

function parseCounterparty(value: unknown): Counterparty {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const viewerCount = requireNumber(value, 'viewerCount');
  if (!Number.isInteger(viewerCount) || viewerCount < 0) throw new ApiError('unavailable');
  return {
    counterpartyId: requireString(value, 'counterpartyId'),
    name: requireString(value, 'name'),
    revision: requireNumber(value, 'revision'),
    viewerCount,
  };
}
```

Change `loadParticipants` to return `Promise<ParticipantRoster>`: keep its existing `participants` handling and add `counterparties: requireArray(payload, 'counterparties').map(parseCounterparty)`. Append:

```ts
async function counterpartyAction(body: Readonly<Record<string, unknown>>): Promise<void> {
  const payload = await json({ method: 'POST', path: '/api/counterparties', body });
  if (!isRecord(payload) || typeof payload['roomRevision'] !== 'number') throw new ApiError('unavailable');
}

export function createCounterparty(input: { readonly roomId: string; readonly name: string; readonly expectedRoomRevision: number }): Promise<void> {
  return counterpartyAction({ action: 'create', ...input, name: input.name.normalize('NFC') });
}

export function placeViewerInCounterparty(input: {
  readonly roomId: string;
  readonly counterpartyId: string;
  readonly viewerId: string;
  readonly expectedRoomRevision: number;
}): Promise<void> {
  return counterpartyAction({ action: 'assign-viewer', ...input });
}

export function removeViewerFromCounterparty(input: {
  readonly roomId: string;
  readonly viewerId: string;
  readonly expectedRoomRevision: number;
}): Promise<void> {
  return counterpartyAction({ action: 'remove-viewer', ...input });
}
```

Re-export the new names from `api/client.ts`.

In `apps/web-client/src/workspace/grants.ts`, replace `GrantSubmission` and add:

```ts
/** Who a grant names. Exactly one id travels, of the grantee's own kind. */
export type Grantee =
  | { readonly kind: 'viewer'; readonly viewerId: string; readonly label: string }
  | { readonly kind: 'counterparty'; readonly counterpartyId: string; readonly label: string };

export interface GrantSubmission {
  readonly grantee: Grantee;
  readonly draft: GrantDraft;
  readonly grantId?: string;
}

export function granteeRequest(grantee: Grantee) {
  return grantee.kind === 'viewer'
    ? ({ granteeKind: 'viewer', viewerId: grantee.viewerId, counterpartyId: null } as const)
    : ({ granteeKind: 'counterparty', viewerId: null, counterpartyId: grantee.counterpartyId } as const);
}

/** Convenience only: `counterparty (room_id, normalized_name)` is the authority. */
export function counterpartyNameTaken(name: string, counterparties: readonly Counterparty[]): boolean {
  const key = name.trim().toLowerCase().normalize('NFC');
  return counterparties.some((counterparty) => counterparty.name.trim().toLowerCase().normalize('NFC') === key);
}
```

- [x] **Step 4: Rework the participants hook**

In `apps/web-client/src/workspace/useParticipantsSection.ts`:

1. `participants: Load<readonly Participant[]>` becomes `roster: Load<ParticipantRoster>`; `refresh` stores the roster `loadParticipants` now returns.
2. Add a third handler, `onRosterChanged: () => void`, called after counterparty changes (which move the room revision but are not grants, so `onApplied`'s "grant saved" status would be false).
3. Add Promise-returning grant calls, and re-express `review` and `apply` through them so there is one implementation:

```ts
  const previewGrant: ParticipantsSection['previewGrant'] = (roomId, next) =>
    settle(
      dryRunGrantChange({
        roomId,
        changeAction: next.draft.changeAction,
        ...(next.grantId === undefined ? {} : { grantId: next.grantId }),
        ...granteeRequest(next.grantee),
        ...draftToRequest(next.draft),
      }),
    );

  const commitGrant: ParticipantsSection['commitGrant'] = async (input) => {
    const failure = await committed(
      applyGrantChange({
        roomId: input.roomId,
        changeAction: input.submission.draft.changeAction,
        // The server's own grantId, not one chosen here.
        grantId: input.impact.grantId,
        ...granteeRequest(input.submission.grantee),
        ...draftToRequest(input.submission.draft),
        expectedRoomRevision: input.expectedRoomRevision,
        confirmation: input.confirmation,
      }),
    );
    if (failure === null) {
      handlers.onApplied();
      refresh(input.roomId);
    }
    return failure;
  };

  const review: ParticipantsSection['review'] = (roomId, next) => {
    setSubmission(next);
    setImpact(null);
    setChangeFailure(null);
    setImpactPending(true);
    void previewGrant(roomId, next).then((outcome) => {
      setImpactPending(false);
      if (outcome.ok) setImpact(outcome.value);
      else setChangeFailure(outcome.failure);
    });
  };

  const apply: ParticipantsSection['apply'] = (input) => {
    const current = submission;
    const reviewed = impact;
    if (current === null || reviewed === null) return;
    setApplyPending(true);
    setChangeFailure(null);
    void commitGrant({ ...input, submission: current, impact: reviewed }).then((failure) => {
      setApplyPending(false);
      if (failure === null) {
        setImpact(null);
        setSubmission(null);
      } else setChangeFailure(failure);
    });
  };
```

4. Add the counterparty calls:

```ts
  const rosterChange = async (roomId: string, work: Promise<unknown>): Promise<PresentedFailure | null> => {
    const failure = await committed(work);
    if (failure === null) {
      handlers.onRosterChanged();
      refresh(roomId);
    }
    return failure;
  };
```

```ts
    addCounterparty: (input) => rosterChange(input.roomId, createCounterparty(input)),
    placeViewer: (input) => rosterChange(input.roomId, placeViewerInCounterparty(input)),
    removeViewer: (input) => rosterChange(input.roomId, removeViewerFromCounterparty(input)),
```

with matching members on `ParticipantsSection`:

```ts
  readonly previewGrant: (roomId: string, submission: GrantSubmission) => Promise<Outcome<GrantImpact>>;
  readonly commitGrant: (input: {
    readonly roomId: string;
    readonly submission: GrantSubmission;
    readonly impact: GrantImpact;
    readonly expectedRoomRevision: number;
    readonly confirmation: string;
  }) => Promise<PresentedFailure | null>;
  readonly addCounterparty: (input: { readonly roomId: string; readonly name: string; readonly expectedRoomRevision: number }) => Promise<PresentedFailure | null>;
  readonly placeViewer: (input: {
    readonly roomId: string;
    readonly counterpartyId: string;
    readonly viewerId: string;
    readonly expectedRoomRevision: number;
  }) => Promise<PresentedFailure | null>;
  readonly removeViewer: (input: { readonly roomId: string; readonly viewerId: string; readonly expectedRoomRevision: number }) => Promise<PresentedFailure | null>;
```

In `RoomView.tsx`, pass `onRosterChanged: onRoomsChanged` to `useParticipantsSection`.

- [x] **Step 5: Share the grant draft fields**

Move the target-kind, folder, document and expiry fields out of `GrantChangeForm` (`ParticipantsPanel.tsx:448` onward) into `apps/web-client/src/components/GrantDraftFields.tsx`, **unchanged in markup and copy**, as:

```ts
export interface GrantDraftFieldsProps {
  readonly draft: GrantDraft;
  readonly problems: readonly GrantDraftProblem[];
  readonly folders: readonly WorkingEntry[];
  readonly documents: readonly WorkingEntry[];
  readonly firstField?: React.Ref<HTMLSelectElement | HTMLInputElement>;
  readonly onDraftChange: (draft: GrantDraft) => void;
}
```

`GrantChangeForm` renders `<GrantDraftFields .../>` where the fields were. Where `ParticipantsPanel` builds a submission, change `{ participant, draft, grantId }` to `{ grantee: { kind: 'viewer', viewerId: participant.viewerId, label: participant.email }, draft, grantId }`. `wc -l ParticipantsPanel.tsx` must be lower than 714 afterwards.

- [x] **Step 6: Write the counterparty controls**

Create `apps/web-client/src/components/CounterpartyControls.tsx`:

```tsx
/**
 * Counterparties: the firms readers belong to, where each reader sits, and grants that
 * reach a whole counterparty (§9.1).
 *
 * Creating a counterparty grants nothing and submits directly. Placing a reader, removing
 * one, and granting a counterparty all change access and open the confirmation dialog on
 * their consequence; a counterparty grant is reviewed by the server and typed, and needs a
 * fresh sign-in because it is broad.
 */
import { useId, useState } from 'react';
import type { Counterparty, GrantImpact, ParticipantRoster, WorkingEntry } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { counterpartyNameTaken, validateGrantDraft, type GrantDraft, type GrantSubmission } from '../workspace/grants.ts';
import type { ParticipantsSection } from '../workspace/useParticipantsSection.ts';
import { ConfirmationDialog, type ConfirmationContent } from './ConfirmationDialog.tsx';
import { FailureNotice } from './FailureNotice.tsx';
import { GrantDraftFields } from './GrantDraftFields.tsx';

const EMPTY_DRAFT: GrantDraft = { changeAction: 'grant', targetKind: null, folderId: null, documentId: null, expiresOn: '' };

export interface CounterpartyTablesProps {
  readonly roster: ParticipantRoster;
  /** The counterparty chosen in each unplaced reader's select, by viewer id. */
  readonly chosen: Readonly<Record<string, string>>;
  readonly onChoose: (viewerId: string, counterpartyId: string) => void;
  readonly onPlace: (viewerId: string, email: string, counterparty: Counterparty) => void;
  readonly onRemove: (viewerId: string, email: string, counterpartyName: string) => void;
  readonly onGrant: (counterparty: Counterparty) => void;
}

export function CounterpartyTables({
  roster,
  chosen,
  onChoose,
  onPlace,
  onRemove,
  onGrant,
}: CounterpartyTablesProps): React.ReactElement {
  const { counterparties } = roster;
  const readers = roster.participants.filter((participant) => participant.membershipState === 'active');
  return (
    <>
      {counterparties.length === 0 ? (
        <p className="df-field__help">{translate('counterparty.none')}</p>
      ) : (
        <table className="df-register">
          <caption>{translate('counterparty.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{translate('counterparty.columns.name')}</th>
              <th scope="col">{translate('counterparty.columns.readers')}</th>
              <th scope="col">{translate('counterparty.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {counterparties.map((counterparty) => (
              <tr key={counterparty.counterpartyId}>
                <th scope="row">{counterparty.name}</th>
                <td data-numeric="true">{counterparty.viewerCount}</td>
                <td>
                  <button
                    type="button"
                    className="df-button"
                    onClick={() => {
                      onGrant(counterparty);
                    }}
                  >
                    {translate('counterparty.grant', { name: counterparty.name })}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {readers.length === 0 ? null : (
        <table className="df-register">
          <caption>{translate('counterparty.placement.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{translate('counterparty.placement.reader')}</th>
              <th scope="col">{translate('counterparty.placement.counterparty')}</th>
              <th scope="col">{translate('counterparty.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {readers.map((reader) => {
              const placedIn = reader.counterpartyName;
              const choice = counterparties.find((c) => c.counterpartyId === chosen[reader.viewerId]) ?? counterparties[0];
              return (
                <tr key={reader.viewerId}>
                  <th scope="row">{reader.email}</th>
                  <td>{placedIn ?? translate('counterparty.placement.none')}</td>
                  <td>
                    {placedIn !== null ? (
                      <button
                        type="button"
                        className="df-button"
                        onClick={() => {
                          onRemove(reader.viewerId, reader.email, placedIn);
                        }}
                      >
                        {translate('counterparty.remove', { name: placedIn })}
                      </button>
                    ) : choice === undefined ? null : (
                      <>
                        <select
                          className="df-field__input"
                          aria-label={translate('counterparty.placement.choose', { email: reader.email })}
                          value={choice.counterpartyId}
                          onChange={(event) => {
                            onChoose(reader.viewerId, event.target.value);
                          }}
                        >
                          {counterparties.map((c) => (
                            <option key={c.counterpartyId} value={c.counterpartyId}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="df-button"
                          onClick={() => {
                            onPlace(reader.viewerId, reader.email, choice);
                          }}
                        >
                          {translate('counterparty.place')}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

export interface CounterpartyControlsProps {
  readonly roomId: string;
  readonly roomRevision: number;
  readonly roster: ParticipantRoster;
  readonly entries: readonly WorkingEntry[];
  readonly section: ParticipantsSection;
  readonly onStatus: (message: string) => void;
}

export function CounterpartyControls({
  roomId,
  roomRevision,
  roster,
  entries,
  section,
  onStatus,
}: CounterpartyControlsProps): React.ReactElement {
  const headingId = useId();
  const nameField = useId();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createFailure, setCreateFailure] = useState<PresentedFailure | null>(null);
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>({});
  const [granting, setGranting] = useState<{ readonly counterparty: Counterparty; readonly draft: GrantDraft } | null>(null);
  const [dialogue, setDialogue] = useState<{ readonly title: string; readonly submit: string; readonly content: ConfirmationContent } | null>(null);
  const taken = counterpartyNameTaken(name, roster.counterparties);

  const create = async (): Promise<void> => {
    setCreating(true);
    setCreateFailure(null);
    const failure = await section.addCounterparty({ roomId, name, expectedRoomRevision: roomRevision });
    setCreating(false);
    if (failure === null) {
      onStatus(translate('counterparty.created', { name }));
      setName('');
    } else setCreateFailure(failure);
  };

  const confirmAccessChange = (
    title: string,
    submit: string,
    consequence: string,
    run: () => Promise<PresentedFailure | null>,
    done: string,
  ): void => {
    setDialogue({
      title,
      submit,
      content: {
        kind: 'ready',
        consequence: <p>{consequence}</p>,
        confirmation: {
          phrase: null,
          confirm: async () => {
            const failure = await run();
            if (failure === null) onStatus(done);
            return failure;
          },
        },
      },
    });
  };

  const reviewGrant = (counterparty: Counterparty, draft: GrantDraft): void => {
    const submission: GrantSubmission = {
      grantee: { kind: 'counterparty', counterpartyId: counterparty.counterpartyId, label: counterparty.name },
      draft,
    };
    const title = translate('counterparty.grant.title', { name: counterparty.name });
    setDialogue({ title, submit: translate('counterparty.grant.apply'), content: { kind: 'loading' } });
    void section.previewGrant(roomId, submission).then((outcome) => {
      setDialogue((open) =>
        open?.title !== title
          ? open
          : {
              ...open,
              content: outcome.ok
                ? {
                    kind: 'ready',
                    consequence: <GrantConsequence impact={outcome.value} counterparty={counterparty} />,
                    confirmation: {
                      phrase: outcome.value.confirmation,
                      confirm: async (typed) => {
                        const failure = await section.commitGrant({
                          roomId,
                          submission,
                          impact: outcome.value,
                          expectedRoomRevision: roomRevision,
                          confirmation: typed,
                        });
                        if (failure === null) setGranting(null);
                        return failure;
                      },
                    },
                  }
                : { kind: 'failed', failure: outcome.failure },
            },
      );
    });
  };

  const folders = entries.filter((entry) => entry.resourceKind === 'folder');
  const documents = entries.filter((entry) => entry.resourceKind === 'document');
  const problems = granting === null ? [] : validateGrantDraft(granting.draft, new Date());

  return (
    <section className="df-panel__block" aria-labelledby={headingId}>
      <h3 id={headingId} className="df-panel__subheading">
        {translate('counterparty.heading')}
      </h3>
      <p className="df-field__help">{translate('counterparty.explain')}</p>

      <CounterpartyTables
        roster={roster}
        chosen={chosen}
        onChoose={(viewerId, counterpartyId) => {
          setChosen((current) => ({ ...current, [viewerId]: counterpartyId }));
        }}
        onPlace={(viewerId, email, counterparty) => {
          confirmAccessChange(
            translate('counterparty.place.title'),
            translate('counterparty.place'),
            translate('counterparty.place.consequence', { email, name: counterparty.name }),
            () => section.placeViewer({ roomId, counterpartyId: counterparty.counterpartyId, viewerId, expectedRoomRevision: roomRevision }),
            translate('counterparty.placed', { name: counterparty.name }),
          );
        }}
        onRemove={(viewerId, email, counterpartyName) => {
          confirmAccessChange(
            translate('counterparty.remove.title'),
            translate('counterparty.remove', { name: counterpartyName }),
            translate('counterparty.remove.consequence', { email, name: counterpartyName }),
            () => section.removeViewer({ roomId, viewerId, expectedRoomRevision: roomRevision }),
            translate('counterparty.removed', { name: counterpartyName }),
          );
        }}
        onGrant={(counterparty) => {
          setGranting({ counterparty, draft: EMPTY_DRAFT });
        }}
      />

      {granting === null ? null : (
        <div className="df-panel__block" data-grant-form="true">
          <h4 className="df-panel__subheading">{translate('counterparty.grant', { name: granting.counterparty.name })}</h4>
          <GrantDraftFields
            draft={granting.draft}
            problems={problems}
            folders={folders}
            documents={documents}
            onDraftChange={(draft) => {
              setGranting({ ...granting, draft });
            }}
          />
          <div className="df-panel__actions">
            <button type="button" className="df-button" onClick={() => { setGranting(null); }}>
              {translate('structure.cancel')}
            </button>
            <button
              type="button"
              className="df-button df-button--primary"
              disabled={problems.length > 0}
              onClick={() => {
                reviewGrant(granting.counterparty, granting.draft);
              }}
            >
              {translate('counterparty.grant.review')}
            </button>
          </div>
        </div>
      )}

      <form
        className="df-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!creating && name.trim() !== '' && !taken) void create();
        }}
      >
        <div className="df-field">
          <label className="df-field__label" htmlFor={nameField}>
            {translate('counterparty.name')}
          </label>
          <input
            id={nameField}
            className="df-field__input"
            maxLength={200}
            value={name}
            disabled={creating}
            aria-invalid={taken ? 'true' : 'false'}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {taken ? <p className="df-field__help">{translate('counterparty.nameTaken')}</p> : null}
        </div>
        <button type="submit" className="df-button" disabled={creating || name.trim() === '' || taken}>
          {creating ? translate('counterparty.creating') : translate('counterparty.create')}
        </button>
        {createFailure === null ? null : <FailureNotice failure={createFailure} />}
      </form>

      <ConfirmationDialog
        open={dialogue !== null}
        title={dialogue?.title ?? ''}
        submitLabel={dialogue?.submit ?? ''}
        pendingLabel={translate('settings.pending')}
        content={dialogue?.content ?? { kind: 'loading' }}
        onClose={() => {
          setDialogue(null);
        }}
        onReload={() => {
          section.refresh(roomId);
        }}
      />
    </section>
  );
}

function GrantConsequence({
  impact,
  counterparty,
}: {
  readonly impact: GrantImpact;
  readonly counterparty: Counterparty;
}): React.ReactElement {
  return (
    <>
      <p>{impact.message}</p>
      <p>{translate('counterparty.grant.reach', { name: counterparty.name, readers: counterparty.viewerCount })}</p>
      {impact.paths.length === 0 ? null : (
        <ul>
          {impact.paths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      )}
      <p className="df-field__help">{translate('counterparty.grant.freshSignIn')}</p>
    </>
  );
}
```

`counterparties[0]` is the select's initial value before the Manager chooses — the first option it shows.

- [x] **Step 7: Compose the Access section**

Create `apps/web-client/src/workspace/views/AccessSection.tsx`:

```tsx
/**
 * The Access section: readers and their grants, then counterparties. Composed here so
 * neither panel grows the other, and so the room view renders one element.
 */
import type { MemberRoom, WorkingEntry } from '../../api/client.ts';
import { CounterpartyControls } from '../../components/CounterpartyControls.tsx';
import { ParticipantsPanel } from '../../components/ParticipantsPanel.tsx';
import type { ParticipantsSection } from '../useParticipantsSection.ts';

export interface AccessSectionProps {
  readonly roomId: string;
  readonly room: MemberRoom | null;
  readonly entries: readonly WorkingEntry[];
  readonly section: ParticipantsSection;
  readonly onStatus: (message: string) => void;
  readonly onRoomsChanged: () => void;
}

export function AccessSection({
  roomId,
  room,
  entries,
  section,
  onStatus,
  onRoomsChanged,
}: AccessSectionProps): React.ReactElement {
  const roster = section.roster;
  return (
    <>
      <ParticipantsPanel
        participants={roster.kind === 'ready' ? roster.value.participants : []}
        entries={entries}
        loading={roster.kind === 'loading'}
        denied={roster.kind === 'failed'}
        failure={section.failure}
        inviteFailure={section.inviteFailure}
        invitePending={section.invitePending}
        impact={section.impact}
        impactLoading={section.impactPending}
        applyPending={section.applyPending}
        changeFailure={section.changeFailure}
        onInvite={(email) => {
          if (room === null) return;
          section.invite({ roomId, email, expectedRoomRevision: room.revision });
        }}
        onReview={(submission) => {
          section.review(roomId, submission);
        }}
        onApply={(confirmation) => {
          if (room === null) return;
          section.apply({ roomId, expectedRoomRevision: room.revision, confirmation });
        }}
        onCancelChange={section.cancelChange}
        onReload={() => {
          section.beginLoading();
          section.refresh(roomId);
          onRoomsChanged();
        }}
      />
      {roster.kind === 'ready' && room !== null ? (
        <CounterpartyControls
          roomId={roomId}
          roomRevision={room.revision}
          roster={roster.value}
          entries={entries}
          section={section}
          onStatus={onStatus}
        />
      ) : null}
    </>
  );
}
```

The `ParticipantsPanel` props are the ones `RoomView.tsx` passes today, moved unchanged. In `RoomView.tsx`, replace the whole `{currentId === 'participants' ? (<ParticipantsPanel .../>) : null}` block with:

```tsx
      {currentId === 'participants' ? (
        <AccessSection
          roomId={roomId}
          room={room}
          entries={entries}
          section={participantsSection}
          onStatus={onStatus}
          onRoomsChanged={onRoomsChanged}
        />
      ) : null}
```

- [x] **Step 8: Add the copy**

```ts
  'counterparty.heading': 'Counterparties',
  'counterparty.explain':
    'Group readers by the firm they represent. A grant to a counterparty reaches every reader placed in it.',
  'counterparty.none': 'No counterparties yet.',
  'counterparty.caption': 'Counterparties in this room',
  'counterparty.columns.name': 'Counterparty',
  'counterparty.columns.readers': 'Readers',
  'counterparty.columns.actions': 'Actions',
  'counterparty.placement.caption': 'Which counterparty each reader belongs to',
  'counterparty.placement.reader': 'Reader',
  'counterparty.placement.counterparty': 'Counterparty',
  'counterparty.placement.none': 'None',
  'counterparty.placement.choose': 'Counterparty for {email}',
  'counterparty.name': 'Counterparty name',
  'counterparty.nameTaken': 'A counterparty with this name already exists in this room.',
  'counterparty.create': 'Create counterparty',
  'counterparty.creating': 'Creating…',
  'counterparty.created': 'Counterparty {name} created.',
  'counterparty.place': 'Place',
  'counterparty.place.title': 'Place this reader in a counterparty',
  'counterparty.place.consequence':
    '{email} gains the access that {name}’s grants give, immediately. Their own grants are unchanged.',
  'counterparty.placed': 'Reader placed in {name}.',
  'counterparty.remove': 'Remove from {name}',
  'counterparty.remove.title': 'Remove this reader from their counterparty',
  'counterparty.remove.consequence':
    '{email} loses the access that {name}’s grants gave, immediately. Their own grants are unchanged.',
  'counterparty.removed': 'Reader removed from {name}.',
  'counterparty.grant': 'Grant access to {name}',
  'counterparty.grant.review': 'Review grant',
  'counterparty.grant.title': 'Grant access to {name}',
  'counterparty.grant.apply': 'Grant access',
  'counterparty.grant.reach': 'Every reader placed in {name} gains this access. Readers placed now: {readers}.',
  'counterparty.grant.freshSignIn': 'A grant to a counterparty needs a sign-in from the last 15 minutes.',
```

- [x] **Step 9: Run the tests to verify they pass**

```bash
npx vitest run --project unit --maxWorkers=2
npm run typecheck && npm run lint
wc -l apps/web-client/src/workspace/views/RoomView.tsx apps/web-client/src/components/ParticipantsPanel.tsx
```

Expected: PASS; `RoomView.tsx` at most 30 lines over 776 across the milestone; `ParticipantsPanel.tsx` under 714.

- [x] **Step 10: Commit**

```bash
git add apps/web-client/src
git commit -m "Manage counterparties and grant a counterparty access"
```

---

### Task 14: Browser journeys, accessibility, and the record

**Files:**
- Create: `test/support/room-seeding.ts`
- Create: `test/browser/room-administration.spec.ts`
- Modify: `DESIGN.md` (Components: `ConfirmationDialog`, `NewRoomDialog`)
- Modify: `docs/room-administration-http-contract.md` (audit events)

**Interfaces:**
- Consumes: everything above; `startTestServer`, `TestServer.migrationPool`, `signInMember({globalRole, roomTitle, roomRole, withParticipant})` from `test/support/browser-server.ts`.
- Produces: no application code.

Each journey starts from seeded facts and makes every change it asserts through the product. Each role that reaches a surface is signed in once, and a role that must not see it is checked as well.

- [x] **Step 1: Write the seeding helpers**

Create `test/support/room-seeding.ts`:

```ts
/**
 * Room facts a browser journey starts from, seeded through the migration role. A journey
 * seeds where it begins and makes every change it asserts through the product.
 */
import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';

/** The room's structure has been published once, so the room may be made visible. */
export async function markStructurePublished(pool: Pool, roomId: string): Promise<void> {
  await pool.query('UPDATE room SET published_revision=published_revision+1 WHERE id=$1', [roomId]);
}

export async function archiveRoom(pool: Pool, roomId: string): Promise<void> {
  await pool.query("UPDATE room SET state='archived',revision=revision+1 WHERE id=$1", [roomId]);
}

/** A document entry in the working structure, created as `actorId` through the audited function. */
export async function addDocument(pool: Pool, roomId: string, actorId: string, title: string): Promise<string> {
  const working = (
    await pool.query<{ working_revision: number }>('SELECT working_revision FROM room WHERE id=$1', [roomId])
  ).rows[0]?.working_revision;
  if (working === undefined) throw new Error('room missing');
  const documentId = createOpaqueId();
  await pool.query('SELECT create_document_entry($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
    createOpaqueId(), documentId, null, title, 1, actorId, working, createOpaqueId(), createCorrelationId(),
  ]);
  return documentId;
}
```

- [x] **Step 2: Write the journeys**

Create `test/browser/room-administration.spec.ts`:

```ts
/**
 * Room administration, end to end: creation, visibility, purge, download exceptions and
 * counterparties, as the roles that may act and one that may not.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { startTestServer, type TestServer } from '../support/browser-server.ts';
import { addDocument, archiveRoom, markStructurePublished } from '../support/room-seeding.ts';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});
test.afterAll(async () => {
  await server.close();
});

type SignIn = Parameters<TestServer['signInMember']>[0];

async function signIn(page: Page, options: SignIn): Promise<Awaited<ReturnType<TestServer['signInMember']>>> {
  const seeded = await server.signInMember(options);
  await page.context().addCookies(seeded.cookies.map(({ name, value, url }) => ({ name, value, url })));
  await page.goto(server.baseUrl);
  return seeded;
}

async function openSettings(page: Page, roomTitle: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`Open room ${roomTitle}`, 'u') }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Room settings' })).toBeVisible();
}

test.describe('creating a room', () => {
  test('an Admin creates a room and lands in it as a draft', async ({ page }) => {
    await signIn(page, { globalRole: 'admin' });
    await page.getByRole('button', { name: 'New room' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create a room' });
    await expect(dialog).toContainText('The room starts as a draft');
    await dialog.getByLabel('Room title').fill('Project Atlas');
    await dialog.getByRole('button', { name: 'Create room' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive room' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish room' })).toHaveCount(0);
  });

  test('a plain member is not offered New room', async ({ page }) => {
    await signIn(page, { globalRole: 'member' });
    await expect(page.getByRole('button', { name: 'New room' })).toHaveCount(0);
  });
});

test.describe('room visibility', () => {
  test('a Room Manager publishes after review, then returns the room to draft in one step', async ({ page }) => {
    const seeded = await signIn(page, {
      globalRole: 'member',
      roomTitle: 'Series A',
      roomRole: 'manager',
      withParticipant: { email: 'reader@example.test', grant: 'active' },
    });
    if (seeded.roomId === null) throw new Error('room not seeded');
    await markStructurePublished(server.migrationPool, seeded.roomId);
    await openSettings(page, 'Series A');

    await page.getByRole('button', { name: 'Publish room' }).click();
    const review = page.getByRole('dialog', { name: 'Publish this room' });
    await expect(review).toContainText('Viewers who gain access: 1');
    const confirm = review.getByRole('button', { name: 'Publish room' });
    await expect(confirm).toBeDisabled();
    await review.getByLabel('Type PUBLISH ROOM to confirm').fill('PUBLISH ROOM');
    await confirm.click();
    await expect(review).toBeHidden();
    await expect(page.getByText('Published', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Return to draft' }).click();
    const kill = page.getByRole('dialog', { name: 'Return this room to draft' });
    await expect(kill.getByRole('textbox')).toHaveCount(0);
    await kill.getByRole('button', { name: 'Return to draft' }).click();
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  });

  test('a Contributor is not offered Settings', async ({ page }) => {
    await signIn(page, { globalRole: 'member', roomTitle: 'Series B', roomRole: 'contributor' });
    await page.getByRole('button', { name: /Open room Series B/u }).click();
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
  });
});

test.describe('purge', () => {
  test('the Owner schedules a purge, cannot return the room to draft, and cancels it', async ({ page }) => {
    const seeded = await signIn(page, { globalRole: 'owner', roomTitle: 'Closed deal' });
    if (seeded.roomId === null) throw new Error('room not seeded');
    await archiveRoom(server.migrationPool, seeded.roomId);
    await openSettings(page, 'Closed deal');

    await page.getByRole('button', { name: 'Schedule purge' }).click();
    const schedule = page.getByRole('dialog', { name: 'Schedule a purge of this room' });
    await expect(schedule).toContainText('30-day cancellation period');
    await schedule.getByLabel('Type SCHEDULE ROOM PURGE to confirm').fill('SCHEDULE ROOM PURGE');
    await schedule.getByRole('button', { name: 'Schedule purge' }).click();
    await expect(page.getByText(/Purge scheduled\. Everything in this room will be deleted after/u)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return to draft' })).toHaveCount(0);
    await expect(page.getByText('A purge is scheduled. Cancel it before returning this room to draft.')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel purge' }).click();
    const cancel = page.getByRole('dialog', { name: 'Cancel the scheduled purge' });
    await cancel.getByLabel('Type CANCEL ROOM PURGE to confirm').fill('CANCEL ROOM PURGE');
    await cancel.getByRole('button', { name: 'Cancel purge' }).click();
    await expect(page.getByText('No purge is scheduled.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return to draft' })).toBeVisible();
  });
});

test.describe('download exceptions', () => {
  test('a Room Manager allows downloads for one document from its row', async ({ page }) => {
    const seeded = await signIn(page, { globalRole: 'member', roomTitle: 'Series C', roomRole: 'manager' });
    if (seeded.roomId === null) throw new Error('room not seeded');
    await addDocument(server.migrationPool, seeded.roomId, seeded.memberId, 'Teaser');
    await page.getByRole('button', { name: /Open room Series C/u }).click();
    await page.getByLabel('Downloads for Teaser').selectOption('allow');
    const dialog = page.getByRole('dialog', { name: 'Change downloads for Teaser' });
    await dialog.getByRole('button', { name: 'Change downloads' }).click();
    await expect(page.getByRole('row', { name: /Teaser/u })).toContainText('Downloads allowed here');
  });
});

test.describe('counterparties', () => {
  test('a Room Manager creates a counterparty and places a reader in it', async ({ page }) => {
    await signIn(page, {
      globalRole: 'member',
      roomTitle: 'Series D',
      roomRole: 'manager',
      withParticipant: { email: 'buyer.reader@example.test', grant: 'active' },
    });
    await page.getByRole('button', { name: /Open room Series D/u }).click();
    await page.getByRole('button', { name: 'Access', exact: true }).click();
    await page.getByLabel('Counterparty name').fill('Buyer A');
    await page.getByRole('button', { name: 'Create counterparty' }).click();
    await expect(page.getByRole('row', { name: /Buyer A/u })).toContainText('0');
    await page.getByRole('button', { name: 'Place' }).click();
    const dialog = page.getByRole('dialog', { name: 'Place this reader in a counterparty' });
    await expect(dialog).toContainText('buyer.reader@example.test gains the access');
    await dialog.getByRole('button', { name: 'Place' }).click();
    await expect(page.getByRole('row', { name: /buyer\.reader@example\.test/u })).toContainText('Buyer A');
  });
});

test.describe('accessibility', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`Settings with a review open has no violations (${colorScheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      const seeded = await signIn(page, { globalRole: 'owner', roomTitle: `Axe ${colorScheme}` });
      if (seeded.roomId === null) throw new Error('room not seeded');
      await markStructurePublished(server.migrationPool, seeded.roomId);
      await openSettings(page, `Axe ${colorScheme}`);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.getByRole('button', { name: 'Publish room' }).click();
      await expect(page.getByRole('dialog', { name: 'Publish this room' })).toContainText('PUBLISH ROOM');
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });

    test(`Access with counterparties has no violations (${colorScheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await signIn(page, {
        globalRole: 'member',
        roomTitle: `Access ${colorScheme}`,
        roomRole: 'manager',
        withParticipant: { email: `axe.${colorScheme}@example.test`, grant: 'active' },
      });
      await page.getByRole('button', { name: new RegExp(`Open room Access ${colorScheme}`, 'u') }).click();
      await page.getByRole('button', { name: 'Access', exact: true }).click();
      await page.getByLabel('Counterparty name').fill('Buyer A');
      await page.getByRole('button', { name: 'Create counterparty' }).click();
      await expect(page.getByRole('row', { name: /Buyer A/u })).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });
  }

  test('a room is created and reviewed for publication with the keyboard alone', async ({ page }) => {
    const seeded = await signIn(page, { globalRole: 'admin', roomTitle: 'Keyboard review' });
    if (seeded.roomId === null) throw new Error('room not seeded');
    await markStructurePublished(server.migrationPool, seeded.roomId);

    await page.getByRole('button', { name: 'New room' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Room title')).toBeFocused();
    await page.keyboard.type('Keyboard room');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Create a room' })).toBeHidden();

    await page.getByRole('button', { name: 'Rooms', exact: true }).first().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: /Open room Keyboard review/u }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Settings', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Publish room' }).focus();
    await page.keyboard.press('Enter');
    const review = page.getByRole('dialog', { name: 'Publish this room' });
    await expect(review.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(review).toBeHidden();
    await expect(page.getByRole('button', { name: 'Publish room' })).toBeFocused();
  });

  test('Settings does not overflow at 320 CSS pixels', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await signIn(page, { globalRole: 'owner', roomTitle: 'Narrow' });
    await openSettings(page, 'Narrow');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
```

The keyboard journey leaves the created room through the frame's `Rooms` context action, which is the button `Workspace.tsx` renders while a room is open; if its accessible name differs, use the name it has. The Access tab's label is `workspace.tab.participants`, currently "Access"; check `en.ts` before running. If `members.spec.ts` excludes specific axe rules or regions with a documented reason, apply the same exclusions here rather than widening them.

- [x] **Step 3: Run the journeys**

```bash
free -h
npm run compose
node --env-file=.env ./node_modules/@playwright/test/cli.js test test/browser/room-administration.spec.ts
```

Expected: PASS on Chromium, Firefox and WebKit.

- [x] **Step 4: Record the shipped components**

In `DESIGN.md` → **Components**, extend the accessible-primitives entry: Base UI also provides `ConfirmationDialog` — one dialog for every reviewed, typed or single-press confirmation in room administration, with the consequence stated before the field that unlocks the action and Cancel taking initial focus — and `NewRoomDialog`, which focuses its title field because nothing destructive sits behind its primary action.

Append to `docs/room-administration-http-contract.md`:

````markdown
## Audit events

| Event | Reason codes | Written by |
|---|---|---|
| `room.create` | `ROOM_CREATED` | `create_room` |
| `room.state` | `ROOM_PUBLISHED`, `ROOM_ARCHIVED`, `ROOM_UNPUBLISHED` | `change_room_state`, reached only through `apply_room_visibility` |
| `download.policy` | `ROOM_DOWNLOAD_POLICY_CHANGED`, `DOCUMENT_DOWNLOAD_POLICY_CHANGED` | the two policy setters |
| `grant.default_expiry` | `DEFAULT_EXPIRY_CHANGED` | `apply_room_default_expiry` |
| `audit.retention` | `RETENTION_CHANGED` | `apply_audit_retention` |
| `room.purge` | `PURGE_SCHEDULED`, `PURGE_CANCELLED` | `schedule_room_purge`, `cancel_room_purge` |
| `participant.counterparty.create` | `COUNTERPARTY_CREATED` | `create_counterparty` |
| `participant.counterparty.assign` | `COUNTERPARTY_ASSIGNED` | `assign_viewer_counterparty` |
| `participant.counterparty.remove` | `COUNTERPARTY_REMOVED` | `remove_viewer_counterparty` |

No detail field carries an email, a title, a token or an object key.
````

- [ ] **Step 5: Manual screen-reader review**

Spec §8 requires a manual screen-reader pass over the new confirmation dialogs; automation cannot stand in for it. With VoiceOver (Safari) or NVDA (Firefox), open **Publish room** and **Schedule purge** and confirm: the dialog is announced by its title; the consequence is read before the confirmation field; the field's label names the exact phrase; a refusal is announced as an alert; Escape and Cancel return focus to the control that opened the dialog. Record reviewer, date, browser and screen reader, and any finding, under "Automated evidence completed" → a new "Manual accessibility" line in `docs/release-evidence.md`. A finding blocks the commit until fixed.

- [x] **Step 6: Full verification, one step at a time**

```bash
free -h
npm run format && npm run lint && npm run typecheck
npm run compose:verify && npm run compose:verify:minimal
npx vitest run --project unit --maxWorkers=2
npm run compose
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2
node --env-file=.env ./node_modules/@playwright/test/cli.js test test/browser/room-administration.spec.ts test/browser/workspace.spec.ts test/browser/workspace-sections.spec.ts test/browser/members.spec.ts test/browser/composition.spec.ts
wc -l apps/web-client/src/routes/Workspace.tsx apps/web-client/src/workspace/views/RoomView.tsx apps/web-client/src/components/ParticipantsPanel.tsx test/support/browser-server.ts
```

Expected: every step passes; `Workspace.tsx` ≤ 524, `RoomView.tsx` ≤ 806, `ParticipantsPanel.tsx` < 714, `browser-server.ts` = 1055.

- [x] **Step 7: Commit**

```bash
git add test DESIGN.md docs/room-administration-http-contract.md docs/release-evidence.md
git commit -m "Cover room administration in the browser, in both themes"
```

---

## Done when

- An Admin creates a room from the register and lands in it as a draft; a plain member is not offered New room.
- A Room Manager publishes a room after a review that counts the viewers who gain access, with the phrase and a fresh sign-in, and returns it to draft in one step on a stale sign-in.
- A Contributor is not offered Settings, and every settings, visibility, policy and counterparty route refuses them with the uniform 403.
- An archived room with a live purge cannot return to draft; the Owner can cancel the purge and schedule another.
- A Room Manager sets a document's download exception from its row; the exception is marked on the row; later metadata edits of that document still succeed.
- A Room Manager creates a counterparty, places a reader in it, removes them, and grants the counterparty access.
- `duefold_runtime` cannot execute `change_room_state`.
- Every capability key has a test proving it true exactly when its function accepts.
- Every mutation has its `audit_event` row written in its own transaction.
- Axe reports no violations on Settings (with a review open) and Access, in light and dark.
- A room can be created, and a publication review opened and dismissed, with the keyboard alone; a manual screen-reader pass over the confirmation dialogs is recorded in `docs/release-evidence.md`.

## Open questions for the product owner

These are decisions this plan does **not** make. Each has a default the plan follows until told otherwise.

1. **Retention after a room returns to draft.** `dry_run_audit_retention` gates on `state='draft'`, so a room that was published and then returned to draft can have its retention changed again. `DESIGN_SPEC.md` §15.4 says retention is configurable "before room publication". The plan mirrors the SQL (`setRetention` is Owner + draft). Locking it permanently after first publication would mean `022` also replaces `dry_run_audit_retention` and `apply_audit_retention` to require that the room has never been published.
2. **Archive without fresh sign-in.** §9.4 lists "publish, unpublish" among high-consequence changes "as applicable". The plan requires a fresh sign-in only to publish, the one direction that exposes content; archiving and returning to draft both reduce access.
3. **Duplicate-invite copy.** Mapping `23505` to `409` (Task 7) turns milestone 1's duplicate-invitation refusal from a 500 into "changed before this request completed — reload", which is true but not specific. A dedicated message would need a distinct code.
