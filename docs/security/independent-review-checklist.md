# Independent security review pack

Status: **PENDING INDEPENDENT REVIEW**  
Release commit: ________________________________  
Reviewer: ______________________________________  
Reviewer independence/conflicts: ______________  
Started (UTC): __________  Completed (UTC): __________

The reviewer must not be the author of the implementation being approved. Store supporting output under a dated, access-controlled evidence directory and link it below. Do not put credentials, emails, filenames, object keys, protected identifiers, or document content in evidence.

## Required inputs

- Exact source SHA and proposed release manifest.
- `docs/security/threat-model.md`, `docs/security/data-flow.md`, `docs/security/asvs-map.md`, and `docs/security/incident-response.md`.
- Composition manifests and generated route, migration, job, configuration, and browser registries.
- Automated unit, integration, authorization, browser, composition, dependency, image, secret, and license results for the same SHA.
- Fresh Compose, provider-conformance, failure-injection, performance, and restore evidence.

## Review checklist

Record PASS, FAIL, or N/A with rationale and an evidence link.

| Area | Required review | Result | Evidence/findings |
| --- | --- | --- | --- |
| Trust boundaries | Data flow matches implementation; Duefold is isolated from unrelated infrastructure |  |  |
| Authentication | OIDC validation/freshness, viewer OTP neutrality/abuse controls, session rotation/revocation |  |  |
| Authorization | Deny-by-default coverage for metadata, previews, text, ranges, exports, and mutations |  |  |
| Publication | Draft structure, metadata, versions, and room state cannot leak |  |  |
| Storage | Private configuration, least-privilege credentials, opaque keys, no client storage URLs |  |  |
| Uploads | Multipart finalization, size/type/path limits, quarantine, and abandonment |  |  |
| Processing | Scanner freshness, fail-closed behavior, sandbox network/credential isolation, resource bounds |  |  |
| Spreadsheet policy | XLSX/ODS remain disabled unless the structural adapter has separate acceptance |  |  |
| Protected delivery | Watermark attribution, cache authorization, revocation, and no DRM claims |  |  |
| Downloads | Denial sends no bytes/URL; every range reauthorizes; summary audit is correct |  |  |
| CSRF/CSP | Cookie mutations require CSRF; headers and CSP prohibit unsafe executable content |  |  |
| Audit | Security mutations and audit commit together; runtime cannot mutate retained audit |  |  |
| Privacy | Telemetry/support bundle redaction; network correlation and PII lifecycle conform |  |  |
| Retention/deletion | Trash, purge delay, pseudonymization, and deletion-marker restore reconciliation |  |  |
| Exports | Fresh auth, preflight disclosure, one-time delivery, expiry and deletion |  |  |
| Composition | Omitted branding is absent from source graph, routes, migrations, chunks, image, and SBOM |  |  |
| Operations | Readiness, failure injection, backup/restore, rollback, update and incident procedures |  |  |
| Supply chain | Exact pins, scans, SBOM, provenance, checksums, image signatures, source revision |  |  |

## Finding log

| ID | Severity | Description | Affected boundary | Resolution | Retest evidence | Status |
| --- | --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |  |

Release requires zero unresolved critical/high findings and no known exploitable production dependency or image vulnerability.

## Reviewer decision

- [ ] APPROVE: reviewed commit satisfies the security gate.
- [ ] REJECT: unresolved findings prevent release.

Decision rationale: ____________________________________________________________

Reviewer signature/name: ____________________  Date (UTC): ____________________

Maintainer acknowledgement: _________________  Date (UTC): ____________________
