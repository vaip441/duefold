# Security incident response runbook

**Updated:** 2026-09-20 · **Audience:** Duefold installation Owner/operator

Do not place document names, viewer emails, tokens, object keys, raw IPs, or file contents in tickets, chat, logs, or support bundles. Use opaque incident IDs and synthetic reproductions.

## 1. Triage

1. Record UTC discovery time, reporter channel, affected deployment/build/manifest versions, and a coarse event class.
2. Preserve provider audit/access logs under restricted access without exporting protected payloads.
3. Treat suspected authorization bypass, session/OTP/OIDC compromise, parser escape, credential disclosure, public storage, audit-write bypass, or original-byte policy bypass as **critical**.
4. Do not test against real viewer accounts or documents. Reproduce in an isolated restore/synthetic environment.

## 2. Immediate containment

- **Viewer/content exposure:** return affected rooms to draft or archive; revoke affected viewers/grants/sessions; disable external access at the edge if scope is uncertain.
- **OIDC/session compromise:** rotate OIDC client secret, revoke all session families, review Owner/Admin changes, and verify runtime/authenticator roles remain distinct.
- **OTP/mail compromise:** rotate OTP digest key only with a plan to invalidate outstanding challenges; rotate mail credentials; inspect abuse limits and delivery provider activity.
- **Storage credential/public bucket issue:** block public access first, revoke/rotate the affected web or worker credential independently, then verify object policy and access logs. Never publish a provider URL as evidence.
- **Database credential/role issue:** block application traffic, rotate only through a controlled maintenance window, verify role grants against authorization tests, and preserve a backup before repair.
- **Parser/sandbox escape or critical parser advisory:** stop workers and protected-page composition, disable affected formats through signed release policy, preserve the hostile sample in access-controlled quarantine, and rotate service credentials if credential isolation is not conclusively proven.
- **Railway degraded-mode exploit:** stop web/worker services and assume private-network reachability from the converter UID. Rotate database, storage, mail, OIDC, and HMAC credentials as applicable; do not restore real use on degraded isolation.
- **Audit integrity failure:** stop security/business mutations. Preserve database/provider logs and do not claim audit completeness until reconciled.

## 3. Evidence handling

- Work from snapshots/copies; hash files with SHA-256 and record custody/time/operator.
- Malware or hostile documents remain private, encrypted provider objects or offline restricted media and are never attached to public issues.
- Use `node apps/cli/src/main.ts support-bundle` only after reviewing output; it is designed to omit records, identifiers, and secrets.
- Keep investigation credentials separate from production credentials and revoke them afterward.

## 4. Eradication and recovery

1. Identify the vulnerable component, affected versions, entry path, reachable assets, and earliest/latest evidence.
2. Patch with allowed/denied regression tests. For parser issues, include hostile corpus, timeout/OOM, environment, network/filesystem, and descendant-cleanup tests as relevant.
3. Run full CI, dependency/image/secret/license scans, and independent review for critical incidents.
4. Restore only from a known recovery point. Validate migration checksums, manifest/image digests, object SHA-256 samples, private storage, authorization isolation, allowed/denied download, mail sink behavior, and deletion markers.
5. Keep external mail/OIDC/viewers disabled until `restore enable-external` succeeds and an Owner explicitly approves.
6. Deploy synthetic canary content first; verify health, headers, scanner freshness, sandbox preflight, watermark, denial, revocation, audit, backup status, and alerts.

## 5. Notification

Coordinate private vulnerability reports through the repository Security tab. Notify affected operators/users based on confirmed scope and applicable law; do not speculate or disclose other viewers. State honestly what Duefold evidence can show: delivery/display events are not proof of reading, append-only audit is not administrator-proof, and downloaded bytes cannot be recalled.

## 6. Post-incident

- Record root cause, control failures, timeline, impact bounds, credential rotations, recovery point/time, tests added, reviewer, and residual risk.
- Update threat model, ASVS map, runbooks, deployment guidance, release policy, and provider conformance evidence.
- Publish a security advisory and fixed signed release when disclosure is safe.
- Do not reopen real external access until every critical/high finding is closed or the Owner has documented why a non-exploitable exception is acceptable; release qualification itself permits no unresolved exploitable high/critical finding.
