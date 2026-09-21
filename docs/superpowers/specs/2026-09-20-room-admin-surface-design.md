# Room creation and administration surface — design

**Date:** 2026-09-20
**Basis:** `DESIGN_SPEC.md` v2.0 §4, §8, §9, §10, §15, §17, §20
**Status:** design approved in outline; implementation plan not yet written

## 1. Why this exists

Duefold can serve a room but cannot staff one. Three gaps sit behind that
sentence:

- `create_room` is implemented and Owner/Admin-gated in PostgreSQL
  (`modules/rooms-documents/migrations/004_room_structure.sql:482`) but no HTTP
  route reaches it, so a room can only be created by hand-written SQL.
- `modules/core-security/src/auth/oidc.ts:339` *consumes* a pending
  `kind='member'` invitation, but nothing anywhere *creates* one. A second
  member cannot be onboarded at all.
- `room_assignment` exists as a table with no function, route or UI, so a member
  who did sign in could not be given access to anything.

A further set of capabilities is built in SQL and unreachable above it:
`set_room_download_policy`, `set_document_download_policy`,
`set_installation_download_policy`, `dry_run_room_default_expiry` /
`apply_room_default_expiry`, and `change_room_state`. `/api/rooms/lifecycle`
exposes retention and purge but nothing calls it. §20.2's security/deployment
status surface does not exist.

This design covers all of it, in three milestones that ship in order.

## 2. Scope

**In scope**

1. **Room administration** — create a room; room state transitions
   (draft/published/archived); a room Settings section carrying retention
   years, default grant expiry, and room download policy; the existing
   retention and purge routes given a UI. Per-document download override.
2. **Organization administration** — invite a member with an intended global
   role; revoke a pending invitation; change a global role; disable and
   re-enable a member; transfer ownership; assign and revoke room assignments;
   create counterparties and place viewers in them.
3. **Installation status** — the §20.2 read-only security/deployment status
   surface, and the installation-wide download policy default.

**Out of scope** — everything in `DESIGN_SPEC.md` §3, unchanged. In particular
this design adds no custom roles, no permission copying, no room templates, and
no module-management UI (§5.2 forbids the last outright).

## 3. Decisions taken

| Question | Decision | Why |
|---|---|---|
| Who assigns members to rooms? | Owner/Admin only | §4.1 gives Admin "manages members, all rooms"; §4.2 gives Room Manager authority over "participants", which is Duefold's word for viewers and counterparties, not internal staff. Keeps "who inside the company can reach this room" answerable in one place. |
| Where does org administration live? | The top-level register becomes a tabbed workbench: Rooms · Members · Installation · Status | Reuses the `df-sections` grammar the room workspace already has, so the two levels read symmetrically and no third navigation concept is introduced. |
| Where do room settings live? | A sixth section inside a room | §4.2 gives room defaults and download policy to the Room Manager, who may not be an Admin, so these must not sit behind an Owner/Admin surface. |
| How does status read conformance results? | Persisted observations, written by CLI preflight and a scheduled worker job | Keeps §20.2's "does not configure infrastructure" literal, keeps the web process free of on-demand outbound conformance traffic, and makes staleness visible instead of hidden. |
| Route shape | Action-union `POST` routes, `audience: 'member'`, role decided in SQL | Matches `/api/rooms/actions`, `/api/rooms/lifecycle` and `/api/grants`; gives dry-run-then-confirm a natural home; keeps invariant 4 in one enforcement point. |
| Module placement | The module that owns the tables | §5.1 fixes four modules and invariant 17 forbids a fifth. |

## 4. Data model

Migrations are one global sequence across modules (001–016 today), so this adds
017–019. All new functions are `SECURITY DEFINER`, `SET search_path=public,pg_temp`,
owned by `duefold_migration`, executable by `duefold_runtime`, and write their
audit row in the same transaction as their mutation (invariant 14).

### 4.1 Migration 017 — `core-security`, organization administration

Schema:

- `invitation.intended_global_role text` — CHECK-tied to `kind`: one of
  `'admin' | 'member'` when `kind='member'`, NULL when `kind='viewer'`.
  Backfilled to `'member'` for existing pending member invitations.
- `invitation.invited_by text REFERENCES member(id)` — nullable, for
  pre-existing rows.

Functions:

