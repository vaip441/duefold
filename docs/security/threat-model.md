# Duefold threat model

**Version:** 1.0 · **Status:** maintainer review complete; independent review pending

This model covers secure core, the optional branding module, the qualified Docker Compose deployment, and the explicitly non-qualified Railway degraded-isolation path. It uses synthetic examples only.

## Assets and security objectives

Protected assets are document originals and derivatives, draft/published metadata, viewer/member identities, grants, sessions, OTP challenges, audit events, exports, storage/database/mail/OIDC credentials, and recovery state.

Objectives, in priority order:

1. No content or metadata reaches an unauthenticated or unauthorized principal.
2. Draft state never reaches viewers; publication is explicit and atomic.
3. Denied original downloads expose neither bytes nor storage URLs.
4. Untrusted document parsers cannot reach credentials, service state, or the network in a qualified deployment.
5. Authentication/session evidence is isolated from content-serving database authority.
6. Security mutations and append-only audit evidence commit together.
7. Telemetry and support output contain no protected data.
8. Resource use remains bounded under malicious input and concurrency.

## Trust boundaries and actors

Actors: Owner/Admin/Member, Room Manager/Contributor, individually authenticated Viewer, deployment operator, storage/mail/OIDC providers, and an unauthenticated internet attacker. A database/storage/platform administrator is trusted for availability and provider-level integrity; audit is append-only under application roles, not tamper-proof against administrators.

Primary boundaries:

- public browser ↔ TLS edge/reverse proxy ↔ web service;
- web runtime role ↔ isolated authenticator role ↔ PostgreSQL;
- browser ↔ short-lived, intent-bound S3 multipart part URLs;
- private quarantine storage ↔ worker ↔ ClamAV;
- credential-bearing web/worker parent ↔ credential-free Bubblewrap parser child;
- web/worker ↔ private S3-compatible storage, OIDC, and mail providers;
- local guarded CLI ↔ migration role/recovery operations.

## Principal threats and controls

| Threat | Required control and evidence |
| --- | --- |
| IDOR/BOLA and identifier guessing | Opaque IDs plus server authorization on every room, metadata, preview, text, range, export, and mutation request; authorization matrix includes denied/nonexistent cases. |
| Draft/publication leakage | Separate working and published snapshots, explicit Manager publication, transactional switch, viewer readers limited to published state. |
| Original-byte bypass | Uniform effective policy, server-side range lease checks on every request, no storage URL returned, runtime role cannot read protected source rows directly. |
| Session theft/fixation/forgery | Opaque rotated server-side sessions; Secure/HttpOnly/host-only/SameSite cookies; authenticator DB role isolated from content functions; immediate revocation checks. |
| CSRF/CORS abuse | Double-submit CSRF on cookie-authenticated mutations; no permissive CORS; safe methods do not mutate session state. |
| OTP enumeration/brute force | Neutral eligible/ineligible responses and work shape; keyed code digests; expiry/attempt/cooldown limits; PostgreSQL email/network/installation limits. |
| OIDC substitution/replay | Authorization Code + PKCE; exact issuer, signature, audience, expiry, state, nonce, and verified-email checks; first-owner exact allowlist. |
| Malicious upload/parser exploit | Byte-based type detection, fixed size/container/image bounds, private quarantine, fresh ClamAV, structural workbook rewrite, Bubblewrap namespaces, empty filesystem root, denied network, no credentials, no-new-privileges, cgroups/tmpfs/output/time limits. |
| Sandbox silently weakens | Namespaced mode is default; production preflight tests effective features; no automatic fallback. Degraded mode requires a separate verbatim acknowledgement and distinct UID, and cannot satisfy release qualification. |
| Degraded-mode credential theft | Parent/child UID separation prevents `/proc/<pid>/environ`, maps, and fd access; child environment allowlist; no secrets in command line; explicit capability removal; repeated UID process sweep. Filesystem/network isolation remains absent and is accepted only for synthetic evaluation. |
| Multipart confusion/race | Intent expiry, opaque fixed object key/upload ID/part plan, authorization recheck, size/checksum verification, and quarantine transition; abandoned upload reaper. |
| Malware/scanner bypass | Scanner outage, stale signatures, malformed response, and timeout fail closed; malware cannot advance or be downloaded. |
| Spreadsheet active content/exfiltration | Macro/legacy/encrypted/ambiguous formats rejected; external relationships/DDE/formulas stripped before converter; affected formats disabled by signed release policy until qualified. |
| Storage exposure | Private bucket, blocked public access, TLS/protected transport, opaque keys, separate web/worker credentials, application-authorized delivery. |
| Audit deletion or split-brain | Audit insert shares the mutation transaction; runtime roles cannot update/delete/truncate; failure rolls back mutation. No tamper-proof claim. |
| Log/support leakage | Structured allowlisted fields and redaction tests; no bodies, email, names, IDs, tokens, keys, URLs, or raw IPs. |
| SSRF/open redirect/active preview content | No native sources served inline; raster previews and sanitized positional text; HTTPS-only normalized link interstitial; ImageMagick URL/SVG/@path coders denied. |
| Resource exhaustion | Body/query/pagination limits, 250 MiB source cap, parser/container bounds, bounded job retries/leases, converter concurrency pool, output/time/scratch limits, streaming downloads/exports. |
| Supply-chain substitution | Exact npm lock, digest-pinned base/provider images, immutable Debian snapshot, pinned GitHub actions, CI audits, pre-push and immutable-image scans, SBOM/provenance, signed image digests and release manifest. |
| Backup/restore resurrection | Provider-owned backups/versioning disclosed; tested restore required; private deletion markers block external enablement until reconciled. No universal RPO/RTO claim. |
| Secret leakage through status | Observations store a pattern-bound `code`, not prose, so no issuer URL, endpoint, bucket, host, credential or object key can be written; the response is asserted free of every configured value. |
| Forged status | Each check has one writer, granted only to the process that runs it; the web credential writes nothing. A green check says what was tested and when, and turns stale on its own. |
| Installation-wide download exposure | Allowing original downloads installation-wide needs a review naming the inheriting rooms and reachable documents, the typed phrase and a fresh sign-in; the web credential cannot set the default directly. |

## Abuse cases that must remain in tests

- viewer/member role swapping and forged opaque IDs;
- expired/revoked grants during preview and resumed range downloads;
- stale publication and metadata revisions;
- forged processing evidence, scanner outage/staleness, parser crash/OOM/timeout;
- path traversal, mixed-script filenames, polyglots, archive/container bombs, hostile PDFs/images/workbooks;
- CSRF mismatch, OIDC state/nonce/issuer mismatch, OTP concurrent resend and fifth failure;
- audit insert failure and forbidden direct role operations;
- converter reads of parent `/proc` and a `setsid` descendant surviving timeout;
- malicious watermark text containing `@/etc/passwd` and `%[exif:*]`;
- restored deletion markers and one-time export replay.

## Residual risk and non-claims

Watermarks do not prevent screenshots. Download revocation cannot recall transmitted bytes. Provider administrators can alter data outside application controls. R2 has no object versioning. Railway degraded mode exposes world-readable container files and the private network to a successful parser exploit; it is non-qualified and synthetic-only. Browser and automated checks do not replace independent security review or penetration testing for regulated deployments.

## Change-review rule

Any change to authentication, authorization, publication, storage, upload parsing, delivery, audit, retention, recovery, provider credentials, or deployment isolation must update this model or state why threats and boundaries are unchanged, add allowed and denied tests, and identify migration/rollback and operational evidence effects.
