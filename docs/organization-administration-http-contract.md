# Organization administration HTTP contract

Both routes are declared `audience: 'member'` and carry **no role branch in the handler**. Owner/Admin authority, target eligibility, optimistic concurrency, typed confirmation, dry-run evidence, OIDC freshness, and the audit row are all decided inside `SECURITY DEFINER` functions in migration `017_organization_administration.sql`, which commit the mutation and its `audit_event` row in one transaction (`DESIGN_SPEC.md` §15.1, invariant 14). A check in the route would be advisory and could drift from the authoritative one.

Migration 017 also narrows the direct table privileges migration 001 had granted, so the audited functions are the only path to a room privilege or an invitation's intended role. See "Direct table authority" below.

IDs are opaque 32-character values. Dates are RFC 3339 UTC instants, except the pagination cursor (below). Every request body schema is closed (`additionalProperties: false`), the action union has no permissive default, and every emitted status — success and error — has a declared response schema.

## `GET /api/members`

`csrf: false` (it is a read). Members, pending invitations, and assignments are all growing collections, so the response is one bounded keyset page (§23).

```
?limit=<1..100>&afterCreatedAt=<cursor>&afterSubjectId=<id>

200 {subjects:[{subjectKind,subjectId,emailDisplay,globalRole,state,revision,createdAt,assignments:[{roomId,roomRole}]}],
     nextCursor?:{createdAt,subjectId}}
```

`limit` defaults to 50 and is capped at 100, enforced in SQL as well as in the schema. Both cursor components travel together — a partial cursor is `400`.

**`nextCursor` is present only when a further page provably exists.** The reader looks one row beyond the page internally and returns at most `limit`; that extra row is the proof of continuation and is never shown. Offering a cursor whenever a page was merely *full* advertised another page for any collection whose size is an exact multiple of the limit, so a client walking to the end always made one request that returned nothing.

**Every subject carries its complete active assignment set.** Rooms are a growing collection with no installation cap, so a page still needs a second bound — but that bound falls on **subjects**, not on any one member's rooms. One page carries at most 500 assignment rows in total; when the next subject's complete set would not fit, the page ends there and the ordinary cursor reaches the remainder. The leading subject is always returned, so a page is never empty while subjects remain; that stays bounded because `assign-rooms` caps one member at 500 active assignments, which is the same number as the page budget.

The previous shape truncated the assignment arrays instead and reported one `assignmentsTruncated` flag. That flag could only say *something* on the page was incomplete: a client could not learn **which** member's room list was short, and a short room list reads as that member's whole access — a false access claim — with no bounded route to the rest. There is now no partial-access response to describe, so the field is gone and `nextCursor` is the whole completeness contract.

**A page can be shorter than `limit` and still continue.** That is what the assignment budget looks like from outside, so a client must follow `nextCursor` rather than stop when a page looks short. Subjects and their assignments come from one SQL statement, so a page's room lists belong to the same snapshot as its members.

An assignment array longer than 500 means the server and this process disagree about the per-member bound; the route fails closed with `500 INTERNAL` rather than answering with a prefix that would read as complete.

**The cursor is echoed unmodified and is not RFC 3339.** `nextCursor.createdAt` is PostgreSQL's exact `timestamptz` text (space separator, numeric offset, microsecond precision). `timestamptz` holds microseconds while a JavaScript `Date` holds milliseconds, so a client that parsed and re-serialized it would send back a truncated instant; truncation moves the cursor earlier than the row it came from and, in descending order, silently skips every subject tied at that microsecond. Each subject's own `createdAt` field remains RFC 3339 for display.

`subjectKind` is `"member"` or `"invitation"` and is load-bearing. `member.state` admits `'invited'`, but OIDC acceptance inserts `'active'` directly and no transition leads into `'invited'`, so an invited person exists **only** as an invitation row. A surface that rendered the two alike would claim someone has access before they have ever signed in. An invitation subject carries `state:"pending"`, its intended global role, and an empty `assignments` array.

Authorization: Owner/Admin. `read_members` refuses anyone else with SQLSTATE 42501, which the error mapping turns into the uniform `403 {error:{code:"FORBIDDEN"}}`. A denied response therefore discloses nothing about whether members exist.

A `globalRole`, `state`, or `roomRole` value this process does not recognize is a fault (`500 INTERNAL`), not a rendered row: substituting a guess would show access the server did not describe.

## `POST /api/members/actions`

CSRF-verified. Discriminated on `action`; the handler switches exhaustively with a `never` default.

