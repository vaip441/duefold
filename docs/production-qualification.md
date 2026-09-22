# Production qualification runbook

Status: **UNEXECUTED TEMPLATE**. A command existing is not passing evidence. Run every applicable step against the exact proposed release SHA with synthetic data, record UTC dates, owner, reviewer, commands, immutable image digests, and evidence paths.

## Evidence header

- Source SHA: ________________________________
- Web image digest: __________________________
- Worker image digest: _______________________
- Domain: ___________________________________
- Qualification owner/reviewer: ______________
- Started/completed UTC: _____________________
- Evidence directory: ________________________

Never store credentials, full emails, filenames, object keys, protected IDs, or document content in the evidence directory.

## 1. Source, composition, and supply chain

```bash
npm ci
npm run verify
npm run test:integration
npm run test:authz
npm run build
npm audit --omit=dev --audit-level=high
```

Record the final CI URL for the same SHA, full/minimal composition reports, image SBOMs, vulnerability/secret/license scans, release-manifest signature, Cosign verification, and proof that omitted branding source is absent from the minimal runtime image.

## 2. Fresh Compose lifecycle

On clean qualified amd64 and arm64 hosts, follow `README.md` and `docs/self-hosting.md` without undocumented steps:

1. Fresh install and migration.
2. Production preflight and readiness.
3. Synthetic owner bootstrap, room creation, upload, scan, review and publication.
4. Upgrade from the previous supported release; verify migrations and manifest compatibility.
5. Exercise rollback procedure. If migrations crossed a boundary, restore the pre-upgrade backup rather than reversing migrations.
6. Rotate database, storage, OIDC, mail, OTP, network-HMAC, and PII-HMAC credentials according to their documented procedures.
7. Complete teardown and verify volumes/objects expected to remain or be removed.

Capture commands, timings, status output, deviations, and resolutions.

## 3. Provider conformance

Using synthetic identities and documents, record:

- Cloudflare R2: TLS, private bucket, blocked public access, least-privilege web/worker credentials, checksum behavior, multipart cleanup, lifecycle rules, no public/internal URL disclosure, capacity alert ownership. Explicitly record that R2 object versioning is unavailable rather than claiming it.
- Selected OIDC: discovery/TLS, Authorization Code + PKCE, state/nonce, verified email, invitation, first-owner allowlist, `max_age`, `auth_time` or `iat` freshness behavior, logout/session revocation.
- Selected SMTP/Resend: invitation, OTP, onboarding, outage behavior, neutral response timing, and prohibited-detail inspection using synthetic mail.
- ClamAV: reachable only on its private boundary, current signature age, EICAR-safe test response, outage/staleness fail closed.
- Sandbox: namespaces, seccomp, cgroups, no-new-privileges, read-only mounts, bounded tmpfs, network denial, credential denial, timeout/output/memory limits. Degraded mode cannot pass this gate.

## 4. Reference performance

Allocate web 2 vCPU/2 GiB and worker 4 vCPU/4 GiB. Start from an empty qualification database and private synthetic bucket.

```bash
node --env-file=.env deploy/seed-benchmark.ts \
  --documents 10000 --audit-events 1000000 --viewers 100 \
  --out /secure-evidence/viewer-tokens.json
k6 run \
  -e BASE_URL=https://qualification.example \
  -e VIEWER_TOKENS=/secure-evidence/viewer-tokens.json \
  deploy/k6/viewer-steady-state.js
```

The seed command writes real synthetic raster derivatives through the configured worker storage credential. Keep its token file access-controlled and delete it after the run.

Record p95 metadata (<500 ms), p95 protected page (<750 ms), fault rate (<1%, expected denial excluded), web/worker/database memory and CPU, query counts, streaming backpressure, and recovery after upload/export pressure. Record capacity exhaustion separately and verify visible bounded failure with no partial publication.

For a preflight smoke only—not release evidence—use `SCENARIO_VUS=1 SCENARIO_DURATION=15s` with one seeded viewer.

## 5. Failure injection

Record safe behavior and recovery for:

- PostgreSQL container kill/restart during reads and a transaction;
- real storage timeout/reset and capacity exhaustion;
- scanner outage and stale signatures;
- renderer/converter crash, timeout and OOM;
- worker death while holding a lease;
- duplicate job and duplicate mutation;
- partial multipart upload/finalization;
- selected mail-provider outage;
- web/worker restart during export and cleanup.

For each: expected result, injection command, observed user/status/audit result, retry bound, data-integrity query, recovery command, and reviewer decision.

## 6. Backup and restore

Record provider-native PostgreSQL backup/PITR settings, object lifecycle/versioning capability, retention, alert ownership, selected restore point, and measured restore time. Restore into an isolated environment that cannot send real mail or contact production integrations.

Run restore validation for schema/migration checksums, image/manifest versions, object existence plus SHA-256 samples, authorization isolation, preview, allowed/denied ranges, mail sink, and current deletion markers. Prove restored deleted rooms cannot regain external access before reconciliation. Do not state a universal RPO/RTO; record the tested point and time.

## 7. Final-domain smoke

With synthetic canary content verify TLS, CSP/security headers, host-only Secure cookies, storage privacy, OIDC, viewer OTP, watermarked preview, inaccessible-content non-disclosure, denied download sends no bytes/URL, revocation on subsequent preview/range, audit entries, status/backup state, alerts, support-bundle redaction, and browser flows in Chromium/Firefox/WebKit desktop and mobile.

## 8. Human gates and sign-off

- Complete `docs/security/independent-review-checklist.md`; zero unresolved critical/high findings.
- Complete `docs/accessibility-manual-review.md` with real assistive technology.
- Reconcile every row in `docs/release-evidence.md` to a dated evidence path.
- Set `DUEFOLD_RELEASE_QUALIFIED_SHA` only after owner and reviewer approve this exact SHA.
- Change package/workspace versions to the intended release, tag the exact main SHA, let the guarded release workflow publish, then verify signatures and deploy synthetic canary data first.

Real documents and external viewers remain prohibited until all steps pass.
