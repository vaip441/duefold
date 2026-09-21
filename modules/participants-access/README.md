# Participants access map

Owns external participants, viewer invitations, allow-only grants, expiry and revocation, and effective-permission impact previews.

## Start here

- [Module declaration](src/declaration.ts) — routes and migrations.
- [Grant model](src/grant-model.ts) — grant vocabulary and shapes.
- [Grant operations](src/grant-operations.ts) — server-facing capability operations.
- [Routes](src/routes/) — participant listing/invitation and grant changes.
- [Database functions](migrations/) — authoritative grant and invitation transitions.
- [Browser API](../../apps/web-client/src/api/participants.ts)
- [Browser state](../../apps/web-client/src/workspace/useParticipantsSection.ts)
- [Participant panel](../../apps/web-client/src/components/ParticipantsPanel.tsx)
- [Authorization suite](../../test/authz/participant-grants.test.ts)

## Does not own

Member roles and ownership transfer belong to [core-security](../core-security/README.md). Document download policy, viewer discovery, and protected byte delivery belong to [rooms-documents](../rooms-documents/README.md).