| `action` | Request | Response | Authority and behaviour |
|---|---|---|---|
| `invite` | `{email,intendedRole}` | `201 {invitationId,intendedRole,expiresAt}` | Owner/Admin. The address is normalized once by the shared normalizer (§8.2); `invite_member` re-derives the comparison key from the display value and refuses a pair that disagrees, so an invitation cannot admit one address while its onboarding mail goes to another. Creates the pending invitation, enqueues `mail.member_invitation`, and audits `invitation.created` atomically. Refuses an address already held by a member (`409`) or already pending (`409`). |
| `revoke-invitation` | `{invitationId}` | `204` | Owner/Admin. `pending` → `revoked`, withdraws the still-pending onboarding mail job, audits `invitation.revoked`. A non-pending invitation is `409`. |
| `set-role` | `{memberId,role,expectedRevision}` | `200 {memberId,revision}` | Owner/Admin. `role` is `admin` or `member` only. The Owner is untargetable, so ownership moves solely through `transfer-apply`; an unknown member id gives the same `403`, so a denial cannot enumerate ids. Self-administration is refused. A no-op role is `400`, because an audit row reading "admin to admin" is evidence of a change that never happened. The target row is locked before the decision; a stale `expectedRevision` is `409`. `member_privilege_session_revoke` revokes the member's active sessions. Promotion out of `member` **supersedes** the member's explicit assignments — see below. |
| `set-state` | `{memberId,state,expectedRevision}` | `200 {memberId,revision}` | Owner/Admin. `state` is `active` or `disabled`. Disabling the Owner is refused with a reason (`403`) rather than surfacing as a deferred constraint violation at COMMIT that no surface can explain. Self-administration, a no-op state, and a stale revision behave as for `set-role`. Sessions are revoked by the same kernel trigger. |
| `transfer-dry-run` | `{memberId}` | `200 {impact:{previewId,targetEmailDisplay,confirmation,message,expectedRevision,revokedAssignmentCount,revokedAssignments:[{roomId,roomTitle,roomRole}],revokedAssignmentsTruncated}}` | Owner only. Records a one-time preview bound to actor, target, the target's revision, and a digest of the target's active assignment set, valid for 15 minutes. Names the assignments the promotion will revoke — see below. |
| `transfer-apply` | `{memberId,previewId,expectedRevision,confirmation}` | `200 {transferred:true,sessionEnded:true}` | Owner only, fresh OIDC (§9.4), and the `previewId` the dry run issued. Bound to the exact assignment impact that preview described. See below. |
| `assign-rooms` | `{memberId,assign:[{roomId,roomRole}],revoke:[roomId]}` | `200 {memberId,changed,assignments:[{roomId,roomRole}]}` | Owner/Admin. One call per member, at most 100 entries, active plain **Member** targets only. `assignments` is the member's **complete resulting active set**, not a count the surface would have to interpret. Complete is kept honest by a hard bound: a batch that would take one member past 500 active assignments is refused whole (`400`) rather than answered with a truncated set. |

### Ownership apply requires the dry run, not just its phrase

The confirmation phrase is a fixed, documented string, so comparing a caller's input against it proves only that the caller can read this document. `transfer-apply` therefore additionally consumes the `previewId` that `transfer-dry-run` recorded. The preview is bound to the acting Owner, the named target, the target's revision at preview time, and a digest of the target's active assignment set; it expires in 15 minutes and is single-use. An absent, foreign, already-spent, or lapsed preview is one uniform `403`, so a caller that never previewed learns nothing about which previews exist. A target that changed after the preview was issued is `409` — the Owner agreed to an impact that no longer holds.

The typed phrase remains as the deliberate human gate and is compared against the phrase the server stored in that preview record. Consumed previews are retained rather than deleted, so the evidence that a preview preceded a transfer survives alongside the audit row. `ownership_transfer_preview` is definer-only state; no application role can read or write it.

### The dry run names the assignments the transfer will revoke

§4.2 gives the Owner standing Room Manager authority in every room, so promotion to Owner **supersedes** every explicit assignment the successor holds. A preview that described only the role change asked the Owner to approve a privilege revocation it never mentioned, and a typed phrase cannot consent to something that was never shown.

The preview therefore carries an exact `revokedAssignmentCount` plus the rooms themselves, each with its title, ordered by `(title, roomId)`. Titles are disclosed because the preview is Owner-only and the Owner already holds Room Manager authority in every room, so nothing named there is newly visible to them; nothing beyond room identity, title, and role is included. The named list is capped at 100 entries because it carries titles, and `revokedAssignmentsTruncated` states when the cap applied — the count stays exact, so a preview cannot understate the revocation by listing fewer rooms than it will take away. `GET /api/members` carries any one member's complete set, so the remainder is reachable there.