| Function | Authority | Notes |
|---|---|---|
| `invite_member` | Owner/Admin | Creates the pending invitation, enqueues `mail.member_invitation`, audits `invitation.created`. Rejects an email already held by an active member or a pending invitation. |
| `revoke_member_invitation` | Owner/Admin | `pending` → `revoked`. |
| `set_member_global_role` | Owner/Admin | `'admin'` or `'member'` only. Refuses to target the Owner; ownership moves only through `transfer_ownership`. Expected-revision checked. |
| `set_member_state` | Owner/Admin | `'active'` or `'disabled'`. Refuses to disable the Owner with a clear error rather than letting the partial unique index raise. |
| `transfer_ownership` | Owner, fresh OIDC | See §4.2. Audits `ownership.transferred`. |
| `apply_room_assignments` | Owner/Admin | One call per member carrying both the assignments to add and the rooms to revoke. Inserts or reactivates revoked rows; revocation sets `revoked` and never deletes. Batched for the reason in §4.3. |
| `read_members` | Owner/Admin | Reader; see §4.4. |

`SECURITY_EVENT_TYPES` in `modules/core-security/src/audit.ts:6` already reserves
`'invitation.created'` and `'ownership.transferred'` and emits neither. This is
what they were reserved for. New types added alongside: `member.role`,
`member.state`, `room.assignment`.

**Invitation acceptance changes too.** `resolveOidcMember`
(`modules/core-security/src/auth/oidc.ts:348`) currently hardcodes
`global_role='member'`, so inviting an Admin would mean invite → sign in →
promote. It reads `intended_global_role` instead. The same edit closes an
invariant-14 gap discovered here: that insert creates a member and commits with
**no audit row at all**. Acceptance gains a `member.created` audit event in the
same transaction.

### 4.2 Ownership transfer has a mandatory statement order

Two mechanisms guard the single-owner invariant and they behave differently:

- `exactly_one_owner_after_member` is a `DEFERRABLE INITIALLY DEFERRED`
  constraint trigger, checked at **commit**. A transaction may therefore hold
  zero owners transiently.
- `one_active_owner` is a **partial unique index**. A partial unique index
  cannot be deferred and is checked **immediately**.

Therefore `transfer_ownership` must demote the outgoing Owner to `admin`
**first**, then promote the target to `owner`. The reverse order holds two
active owners between statements and raises an immediate unique violation. This
ordering is load-bearing and gets its own test.

### 4.3 Privilege changes revoke sessions, and that shapes the UI

`member_privilege_session_revoke` fires on any change to `global_role` or
`state`. `room_assignment_privilege_session_revoke` fires on **every** insert,
update or delete of a `room_assignment` row. Both revoke **all** of that
member's active sessions.

Two consequences are designed for rather than discovered:

1. Transferring ownership signs the outgoing Owner out mid-request. The apply
   response is handled as "your session has ended and here is why", not as a
   failure, and the confirmation dialog says so before the Owner commits.
2. Staffing a member across four rooms as four calls signs them out four times.
   `assign_room_member` therefore accepts a **batch** of assignments and
   revocations for one member and applies them in one transaction, producing one
   session revocation. The Members surface states that the member must sign in
   again.

### 4.4 `member.state='invited'` is dead, and the member list reflects that

`member.state` permits `'invited'`, but acceptance inserts `'active'` directly,
so an invited person exists only as an `invitation` row and never as a `member`
row. `read_members` returns the union of `member` rows and pending
`kind='member'` invitations, with invitations distinctly marked as
not-yet-accepted rather than rendered as if they were members. Each member row
carries their global role, state, and room assignments.

### 4.5 Rooms — no migration needed

No new SQL. `create_room` and `change_room_state` exist and are correctly
gated — `create_room` checks `global_role IN ('owner','admin')` itself. They
need routes, not functions.

### 4.6 Migration 018 — `participants-access`, policy and counterparties

`set_room_download_policy`, `set_document_download_policy`,
`set_installation_download_policy`, `dry_run_room_default_expiry` and
`apply_room_default_expiry` all exist, are correctly gated, and are owned by
`duefold_migration`, which is what lets them past the
`installation_download_policy_guard` trigger. They need routes only.

`create_counterparty`, `add_viewer_to_room` and `assign_viewer_counterparty`
**also already exist** in migration 007, Room-Manager-gated and audited, with no
TypeScript caller of any kind. Grants can already *target* a counterparty and
§9.1's viewer union depends on it, so today half the grant model is unreachable
purely for want of a route. Counterparties therefore need **no new SQL** either.

The only genuinely new function in this migration:

- `read_room_settings(actor, room)` — Room Manager. Returns room facts,
  retention years, default grant expiry, download policy, and the room's
  assignments.

**This reader belongs here, not in `rooms-documents`.** `default_grant_expires_at` and
`download_policy` are participants-access columns on the `room` table.
`participants-access requires rooms-documents` and not the reverse, so only this
module may read both sides without inverting the dependency.

### 4.7 Migration 019 — `core-security`, status observations

One table:

