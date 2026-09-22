# OWASP ASVS 5.0 traceability map

**Profile:** Duefold 1.0 secure document-room core · **Status:** implementation mapping; independent verification pending

This is a control-family traceability map, not an ASVS certification. Evidence references are repository paths and repeatable suites; deployment-dependent rows remain open until dated release evidence exists.

| ASVS area | Duefold control | Primary implementation/evidence | Status |
| --- | --- | --- | --- |
| V1 Encoding and sanitization | TypeBox/AJV request/response schemas; plain-text metadata; sanitized preview text; fixed image-tool vectors; safe HTTPS interstitial | `apps/web/src/app.ts`, `modules/rooms-documents/src/safe-links.ts`, processing tests | Automated pass |
| V2 Validation and business logic | Server-side fixed bounds, optimistic revisions/locks, allow-only grants, explicit publication, typed confirmations | resource/source validation, SQL migrations, integration/authz suites | Automated pass |
| V3 Web frontend | No protected client persistence/service worker; CSP; safe external links; accessible auth and viewer flows | browser storage/CSP/link tests | Automated pass; manual review open |
| V4 API and web service | Explicit generated routes and schemas; audience enforcement; bounded bodies/queries; no permissive CORS | generated registry, app hooks, authz HTTP tests | Automated pass |
| V5 File handling | Private quarantine; byte type detection; scanner freshness; structural workbook rewrite; sandbox; immutable derivatives | processing/private-content tests, image smoke | Local pass; final image/provider evidence open |
| V6 Authentication | OIDC code+PKCE/state/nonce; exact issuer/audience/expiry; verified email; 8-digit viewer OTP with neutral responses and DB limits | `modules/core-security/src/auth`, security kernel/authz tests | Automated pass; provider conformance open |
| V7 Session management | Opaque random server-side sessions; Secure/HttpOnly/host-only/SameSite; rotation, idle/absolute bounds, family revocation | sessions implementation and browser/authz tests | Automated pass |
| V8 Authorization | Deny by default; per-request server authorization; role matrices; grant union/expiry; uniform document download policy | viewer authorization/readers, participant-grants and route suites | Automated pass |
| V9 Self-contained tokens | No bearer/JWT application sessions; OIDC tokens validated only during callback and not used as app authorization tokens | OIDC and session modules | Automated pass |
| V10 OAuth/OIDC | Exact discovery/issuer and redirect, state/nonce/PKCE, client secret isolation, fresh-auth gates | OIDC tests and callback route | Automated pass; real providers open |
| V11 Cryptography | CSPRNG opaque IDs/secrets; HMAC/keyed OTP/network/PII digests; SHA-256 object evidence; independent keys | shared IDs, config key-strength checks, auth tests | Automated pass |
| V12 Secure communication | HTTPS public origin; explicit trusted proxy peers; private/protected service transport; no CORS | proxy tests and deployment docs | Local pass; final-domain check open |
| V13 Configuration | Unknown keys fail; exact Node/dependency pins; build-time composition; no runtime plugins; secrets via environment/secret stores | config/composition tests, Docker/Compose files | Automated pass; final artifact evidence open |
| V14 Data protection | Private storage; least-privilege DB/storage credentials; no protected telemetry; retention/pseudonymization/deletion markers | role matrix, redaction and retention tests | Automated pass; provider restore open |
| V15 Secure coding/architecture | Strict TypeScript; explicit module boundaries; fail-closed errors; no dynamic route/module discovery | typecheck/lint/composition suites | Automated pass |
| V16 Security logging and errors | Correlation IDs and stable reason codes; safe client failures; transactional audit; no PII/secret telemetry | logger/failure/audit/support-bundle tests | Automated pass |
| V17 WebRTC | No WebRTC capability or dependency in secure core | dependency/source review | Not applicable |

## Required release evidence

Before marking this map independently verified:

- attach CI results for unit, integration, authorization, privileged isolation, image/Compose smoke, and Chromium/Firefox/WebKit;
- record dependency, secret, license, SBOM, and amd64/arm64 image scans;
- run OIDC, R2/S3, mail, ClamAV, private-storage, and final-domain header conformance;
- run the failure-injection, performance, backup/restore, upgrade/rollback, and deletion-marker procedures;
- obtain a reviewer other than the author and link each finding/disposition.

Any control marked “Automated pass” means the repository suite passed, not that a deployment or organization is ASVS-certified.
