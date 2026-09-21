# Room creation and administration surface — design

**Date:** 2026-09-20
**Basis:** `DESIGN_SPEC.md` v2.0 §4, §8, §9, §10, §15, §17, §20
**Status:** milestone 1 implemented (`docs/superpowers/plans/2026-09-20-organization-administration.md`);
milestone 2 implemented (`docs/superpowers/plans/2026-09-21-room-administration.md`); milestone 3 planned
(`docs/superpowers/plans/2026-09-21-installation-status.md`)

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

Migrations are one global sequence across modules. Milestone 1 is 017 (its review
fixes were folded into it before it shipped) with 020 for the room register; milestone
2 is 022 (`rooms-documents`) and 023 (`participants-access`); milestone 3 is 024
(`core-security`), 025 (`rooms-documents`) and 026 (`participants-access`). All new functions are `SECURITY DEFINER`, `SET search_path=public,pg_temp`,
owned by `duefold_migration`, executable only by the credential that calls them
(`duefold_runtime` for the web, `duefold_authenticator` for member provisioning,
none for helpers), and write their audit row in the same transaction as their
mutation (invariant 14).

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
| `set_member_global_role` | Owner/Admin | `'admin'` or `'member'` only. Refuses to target the Owner; ownership moves only through `transfer_ownership`. **Refuses to target the actor themselves** (see §7.1). Promotion out of `member` supersedes that member's explicit room assignments and does not restore them on later demotion (see §7.2). Expected-revision checked. |
| `set_member_state` | Owner/Admin | `'active'` or `'disabled'`. Refuses to disable the Owner with a clear error rather than letting the partial unique index raise. |
| `transfer_ownership` | Owner, fresh OIDC | See §4.2. Audits `ownership.transferred`. |
| `apply_room_assignments` | Owner/Admin | One call per member carrying both the assignments to add and the rooms to revoke, at most 100 entries in total. A new assignment inserts a new active row; revocation sets `revoked` and never deletes, and a revoked row is never reactivated. A batch that changes nothing is refused, like a no-op role or state change. Batched for the reason in §4.3. |
| `read_members` | Owner/Admin | Reader; see §4.4. |

`SECURITY_EVENT_TYPES` in `modules/core-security/src/audit.ts:6` already reserves
`'invitation.created'` and `'ownership.transferred'` and emits neither. This is
what they were reserved for. New types added alongside: `member.role`,
`member.state`, `room.assignment`.

**Invitation acceptance changes too.** `resolveOidcMember`
(`modules/core-security/src/auth/oidc.ts`) hardcoded `global_role='member'`, so
inviting an Admin would have meant invite → sign in → promote, and its insert
created a member with **no audit row at all**. Acceptance moves into
`accept_member_invitation` (019), which reads the role from the invitation and
writes `invitation.accepted` and `member.created` in the same transaction;
first-owner bootstrap moves into `claim_first_owner`. The authenticator credential
then holds only `SELECT` on `member`, so no application credential can author a
member row or choose its role.

**Review fixes 018–021.** 018 adds `member_subject_capabilities` (see §4.4) and
`may_administer_organization`, and stops the ownership preview storing the
rendered impact, which held the successor's email. 019 is the acceptance change
above. 020 moves the room register's cursor and limit into `read_member_rooms`,
in `rooms-documents`, which owns it. 021 makes `apply_room_assignments`
set-based and records an `invitation.expired` lapse as a `system` event rather
than as the re-inviting Admin's act.

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

1. Transferring ownership revokes the outgoing Owner's sessions inside its own
   transaction. The apply still answers `200` with `sessionEnded: true`, because
   the handler has already run; only the next request is unauthenticated. The
   surface reports "your session has ended and here is why", not a failure, and
   the confirmation dialog says so before the Owner commits. A `401` from the
   apply itself means the transfer never ran.
2. Staffing a member across four rooms as four calls signs them out four times.
   `apply_room_assignments` therefore accepts a **batch** of assignments and
   revocations for one member and applies them in one transaction, producing one
   session revocation. The Members surface states that the member must sign in
   again.

### 4.4 `member.state='invited'` is dead, and the member list reflects that

`member.state` permits `'invited'`, but acceptance inserts `'active'` directly,
so an invited person exists only as an `invitation` row and never as a `member`
row. `read_members` returns the union of `member` rows and pending
`kind='member'` invitations, with invitations distinctly marked as
not-yet-accepted rather than rendered as if they were members. Each member row
carries their global role, state, room assignments, and `capabilities`
(`setRole`, `setState`, `assignRooms`, `transfer`): what the **acting** member may
do to that row, computed by `member_subject_capabilities` from the same
predicates the mutations refuse on. The surface renders a control only where its
flag is true, so an Admin is never offered a transfer and nobody is offered
controls on their own row. An invitation carries only withdrawal.