**The disclosure and the digest come from one locked snapshot.** `transfer-dry-run` takes the target member's row lock — the same serialization point `assign-rooms` takes before it validates or writes anything — and derives the disclosed rooms, the exact count, the truncation flag, the target's revision, and the stored digest from a single read under it. This is load-bearing rather than tidiness: deriving them in separate statements let `assign-rooms` commit in between under READ COMMITTED, so the Owner was shown set A while the preview stored a digest for set B. Apply then locked the target, recomputed the digest, found B, matched the stored value, and revoked rooms that were never disclosed — the exact-set fence defeated by the evidence meant to enforce it, and undetectable at apply time because both halves of the preview were by then mutually consistent. A dry run issued while a staffing batch for that member is in flight therefore waits for it and describes the committed result.

Only the target is locked. The acting Owner's authority is an unlocked read here because `transfer-apply` locks actor-then-target, and a dry run that also locked the actor after the target could deadlock against it; apply re-decides Owner authority under its own lock regardless.

### Apply is bound to that exact assignment impact

`member.revision` does **not** move when a `room_assignment` row changes, so the revision the preview already carried could not notice a successor being staffed into or out of a room between preview and apply: the transfer then revoked a set the Owner had never seen, with no refusal.

The preview records a digest over the successor's active assignments — assignment id, room, and role, in room order — and `transfer_ownership` recomputes it under the target's row lock, after the demotion eligibility checks and before any write. A mismatch is `409 CONFLICT`: nothing is demoted, nothing is promoted, no assignment is revoked, the preview is **not** spent, and no audit row is written, because a spine entry describing a transfer that did not happen is worse than none. The Owner previews again and approves the impact that actually holds.

### Ownership transfer statement order is load-bearing

`one_active_owner` is a partial unique index: it cannot be deferred and is checked immediately, so two active owners may not coexist even for one statement. `exactly_one_owner_after_member` is a `DEFERRABLE INITIALLY DEFERRED` constraint trigger checked at COMMIT, so zero owners in between is legal. `transfer_ownership` therefore demotes the outgoing Owner to `admin` first and promotes the successor second. The reverse order raises `23505`. An authz test asserts the index directly so a future reordering fails loudly rather than intermittently.

### A completed transfer ends the acting session

`member_privilege_session_revoke` revokes the outgoing Owner's sessions inside the transfer's own transaction, so the `transfer-apply` response arrives on a session that no longer exists and the next request on that cookie is `401`. That is the documented outcome of a completed transfer, not a failure. The response states `sessionEnded:true` so the client can present it as such instead of an unexplained authentication error.

### Promotion supersedes explicit room assignments

§4.2 gives Owners and Admins Room Manager authority in **every** room, and only Members receive explicit assignments — which is what `assign-rooms` enforces on its target. Promotion must therefore not leave those rows behind. It previously did, with two consequences: the member list advertised a narrower `contributor` row on someone who actually held standing Manager rights, and a later demotion made those stale rows authorization-effective again with no assignment mutation and no audit row naming the change.

`set-role` to `admin` and `transfer-apply` (which promotes the successor to Owner) therefore revoke the target's active assignments in the same transaction, under the member-row lock they already hold. Revoking is chosen over refusing the promotion: the rows carry no authority the promotion does not already grant, so removing them takes nothing away, while refusing would make routine administration a two-step dance whose first step is unrelated to the administrator's intent. For `transfer-apply` the Owner is shown that set first and the apply is bound to it, as above.

The effect is recorded as its own `room.assignment` event with reason code `ROOM_ASSIGNMENTS_SUPERSEDED`, because a privilege set changed and §15.1 requires the spine to name it. It shares the caller's correlation id, so the role change and its effect read as one action. Revocation sets state and never deletes, matching `assign-rooms`, so the terminal history stays reconstructable. A demotion to `member` grants nothing and writes no such event.

### Room assignment: eligible targets, one batch, immutable history

Only an **active plain Member** is assignable. §4.2 gives Owners and Admins Room Manager authority in every room, so an assignment row for an administrator would advertise a narrower role than the authority they actually keep. An Owner, an Admin, a disabled member, and an unknown id all receive the same `403`. An administrator cannot assign or revoke their own rooms: that would fire `room_assignment_privilege_session_revoke` against the acting session while the response reported only the assignment.

`room_assignment_privilege_session_revoke` fires on every insert, update and delete of a `room_assignment` row and revokes **all** of that member's active sessions. Staffing someone across four rooms as four calls would sign them out four times; one transaction produces one revocation.

