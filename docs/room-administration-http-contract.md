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

