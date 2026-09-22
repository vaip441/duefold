# Rooms and documents map

Owns the private content lifecycle: rooms and structure, uploads and quarantine, sandboxed processing, explicit publication, viewer discovery, protected delivery, uniform document download policy, exports, trash, retention, and deletion.

## Start here

- [Module declaration](src/declaration.ts) — composed routes, migrations, worker jobs, and configuration.
- [Content status](src/content-status.ts) and [status route](src/routes/content-status.ts) — failed processing and the recovery record for the installation status surface.
- [Workspace reads](src/workspace-reads.ts), [room operations](src/room-operations.ts), and [structure](src/structure.ts) — member room capabilities.
- [Uploads](src/uploads.ts), [source validation](src/source-validation.ts), and [processing](src/processing/) — quarantine through derived artifacts.
- [Release policy](src/release-policy.ts) — publication boundary.
- [Lifecycle](src/lifecycle.ts) and [jobs](src/jobs/) — trash, purge, retention, cleanup, and scheduled work.
- [Routes](src/routes/) — HTTP adapters.
- [Database functions](migrations/) — authoritative authorization, audit, and lifecycle transitions.
- [Browser room API](../../apps/web-client/src/api/rooms.ts) and [member operations API](../../apps/web-client/src/api/member-operations.ts)
- [Room view](../../apps/web-client/src/workspace/views/RoomView.tsx)

## Viewer and protected delivery

- [Viewer authorization](src/viewer-authorization.ts)
- [Viewer discovery](src/viewer-discovery.ts)
- [Protected delivery](src/protected-delivery.ts)
- [Download policy](src/downloads.ts)
- [Safe-link handling](src/safe-links.ts)
- [Viewer browser API](../../apps/web-client/src/api/viewer.ts)
- [Reading room](../../apps/web-client/src/routes/ViewerReadingRoom.tsx)
- [Browser-boundary authorization suite](../../test/authz/browser-boundary.test.ts)
- [Viewer browser journey](../../test/browser/viewer.spec.ts)

Original bytes and storage URLs must never cross this boundary when download is denied. Upload processing remains quarantined and credential-free until validation succeeds.

## Does not own

Member identity and sessions belong to [core-security](../core-security/README.md). Participant invitations and grants belong to [participants-access](../participants-access/README.md). Optional branding belongs to [branding-notifications](../branding-notifications/README.md).
