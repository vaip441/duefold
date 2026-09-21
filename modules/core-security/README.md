# Core security map

Owns installation identity, member authentication and sessions, organization membership, administrative capabilities, ownership transfer, transactional audit, security configuration, and recovery evidence.

## Start here

- [Module declaration](src/declaration.ts) — composed routes, migrations, jobs, and configuration.
- [Authorization identities](src/authorization.ts) and [sessions](src/sessions.ts) — authenticated member/viewer boundaries.
- [Authentication](src/auth/) — OIDC, OTP, and required mail behavior.
- [Database layer](src/db/) — schema migration and database connection behavior.
- [Audit](src/audit.ts) — application-facing audit types and helpers; migrations remain authoritative for transactional audit.

## Organization administration

- [Stable administration exports](src/administration.ts)
- [Wire and database types](src/administration-types.ts)
- [Member reads](src/member-reads.ts)
- [Member mutations](src/member-mutations.ts)
- [Member list route](src/routes/member-list.ts)
- [Member action route](src/routes/member-actions.ts)
- [Administration database functions](migrations/017_organization_administration.sql)
- [Browser administration entry](../../apps/web-client/src/api/administration.ts)
- [Authorization suites](../../test/authz/)

PostgreSQL functions are authoritative for role/state transitions, room-assignment batches, ownership-transfer freshness, session revocation, and append-only audit. Routes must not reproduce those decisions.

## Does not own

Room/document lifecycle belongs to [rooms-documents](../rooms-documents/README.md). Viewer invitations and grants belong to [participants-access](../participants-access/README.md). Optional visual branding belongs to [branding-notifications](../branding-notifications/README.md).