### 4.5 Migration 022 — `rooms-documents`, room creation and purge safety

`create_room` and `change_room_state` exist and are correctly gated. Exposing
them over HTTP makes four latent defects reachable, so 022 fixes them first:

- **A scheduled purge can destroy a live room.** Nothing stops an archived room
  with a scheduled purge from returning to draft and being published again; the
  purge job checks the purge row, not the room, and 30 days later deletes a room
  that is back in service. A trigger pins a room to `archived` while a purge is
  `scheduled`, `marker_pending` or `purging`. The purge must be cancelled first.
- **A cancelled purge can never be rescheduled.** `room_purge.room_id` is
  `UNIQUE`, so the cancelled row blocks every later schedule. It becomes a partial
  unique index over rows that are not `cancelled`.
- **The purge phrase cannot be typed.** `SCHEDULE PURGE FOR ROOM <32-character id>`
  invites pasting, which defeats the friction it exists for. It becomes the
  constant `SCHEDULE ROOM PURGE`; the room is bound by id and expected revision.
- **The client sends the entry revision as the document revision.** They move in
  lockstep today only because every writer bumps both. `set_document_download_policy`
  bumps the document alone, so the first download override would make every later
  metadata edit of that document fail as stale. `read_member_working_structure`
  returns `document_revision` and the client sends it.

Also in 022:

- `create_room` refuses a whitespace-only title and control characters with
  `22023`. Its TypeScript pre-validation threw plain errors, which the web process
  maps to `500`.
- `read_member_room(actor, room)` returns one register row by id, so an open room
  never depends on which register page happens to be loaded.
- `duefold_runtime` loses `EXECUTE` on `change_room_state`. It stays as the building
  block the visibility functions (§4.6) call, so a typed confirmation cannot be
  bypassed by calling it directly.

### 4.6 Migration 023 — `participants-access`, settings, visibility and counterparties

`set_room_download_policy`, `set_document_download_policy`,
`set_installation_download_policy`, `dry_run_room_default_expiry` and
`apply_room_default_expiry` all exist, are correctly gated, and are owned by
`duefold_migration`, which is what lets them past the
`installation_download_policy_guard` trigger. They need routes only.

`create_counterparty`, `add_viewer_to_room` and `assign_viewer_counterparty`
**also already exist** in migration 007, Room-Manager-gated and audited, with no
TypeScript caller of any kind. Grants can already *target* a counterparty and
§9.1's viewer union depends on it, so today half the grant model is unreachable
purely for want of a route. Two pieces are missing: nothing lists a room's
counterparties (a counterparty with no viewers is invisible to
`read_room_participants`), and nothing removes a viewer from one.

New functions:

- `read_room_settings(actor, room)` — Room Manager. One row: room facts, state,
  revision, retention years, default grant expiry, room download policy, the
  installation default it inherits, the live purge if any, and a `capabilities`
  object (`publish`, `archive`, `returnToDraft`, `setRetention`, `schedulePurge`,
  `cancelPurge`). Each capability mirrors exactly one function's refusals, as
  `member_subject_capabilities` does in 018, and the surface offers a control only
  where its capability is true.
- `read_room_download_overrides(actor, room)` — Room Manager. The documents that
  carry an explicit download policy.
- `dry_run_room_visibility` / `apply_room_visibility` — Room Manager. Publishing or
  archiving is a dry run plus typed confirmation; publishing additionally needs
  fresh OIDC, because it is the direction that exposes content (§9.4). Returning to
  draft is the kill switch (§10.1): no dry run, no phrase, no freshness. The dry
  run counts the viewers who gain or lose access, which is why these live here
  and not in `rooms-documents`.
- `read_room_counterparties(actor, room)` and `remove_viewer_counterparty(...)` —
  Room Manager. Removal revokes the membership row and never deletes it.
- `set_room_download_policy` and `set_document_download_policy` are replaced with
  the same signatures. The room setter folded authorization into its `UPDATE`, so a
  Contributor was told `409` ("reload") instead of `403`; both now authorize first
  and refuse a change to the value already held, since an audit row is evidence of
  a change.