```
deployment_status_observation(
  check_name text,          -- 'oidc' | 'mail' | 'storage' | ...
  result text,              -- 'pass' | 'fail' | 'not-run'
  detail text,              -- redacted summary, no endpoint or credential
  source text,              -- 'cli' | 'worker'
  observed_at timestamptz,
  PRIMARY KEY (check_name)
)
```

Written by CLI preflight and by a new scheduled worker job
`status.observe`. Read-only from the web. Placed in `core-security`, which §5.1
gives "health, configuration". Other modules contribute their checks through a
registry contract shaped like the existing `ReadinessExtension`
(`modules/core-security/src/routes/health-ready.ts:22`) rather than by importing
across module boundaries.

`detail` is a redacted summary only. §20.3 forbids telemetry carrying object
keys, full emails or raw IPs, and the same rule binds this column: a failing
OIDC check records `ISSUER_DISCOVERY_FAILED`, never the issuer URL.

## 5. HTTP surface

All routes are `audience: 'member'`, require CSRF on mutation, and let
PostgreSQL decide Owner/Admin. Adding an audience cannot silently default-allow
(`apps/web/src/route-authority.ts:6`).

### `core-security`

| Method | Path | Body / query | Authority |
|---|---|---|---|
| `GET` | `/api/members` | — | Owner/Admin |
| `POST` | `/api/members/actions` | union: `invite`, `revoke-invitation`, `set-role`, `set-state`, `transfer-dry-run`, `transfer-apply`, `assign-rooms` | Owner/Admin; `transfer-apply` additionally fresh OIDC |
| `GET` | `/api/status` | — | Owner/Admin |

`assign-rooms` takes `{memberId, assign: [{roomId, roomRole}], revoke: [roomId], expectedRevision}` and applies the whole batch in one transaction (§4.3).

### `rooms-documents`

| Method | Path | Body / query | Authority |
|---|---|---|---|
| `POST` | `/api/rooms` | `{title, description}` → `201 {roomId}` | Owner/Admin, enforced by `create_room` |
| `POST` | `/api/rooms/actions` | two new members of the existing union: `room-state-dry-run`, `room-state-apply` | Room Manager |

**Naming matters here.** The union already holds `publish-dry-run` and
`publish-apply`, which publish the *structure*. The new members change *room
state*, which is a different thing: §10.1 makes returning a room to draft the
global viewer-access kill switch. The two must not read as variants of each
other, so the new members are named `room-state-*` and their copy says
"visibility", not "publish".

**Asymmetric confirmation.** Publishing or archiving a room requires dry-run
plus typed confirmation. Returning a room to draft is the *safe* direction — it
removes viewer access — and §10.1 calls it a kill switch, so it takes a single
confirmation with no dry-run round-trip. A kill switch that needs three steps is
not a kill switch.

### `participants-access`

| Method | Path | Body / query | Authority |
|---|---|---|---|
| `GET` | `/api/rooms/settings` | `roomId` | Room Manager |
| `POST` | `/api/policies` | union: `installation-download`, `room-download`, `document-download`, `default-expiry-dry-run`, `default-expiry-apply` | Owner/Admin for installation; Room Manager for the rest |
| `POST` | `/api/counterparties` | union: `create`, `assign-viewer`, `remove-viewer` | Room Manager |

`/api/rooms/settings` is declared by `participants-access` even though its path
sits under `/api/rooms`, because that is where its reader can legally live
(§4.6). Paths are not owned by modules; tables are.

## 6. Client architecture

### 6.1 Splitting the member frame

`apps/web-client/src/routes/Workspace.tsx` is 1079 lines and already carries two
views. This design adds roughly six panels, so it splits:

- `routes/Workspace.tsx` — thin frame: session, theme, which view is current.
- `workspace/views/RegisterView.tsx` — the room register plus the New room action.
- `workspace/views/AdministrationView.tsx` — Members, Installation, Status.
- `workspace/views/RoomView.tsx` — the existing sections plus Settings.

New components: `MembersPanel`, `MemberDetail`, `InstallationPanel`,
`StatusPanel`, `RoomSettingsPanel`, `NewRoomDialog`. `CounterpartyControls`
extends the existing `ParticipantsPanel` (714 lines — the counterparty work
splits it rather than growing it). The per-document download override is a
control in `StructureTable`.

### 6.2 Section tabs become a module contribution

