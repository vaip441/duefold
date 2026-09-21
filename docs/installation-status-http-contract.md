# Installation status HTTP contract

Every route is declared `audience: 'member'`, carries no role branch in its handler, and
declares the shared error envelope. Owner/Admin authority is decided by
`assert_organization_administrator` inside the `SECURITY DEFINER` readers in
`024_deployment_status.sql` (`core-security`), `025_content_status.sql` (`rooms-documents`)
and `026_installation_settings.sql` (`participants-access`); a plain Member and a Room
Manager both receive the uniform `403`.

Instants are RFC 3339 UTC. Every response is closed. No response carries configuration:
observations hold codes matching `^[A-Z][A-Z0-9_]{0,63}$`, never an issuer, endpoint, bucket,
host, credential or address.

## `GET /api/status`

```
200 {
  application: {version, modules, adapters: {storage, mail, identity}},
  oidc:        {discoveryConformedAt},
  migrations:  {state: current|pending|unrecognized, appliedCount, expectedCount, latestApplied},
  queue:       {due, running, failedRecently, oldestDueSeconds},
  mail:        {lastDeliveredAt, failedRecently},
  checks:      [{check, observation: {result, code, evidenceAt, evidenceVersion, observedAt, stale} | null}]
}
```

`application` is what this process was built from. `oidc.discoveryConformedAt` is when this
process's OIDC discovery and client-authentication negotiation passed; it does not start
unless both do. `migrations.state` is `pending` only when
the ledger is a strict prefix of the registry. `queue.due` counts pending jobs whose time has
come; `oldestDueSeconds` is the age of the oldest, on the database clock. Failures and mail
evidence look back seven days; mail is core-security's required mail.

`checks` always has four entries in this order: `storage-privacy`, `storage-versioning`,
`scanner` (recorded hourly by the worker, stale after three hours) and `updates` (recorded by
`updates check-file`, stale after thirty days). `observation` is null for a check that has
never run. `evidenceAt` is set only for `scanner` (signature build time); `evidenceVersion`
only for `updates` (the offered release). An offered release that is now running is answered
as `UPDATE_CURRENT`.

## `GET /api/status/content`

```
200 {
  processing: {failedCount},
  recovery:   {backupStatus, backupRetention, recoveryExpectation, acknowledgedAt,
               restoreDrillStatus, restoreDrillAt}
}
```

`failedCount` counts versions in `processing_failed`. `recovery` is `operational_recovery_status`
as `backup-status acknowledge` and `restore drill` leave it.

## `GET /api/installation`

```
200 {settings: {downloadPolicy: allow|deny, revision, inheritingRoomCount}}
```

`inheritingRoomCount` counts rooms without their own download policy.

## `POST /api/installation/download-policy`

```
{action: 'dry-run', policy}                                                →  200 {impact}
{action: 'apply', policy: 'allow', expectedRevision, confirmation}         →  200 {revision}
{action: 'apply', policy: 'deny',  expectedRevision}                       →  200 {revision}

impact = {currentPolicy, proposedPolicy, inheritingRoomCount, affectedDocumentCount,
          requiresFreshAuthentication, expectedRevision, confirmation: string | null}
```

`affectedDocumentCount` counts published documents in published rooms where neither the room
nor the document sets its own policy: what viewers can open today whose download changes.
Allowing needs the phrase `ALLOW ORIGINAL DOWNLOADS` and a sign-in within fifteen minutes
(`403 FRESH_AUTHENTICATION_REQUIRED` otherwise); denying needs neither, and a deny carrying a
phrase is `400`. Reviewing or applying the value already held is `409`, as is a stale
`expectedRevision`. The change writes one `download.policy` audit row with reason
`INSTALLATION_DOWNLOAD_POLICY_CHANGED`.

