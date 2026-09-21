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

Owner/Admin, enforced by `create_room`. The room starts in `draft`. A title is 1–200 code
points of NFC text on one line, not blank once Unicode spaces are folded — so a title of
non-breaking or ideographic spaces is refused, while an internal one is kept. A description
is up to 4000 characters of NFC plain text. Both rules live in `create_room` (`valid_room_title`
and `valid_structure_text`) and a violation is `400`.

## `GET /api/rooms?roomId=<id>`

```
200 {rooms: [room] | []}
```

One register row, in the same shape as a page of `GET /api/rooms`. An unreachable room
and an unknown id both answer `{rooms: []}`. `roomId` cannot be combined with a cursor.

## Purge and room state

A room whose purge is `scheduled`, `marker_pending` or `purging` cannot leave `archived`:
returning it to draft answers `409` until the Owner cancels the purge. A cancelled purge no
longer holds its room, so the room can be scheduled again. The purge confirmation is the
constant `SCHEDULE ROOM PURGE`; the room is bound by id and expected revision.

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
change grants (publish) or ends (archive a published room).

`expectedRevision` binds the apply to the room as the review saw it: any grant, invitation or
counterparty change in between answers `409`. It does not bind `viewerCount` exactly, and it
cannot — a grant reaching its `expires_at`, and a trash removal revoking the grants beneath
it, both reduce reach without advancing `room.revision`. Both only REMOVE reach, so the
reviewed count is an upper bound on what a publication can expose: a Manager is never shown
fewer viewers than the change goes on to affect.

A change to the current state is `409`; so is returning a room to draft while its purge is
live. Publishing requires the structure to have been published at least once (`409`
otherwise).

`change_room_state` is not executable by the web credential; this route is the only path
to a room state change.