`SECTIONS` at `Workspace.tsx:73` hardcodes `'branding'`. An installation that
omits the branding module therefore still ships the branding tab and
`BrandingPanel.tsx` in the browser bundle, which contradicts invariant 17
("disabled modules are absent from production artifacts, not hidden by runtime
flags") and §5.2's requirement that generated registries contain **navigation**.
Adding four more hardcoded entries would widen a gap this work is standing on.

No new build mechanism is needed. `apps/web-client/src/contract.ts` already
defines `BrowserContribution` and `apps/web-client/build/browser-entries-plugin.ts`
already emits literal static imports of exactly the composed modules' entries,
with no runtime discovery. The change is:

- `BrowserContribution` gains `sections?: readonly SectionContribution[]`, each
  `{id, scope: 'top' | 'room', labelKey, order, component}`.
- `BrandingPanel.tsx` moves into `modules/branding-notifications/src/browser/`
  and is contributed from there.
- The client builds both tab strips from composed contributions instead of a
  literal array.

An omitted module then contributes no section, is named by no import, and its
panel cannot reach the bundle — which is exactly the property
`DESIGN.md` "Build-time composition in the browser" already claims.

### 6.3 Interaction and accessibility

Following `DESIGN.md` and §21.2:

- Tab strips stay links-as-buttons in a `nav` with `aria-current`, not an ARIA
  tablist, matching the reasoning already recorded at `Workspace.tsx:751`.
- Tables carry captions and `scope`; member state and room state are named in
  words, never by colour alone.
- Typed-confirmation dialogs are `role="dialog"`, focus-trapped, labelled, and
  describe the irreversible effect before the field that unlocks the button.
- Status announcements go through the existing single polite live region rather
  than new ones.
- Every new surface is operable from 320 CSS pixels and by keyboard alone.

### 6.4 Designed states

Per §21.2 every new route gets loading, empty, validation, denied, stale,
offline and destructive-confirmation states. Two are specific to this work:

- **Denied.** A Member who reaches an admin tab gets "not available to your
  role" — the surface neither confirms nor denies what the tab would contain.
- **Session ended.** After `transfer-apply` the Owner's session is already
  revoked (§4.3). The client renders a designed sign-in surface explaining that
  the transfer succeeded and the session ended because privileges changed — not
  a generic auth error.

## 7. Threat model impact

| Risk | Control |
|---|---|
| Privilege escalation via role change | Owner/Admin gate in SQL; Owner untargetable by `set_member_global_role`; every change audited with actor, target, before and after. |
| Self-lockout | The Owner cannot be disabled or demoted except through `transfer_ownership`; `one_active_owner` plus the deferred constraint trigger backstop it. An Admin demoting themselves is permitted and reversible by the Owner. |
| Stale privileged session after change | Existing triggers revoke all sessions of the affected member; ownership transfer revokes the actor's own. |
| Invitation enumeration | The member surface is Owner/Admin-only and legitimately enumerates. §8.2's neutral-response requirement binds the unauthenticated viewer OTP surface, which is untouched. |
| Secret leakage through status | `detail` carries redacted codes only; no issuer URL, endpoint, bucket, credential or object key. Asserted by test. |
| Assignment as a covert access grant | Assignments are Owner/Admin-only, audited, and shown per member and per room so that internal access is answerable from both directions. |

## 8. Verification

- **Unit** — new SQL authorization suites under `test/authz/`, one per module,
  covering every role against every new function including the denied paths.
- **Integration** — full lifecycle: invite → accept with intended role → role
  change → assignment batch → disable → re-enable → ownership transfer. Explicit
  tests for the demote-then-promote ordering under the partial unique index, for
  one session revocation per assignment batch, and for stale-revision rejection
  on every optimistic-concurrency path.
- **Browser** — Playwright journeys for create room, invite member, change room
  settings, and read status, in both themes, keyboard-only.
- **Composition** — a test asserting that with branding omitted, the built
  bundle contains no branding section, no `BrandingPanel`, and no branding tab,
  extending the existing omission evidence.
- **Accessibility** — automated axe pass plus manual screen-reader review of the
  two new confirmation dialogs.

## 9. Migration, rollback, deletion

- All migrations are additive. 017 backfills `intended_global_role='member'` for
  existing pending member invitations; no destructive change.
- Rollback is forward-only for schema, per §5.2's immutability rule. The surface
  itself is reachable only through new routes, so rolling an image back removes
  the surface while leaving its data intact and consistent.
- Assignments and invitations are never deleted, only moved to `revoked`, so the
  audit trail stays reconstructable.
- `deployment_status_observation` holds one row per check and is overwritten in
  place; it carries no personal data and is excluded from export presets.

## 10. Milestones

1. **Organization administration** (017) — invite, roles, states, assignments,
   ownership transfer, member-invitation mail, Members tab. Unblocks everything
   else, since a room without staff is not usable.
2. **Room administration** (018) — create room, room state, Settings
   section, retention and purge UI, counterparties, download overrides.
3. **Installation status** (019) — observations table, worker job, CLI writes,
   Installation and Status tabs.

The client split (§6.1) and the section contribution (§6.2) land with
milestone 1, because that is the milestone that first adds a top-level tab.
