# Participants access map

Owns external participants, viewer invitations, allow-only grants, expiry and revocation, effective-permission impact previews, and room settings and visibility — the last because publishing or archiving a room is reviewed by counting the viewers whose access it grants or ends.

## Start here

- [Module declaration](src/declaration.ts) — routes and migrations.
- [Grant model](src/grant-model.ts) — grant vocabulary and shapes.
- [Grant operations](src/grant-operations.ts) — server-facing capability operations.
- [Room settings](src/room-settings.ts) — settings reader, capabilities, room visibility, policies, and counterparties.
- [Routes](src/routes/) — participant listing/invitation, grant changes, room settings, visibility, policies, and counterparties; see the [room administration HTTP contract](../../docs/room-administration-http-contract.md).
- [Database functions](migrations/) — authoritative grant and invitation transitions.
- [Browser API](../../apps/web-client/src/api/participants.ts) and [room settings API](../../apps/web-client/src/api/room-settings.ts)
- [Browser state](../../apps/web-client/src/workspace/useParticipantsSection.ts) and [room settings state](../../apps/web-client/src/workspace/useRoomSettings.ts)
- [Access section](../../apps/web-client/src/workspace/views/AccessSection.tsx) composing [participant panel](../../apps/web-client/src/components/ParticipantsPanel.tsx) and [counterparty controls](../../apps/web-client/src/components/CounterpartyControls.tsx); [room settings panel](../../apps/web-client/src/components/RoomSettingsPanel.tsx)
- Authorization suites: [participant grants](../../test/authz/participant-grants.test.ts), [room settings](../../test/authz/room-settings.test.ts), [download policy](../../test/authz/room-download-policy.test.ts), [default grant expiry](../../test/authz/room-default-expiry.test.ts), and [counterparties](../../test/authz/room-counterparties.test.ts), sharing [seeding](../../test/authz/support/policy-fixture.ts)
- [Room administration journeys](../../test/browser/room-administration.spec.ts), seeded by [room seeding](../../test/support/room-seeding.ts)

## Does not own

Member roles and ownership transfer belong to [core-security](../core-security/README.md). Viewer discovery and protected byte delivery belong to [rooms-documents](../rooms-documents/README.md), which also owns room creation, structure, retention and purge; this module changes a room's visibility but not its content.