The two counterparty uniqueness rules raise `23505`, which the failure mapping did
not know, so a duplicate reached the client as `500`. `23505` maps to `409` — which
also fixes milestone 1's duplicate-invitation refusal.

**These belong here, not in `rooms-documents`.** `default_grant_expires_at` and
`download_policy` are participants-access columns on the `room` table, and viewer
reach is participants-access data. `participants-access requires rooms-documents`
and not the reverse, so only this module may read both sides without inverting the
dependency.

The installation-wide download default stays with milestone 3 (§2 item 3), which
adds the Installation tab it belongs on. Milestone 2 shows it read-only as the
value a room inherits.

### 4.7 Migrations 024–026 — status observations, status readers, installation download default

§20.2 names eight facts. Each is read where it is already true, and only what no web
request can learn is observed and stored:

| §20.2 fact | Source | Owner |
|---|---|---|
| Application, build and manifest version | the root `package.json` version and the composed manifest, injected into the web runtime | `core-security` |
| Database migration state | the migration ledger against the composed registry | `core-security` |
| Storage privacy and versioning | worker observations `storage-privacy` and `storage-versioning` | `rooms-documents` (recorded into `core-security`'s table) |
| ClamAV signature age | worker observation `scanner`, carrying the signature build time | `rooms-documents` |
| Worker queue and failed processing | live counts over `job_queue` and `document_version` | `core-security`, `rooms-documents` |
| OIDC and mail conformance | OIDC: the discovery and client-authentication check the web process must pass before it serves anything, reported with the time it passed; mail: delivery evidence in `job_queue` | `core-security` |
| Restore drill and recovery expectation | `operational_recovery_status`, which the CLI already maintains | `rooms-documents` |
| Update availability and security advisory | CLI observation `updates`, recorded by `updates check-file` | `core-security` |

**024 (`core-security`)** adds one table, overwritten in place:

```
deployment_status_observation(
  check_name text PRIMARY KEY,   -- closed set: storage-privacy, storage-versioning,
                                 --   scanner, updates
  result text,                   -- 'pass' | 'attention' | 'fail'
  code text,                     -- ^[A-Z][A-Z0-9_]{0,63}$
  evidence_at timestamptz,       -- scanner only: the signature build time
  evidence_version text,         -- updates only: the offered release, X.Y.Z
  observed_at timestamptz
)
```

A check that has never run has no row and reads as "not yet checked"; there is no stored
`not-run`. `code` is a pattern-bound code rather than a summary, so an issuer URL, endpoint,
bucket, host, e-mail or credential cannot be written into it at all (§20.3). There is no
`source` column: which process may record a check is fixed by the check, and is enforced by
two writers — `record_worker_status_observation` (storage and scanner, `EXECUTE` for
`duefold_worker`) and `record_update_observation` (the update check, callable only by the
migration role the CLI runs as). `read_deployment_status` and `read_status_observations`
are Owner/Admin; each observation carries `stale` once it is older than three hours (worker
checks) or thirty days (the update check). An update check is relative to the release that
was running when it was made, so once the offered release is installed the surface reads it
as current. Observations are not security mutations and write no audit row.

OIDC is not observed separately. The CLI runs on a network with no egress and the worker
holds no OIDC configuration, while the web process already performs discovery and
client-authentication negotiation at startup and refuses to start if either fails; the
surface reports that check and when it passed.

**025 (`rooms-documents`)** adds `read_content_status` (Owner/Admin: failed processing
count and the recovery record) and seeds the self-rescheduling hourly worker job
`status.observe`, first due an hour after migration as the ownership preview sweep is. The
job probes storage privacy (an unauthenticated request for a random
key and for a listing must both be refused), storage versioning (`GetBucketVersioning` with
the worker credential; a provider or credential that cannot answer reads as "not
detectable", never as enabled) and scanner signatures. The privacy probe reaches the S3 API
endpoint only: a provider-side public URL such as R2's `r2.dev` domain is invisible to it,
and the surface says exactly what was tested.

**026 (`participants-access`)** makes the installation download default a reviewed change.
`read_installation_settings`, `dry_run_installation_download_policy` and
`apply_installation_download_policy` are Owner/Admin. Allowing original downloads
installation-wide widens every inheriting room at once, so it needs the review, the typed
phrase `ALLOW ORIGINAL DOWNLOADS` and a fresh sign-in (§9.4, broad grant). Denying is the
restrictive direction and needs only the review and one confirmation. The 007 setter
`set_installation_download_policy` loses its runtime grant, so nothing bypasses the review.

## 5. HTTP surface

All routes are `audience: 'member'`, require CSRF on mutation, and let
PostgreSQL decide Owner/Admin. Adding an audience cannot silently default-allow
(`apps/web/src/route-authority.ts:6`).

### `core-security`

| Method | Path | Body / query | Authority |
|---|---|---|---|
| `GET` | `/api/members` | — | Owner/Admin |
| `POST` | `/api/members/actions` | union: `invite`, `revoke-invitation`, `set-role`, `set-state`, `transfer-dry-run`, `transfer-apply`, `assign-rooms` | Owner/Admin; `transfer-apply` additionally fresh OIDC |
| `GET` | `/api/status` | — → version, manifest, migrations, queue, mail, observations | Owner/Admin |

`assign-rooms` takes `{memberId, assign: [{roomId, roomRole}], revoke: [roomId]}`, at most 100 entries in total, and applies the whole batch in one transaction (§4.3).

`GET /api/session` answers `mayAdministerOrganization` for a member session. It
decides only whether the Members view is offered; `read_members` and every
mutation refuse independently.

### `rooms-documents`

| Method | Path | Body / query | Authority |
|---|---|---|---|
| `GET` | `/api/status/content` | — → failed processing count, recovery record | Owner/Admin |
| `POST` | `/api/rooms` | `{title, description}` → `201 {roomId}` | Owner/Admin, enforced by `create_room` |
| `GET` | `/api/rooms?roomId=` | one register row by id | any member who can reach the room |

### `participants-access` — room visibility

| Method | Path | Body / query | Authority |
|---|---|---|---|
| `POST` | `/api/rooms/visibility` | union: `dry-run`, `apply` | Room Manager |

**Naming matters here.** `/api/rooms/actions` already holds `publish-dry-run` and
`publish-apply`, which publish the *structure*. Visibility changes *room state*,
which is a different thing: §10.1 makes returning a room to draft the global
viewer-access kill switch. The two must not read as variants of each other, so
visibility has its own path and its copy says "visibility", not "publish". The path
is declared by `participants-access` because its dry run counts viewer reach (§4.6).

**Asymmetric confirmation.** Publishing or archiving a room requires dry-run
plus typed confirmation. Returning a room to draft is the *safe* direction — it
removes viewer access — and §10.1 calls it a kill switch, so it takes a single
confirmation with no dry-run round-trip. A kill switch that needs three steps is
not a kill switch.

### `participants-access`

| Method | Path | Body / query | Authority |
|---|---|---|---|
| `GET` | `/api/rooms/settings` | `roomId` → `{settings, downloadOverrides}` | Room Manager |
| `POST` | `/api/policies` | union: `room-download`, `document-download`, `default-expiry-dry-run`, `default-expiry-apply` | Room Manager |
| `GET` | `/api/installation` | — → `{settings: {downloadPolicy, revision, inheritingRoomCount}}` | Owner/Admin |
| `POST` | `/api/installation/download-policy` | union: `dry-run {policy}`, `apply {policy, expectedRevision, confirmation?}` | Owner/Admin; allowing additionally fresh OIDC |
| `POST` | `/api/counterparties` | union: `create`, `assign-viewer`, `remove-viewer` | Room Manager |
| `GET` | `/api/participants` | gains `counterparties: [{counterpartyId, name, revision, viewerCount}]` | Room Manager |

`/api/rooms/settings` is declared by `participants-access` even though its path
sits under `/api/rooms`, because that is where its reader can legally live
(§4.6). Paths are not owned by modules; tables are.

The installation default has its own routes rather than joining `/api/policies`: that
union is Room Manager authority, the installation default is Owner/Admin, and one body
union should not carry two authorities.

## 6. Client architecture

### 6.1 Splitting the member frame

`apps/web-client/src/routes/Workspace.tsx` is 1079 lines and already carries two
views. This design adds roughly six panels, so it splits:

- `routes/Workspace.tsx` — thin frame: session, theme, which view is current.
- `workspace/views/RegisterView.tsx` — the room register plus the New room action.
- `workspace/views/AdministrationView.tsx` — Members, Installation, Status. Its top-level
  tab reads **Administration** once it holds more than Members, and its inner strip is
  labelled "Administration sections" so the two navigation landmarks are distinct.
- `workspace/views/RoomView.tsx` — the existing sections plus Settings.

New components: `MembersPanel`, `MemberDetail`, `InstallationPanel`,
`StatusPanel`, `RoomSettingsPanel`, `NewRoomDialog`. `CounterpartyControls`
extends the existing `ParticipantsPanel` (714 lines — the counterparty work
splits it rather than growing it). The per-document download override is a
control in `StructureTable`.

The room Settings section owns its own state, like a contributed section: `RoomView`
adds a tab and one render line, and does not grow a hook's worth of props. The
Settings tab is offered only where the register row says the member holds Room
Manager authority (`canPublish`), and each control inside it only where the
server's `capabilities` says the call would be accepted.

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
| Self-lockout | The Owner cannot be disabled or demoted except through `transfer_ownership`; `one_active_owner` plus the deferred constraint trigger backstop it. No member may change their own role or state at all (§7.1). |
| Stale privileged session after change | Existing triggers revoke all sessions of the affected member; ownership transfer revokes the actor's own. |
| Invitation enumeration | The member surface is Owner/Admin-only and legitimately enumerates. §8.2's neutral-response requirement binds the unauthenticated viewer OTP surface, which is untouched. |
| Secret leakage through status | Observations store a pattern-bound `code`, not prose, so no issuer URL, endpoint, bucket, host, credential or object key can be written; the response is asserted free of every configured value. |
| Forged status | Each check has one writer, granted only to the process that runs it; the web credential writes nothing. A green check says what was tested and when, and turns stale on its own. |
| Installation-wide download exposure | Allowing original downloads installation-wide needs a review naming the inheriting rooms and reachable documents, the typed phrase and a fresh sign-in; the 007 setter is no longer callable by the web credential. |
| Assignment as a covert access grant | Assignments are Owner/Admin-only, audited, and shown per member and per room so that internal access is answerable from both directions. |
| Purge of a room returned to service | A trigger pins a room to `archived` while its purge is live; returning it to draft requires cancelling the purge, which is Owner-only, typed, and audited. |
| Typed confirmation bypassed by calling the building block | `duefold_runtime` has no `EXECUTE` on `change_room_state`; visibility changes reach it only through `apply_room_visibility`. |

### 7.1 Self-administration is refused, not permitted

This section previously said an Admin demoting themselves was "permitted and
reversible by the Owner". The implementation refuses it — `set_member_global_role`
and `set_member_state` both reject `p_target_id = p_actor_id` — and the refusal is
the better rule, so the spec is corrected rather than the code.

"Reversible by the Owner" is only true while an Owner is reachable. A sole Admin who
demotes themselves in an installation whose Owner has left the company, lost their
OIDC account, or simply never signs in has locked the organization out of member
administration entirely, and recovery then needs the CLI and database access. The
reversibility the old wording relied on is an assumption about staffing, not a
property of the system.

Refusing costs nothing: an Admin who should no longer be one is demoted by the Owner
or by another Admin, which is the same outcome through a path that cannot strand the
installation. Self-disabling is refused for the same reason and additionally because
it would revoke the actor's own sessions mid-request.

The Owner is separately untargetable by both functions, so ownership moves only
through `transfer_ownership`, which demotes the outgoing Owner to `admin` as part of
one audited transaction. Ownership therefore remains transferable without exception.

### 7.2 A superseded assignment is not restored by demotion

An Admin or Owner reaches every room by role, so promoting a plain Member out of
`member` makes their explicit `room_assignment` rows redundant.
`supersede_room_assignments_for_role` revokes them and audits the set as
`ROOM_ASSIGNMENTS_SUPERSEDED`. Demoting that member back to `member` does **not**
reinstate them; they return with no room access until someone staffs them again.

This is deliberate. Restoring on demotion would grant room access as a side effect of
a role change, in a request that named no room — against invariant 7, allow-only
grants. The superseding audit row names every revoked room, so the previous set is
recoverable as an intentional, audited assignment batch rather than as an implicit
consequence of demotion.

The asymmetry is the safe direction: the failure mode of not restoring is a member
who must ask for access, and the failure mode of restoring is a member who silently
regains access to a room they were removed from while promoted.

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

1. **Organization administration** (017, with 020 for register paging) — invite, roles,
   states, assignments, ownership transfer, member-invitation mail, Members tab.
   Unblocks everything else, since a room without staff is not usable.
2. **Room administration** (022, 023) — create room, room state, Settings
   section, retention and purge UI, counterparties, download overrides.
3. **Installation status** (024, 025, 026) — observations table, worker job,
   CLI writes, Installation and Status tabs, installation download default.

The client split (§6.1) and the section contribution (§6.2) land with
milestone 1, because that is the milestone that first adds a top-level tab.
