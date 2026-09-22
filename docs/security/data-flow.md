# Duefold data flow and trust boundaries

**Scope:** secure core and optional branding

```text
Internet browser
  │ HTTPS; Secure host-only cookies; CSRF on mutations
  ▼
TLS edge / reverse proxy
  │ trusted only by explicit peer IP/CIDR; plain HTTP may exist inside a protected host network
  ▼
Web service ───────────────► OIDC provider (member code flow + PKCE)
  │                         Mail provider (required invitation/OTP delivery)
  │ runtime DB role
  ├────────► PostgreSQL ◄──────── authenticator DB role (sessions/OTP/OIDC only)
  │                ▲
  │                │ worker DB role / migration role (separate credentials)
  │                │
  │ upload intent  │ durable lease-fenced jobs
  ▼                │
Private S3-compatible storage ◄──────── Worker service ───────► private ClamAV
  ▲        │                              │
  │        │ quarantine bytes             │ stdin/stdout only
  │        └──────────────────────────────►│ Bubblewrap parser child
  │                                       │ empty root; no network/credentials;
  └── immutable derivatives/originals ────┘ no-new-privileges; bounded resources
```

## Flows

### Member authentication

1. Browser starts OIDC; web stores a short-lived transaction through the authenticator role.
2. Callback verifies issuer, signature, audience, expiry, state, nonce, PKCE, and verified email.
3. The first Owner must exactly match the configured allowlist; later users require invitations.
4. A new opaque server-side session replaces prior authentication state and is returned only as a Secure, HttpOnly, host-only cookie. CSRF material is separate.

### Viewer OTP

1. Browser submits an email; the response and queued-work shape are neutral to eligibility.
2. PostgreSQL enforces email/network/installation limits and stores only a keyed code digest.
3. Worker delivers required mail without receiving content-storage authority beyond its own role.
4. Successful verification rotates into a new viewer session; attempts, expiry, invitation, viewer, and room membership are rechecked.

### Upload and processing

1. Authorized member creates an intent containing destination, expected source facts, and bounded multipart plan.
2. Web allocates an opaque quarantine key and returns only short-lived URLs for fixed part numbers.
3. Finalization reauthorizes and validates upload ID/key/parts/checksums/actual size; a durable validation job is committed.
4. Worker reads quarantine bytes, streams them to private ClamAV, validates byte-detected type/resource bounds, and invokes the parser outside the service process.
5. Successful derivatives and SHA-256 evidence remain private and ready for explicit review/publication. Any scanner/storage/parser uncertainty fails closed.

### Publication and viewing

1. Contributors alter working state; a Manager reviews impact and publishes atomically.
2. Viewer discovery uses session-bound server functions that return only authorized published projections.
3. Each page/text request rechecks room/publication/grant/expiry/session state.
4. Web fetches a private derivative and invokes the credential-free watermark compositor; the viewer receives no storage URL.
5. Download creation and every range request independently reauthorize. A denied policy returns neither source bytes nor a URL.

### Audit, export, and deletion

- Security/business mutations append audit in the same transaction.
- Preview/download summaries are bounded evidence, not comprehension analytics.
- Exports are private, single-use, authenticated, one-hour objects and are then deleted.
- Whole-room purge writes a provider-versioned deletion marker before deleting live content; restore remains externally disabled until markers are reconciled.

## Deployment variants

**Qualified Compose:** web/worker run in read-only containers with bounded tmpfs/cgroups; Bubblewrap creates user/PID/network/mount namespaces and an empty root. PostgreSQL and ClamAV remain private.

**Railway degraded mode:** no parser namespace, filesystem confinement, or network denial. A distinct throwaway UID, capability removal, environment allowlist, resource bounds, and UID process sweep protect service credentials but do not make the platform equivalent. This path is experimental, synthetic-only, and cannot satisfy the release gate.

## Prohibited flows

- originals or provider URLs directly to a denied viewer;
- draft metadata or inaccessible identifiers to viewer responses, logs, metrics, or support bundles;
- storage/database/mail/OIDC credentials into parser environment, argv, scratch, or mounted root;
- public bucket access or durable public presigned URLs;
- browser token/document persistence in localStorage, sessionStorage, IndexedDB, service workers, or persistent caches;
- production restore contacting real mail/external integrations before explicit enablement.
