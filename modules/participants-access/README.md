# Participants access map

Owns external participants, viewer invitations, allow-only grants, expiry and revocation, effective-permission impact previews, and room settings and visibility — the last because publishing or archiving a room is reviewed by counting the viewers whose access it grants or ends.

## Start here

- [Module declaration](src/declaration.ts) — routes and migrations.
- [Grant model](src/grant-model.ts) — grant vocabulary and shapes.
- [Grant operations](src/grant-operations.ts) — server-facing capability operations.
- [Room settings](src/room-settings.ts) — settings reader, capabilities, and room visibility.
- [Routes](src/routes/) — participant listing/invitation, grant changes, room settings, and visibility; see the [room administration HTTP contract](../../docs/room-administration-http-contract.md).
- [Database functions](migrations/) — authoritative grant and invitation transitions.
- [Browser API](../../apps/web-client/src/api/participants.ts)
- [Browser state](../../apps/web-client/src/workspace/useParticipantsSection.ts)
- [Participant panel](../../apps/web-client/src/components/ParticipantsPanel.tsx)
- [Authorization suites](../../test/authz/participant-grants.test.ts) and [room settings](../../test/authz/room-settings.test.ts)

## Does not own

Member roles and ownership transfer belong to [core-security](../core-security/README.md). Viewer discovery and protected byte delivery belong to [rooms-documents](../rooms-documents/README.md), which also owns room creation, structure, retention and purge; this module changes a room's visibility but not its content.