**Batches for one member are serialized on the target member row**, taken before anything is decided. Locking only individual assignment rows left batches naming different rooms with no common lock: both could commit, and each returned a "complete resulting set" that omitted the other's rows. The same lock excludes a concurrent `set-state` or `set-role`, so assignments cannot land on a member who has just become ineligible.

Every room in the batch — assigned **or revoked** — must exist. An unknown room in the revoke list is `403`, the same denial an unknown assignment target receives; previously it was indistinguishable from a valid unassigned room and produced `changed=0`, a success response, and a success audit row. Revoking a room the member simply does not hold remains a legitimate `changed=0` success.

The whole batch is validated before anything is written, so a malformed entry cannot leave a half-applied change or an audit row describing rolled-back work. Duplicate rooms within a batch, and a room both assigned and revoked, are refused rather than resolved by a guess.

Revocation never deletes. `one_active_room_assignment` constrains only the **active** `(room_id, member_id)` pair, so re-staffing inserts a new active row beside the retained revoked ones and the assignment lifecycle stays reconstructable. `enforce_state_transition` still permits only `active → revoked`, so nothing resurrects a revoked row by UPDATE either. Readers that explain *why* a room is reachable join the active row only, so a retained revoked assignment never advertises a role the member no longer holds.

## Direct table authority

Migration 001 granted `duefold_runtime` full DML on `room_assignment` and `duefold_authenticator` full DML on `room_assignment`, `invitation`, and `member`. Those grants made every boundary above bypassable with plain SQL: the web credential could grant or revoke a room privilege with no administrator check and no audit row, and the authenticator credential could rewrite an invitation's `intended_global_role` from `member` to `admin` before acceptance. Both defeat invariant 14.

Migration 017 narrows them to what each credential's remaining direct SQL actually needs. PostgreSQL grants are additive and migration 007's narrow re-grant never removed 001's broad one, so 017 revokes the broad grant first and restates the narrow privileges.

| Table | `duefold_runtime` | `duefold_authenticator` | `duefold_worker` |
|---|---|---|---|
| `room_assignment` | `SELECT` | `SELECT` | none |
| `invitation` | none | `SELECT`, `UPDATE(state)` | none |
| `member` | `SELECT` | `SELECT/INSERT/UPDATE/DELETE` | none |
| `ownership_transfer_preview` | none | none | none |

Both credentials keep `SELECT` on `room_assignment` because session authorization resolves a member's room roles on every request. The authenticator keeps `UPDATE(state)` on `invitation` — and nothing more — because acceptance marks an invitation accepted; it can neither author an invitation nor choose the role one carries. `member` DML stays with the authenticator because first-owner bootstrap, OIDC acceptance, and guarded CLI owner recovery all write member rows on that credential, each with its audit row in the same transaction.

Authorization-matrix tests assert the **final installed** table and column ACLs after the whole migration sequence, and separately attempt each bypass, so the boundary is proven by behaviour rather than by migration text.

## Failure mapping

| Cause | SQLSTATE | HTTP |
|---|---|---|
| Not Owner/Admin, ineligible or self target, unknown member or room, missing/spent/lapsed/foreign preview, stale OIDC | `42501` | `403 FORBIDDEN`, uniform copy |
| Stale OIDC on ownership transfer | `42501` with the `fresh OIDC required` marker | `403 FRESH_AUTHENTICATION_REQUIRED` |
| Malformed batch, unknown role or state, no-op change, confirmation mismatch, bad page size, partial cursor, member over the 500-assignment bound | `22023` | `400 REQUEST_INVALID` |
| Stale expected revision, preview describing a changed target, successor assignments changed since the preview, invitation not pending | `40001` | `409 CONFLICT` |
| Schema rejection (closed bodies, unknown action, oversized page) | — | `400 REQUEST_INVALID`, before any SQL runs |

403 copy is uniform across every cause above so a denial cannot be used to discover which members, rooms, or previews exist. Audit `detail` names roles, states, and revisions only; the successor's address is in the dry run the Owner read, never in the spine (§20.3).

Both routes declare the shared closed error envelope for `400`, `401`, `403`, `409`, and `500`, so those replies are validated by Fastify (§7) and the privacy-sensitive uniform shape cannot drift unnoticed.

## Audit events

`invitation.created`, `invitation.revoked`, `invitation.expired`, `invitation.accepted`, `member.created`, `member.role`, `member.state`, `room.assignment`, `ownership.transferred`. Each is named in `SECURITY_EVENT_TYPES`; an authz test reads the installed function bodies and fails if SQL emits a type the catalogue does not list.
