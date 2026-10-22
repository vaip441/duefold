# Security incident response runbook

**Audience:** Duefold installation Owner/operator

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
5. Keep external mail/OIDC/viewers disabled until `restore enable-external` succeeds and an Owner explicitly approves. It refuses while a purge is unreconciled or a deletion marker in storage names a room the restored database still holds. It and `restore reconcile-marker <purge-id>` read storage, so run them where the worker storage credentials and network are, not in the `migrate` service:

   ```sh
   # Docker Compose
   docker compose run --rm --no-deps --entrypoint node \
     -e DUEFOLD_MIGRATION_DATABASE_URL="postgresql://duefold_migration:<migration-pw>@postgres:5432/duefold" \
     worker apps/cli/src/main.ts restore enable-external
   # Railway
   railway ssh --service worker -- \
     env DUEFOLD_MIGRATION_DATABASE_URL="postgresql://duefold_migration:<migration-pw>@postgres.railway.internal:5432/duefold" \
     node apps/cli/src/main.ts restore enable-external
   ```

   A refusal exits non-zero without naming its cause. Find it with `psql "postgresql://duefold_migration:<migration-pw>@<host>:5432/duefold"`, taking the room ids from the marker keys `system/deletion-markers/v1/<room-id>/<purge-id>.json` in the bucket:

   ```sql
   SELECT purge_id, room_id FROM unreconciled_deletion_markers();
   SELECT r.id, r.state, p.id AS purge_id, p.state AS purge_state, p.purge_after
     FROM room r LEFT JOIN room_purge p ON p.room_id = r.id AND p.state <> 'cancelled'
    WHERE r.id = ANY ('{<room-id>,<room-id>}');
   ```

   - A purge the first query lists whose room the second does not return has completed: run `restore reconcile-marker <purge-id>`, then `restore enable-external` again.
   - A room the second query returns was restored from before its purge finished. Purge it again: rewriting its marker and deleting objects that are already gone both succeed. The worker runs the purge, and it also delivers all mail queued in the snapshot, which can include mail to viewers of that room. Until `restore enable-external` succeeds, run the worker with `DUEFOLD_SMTP_URL` pointed at the mail sink validated in step 4, never with production SMTP or Resend credentials. A Resend build cannot send to a sink, so use an SMTP build for this step.
     - If `purge_state` is `scheduled`, `marker_pending` or `purging`, do not cancel it. The worker resumes the purge once `purge_after` has passed, so a `scheduled` purge first waits out the rest of its 30-day cancellation period.

       The worker resumes it only through the purge's `room.whole.purge` job, and only while that job has attempts left. Check that it does:

       ```sql
       SELECT count(*) AS live FROM job_queue
        WHERE job_type = 'room.whole.purge' AND payload->>'purgeId' = '<purge-id>'
          AND state IN ('pending', 'running') AND attempts < max_attempts;
       ```

       If `live` is 0, the job used up its attempts before the snapshot was taken and nothing resumes the purge: a failed job never runs again, and the purge can no longer be cancelled or scheduled again. Fix what made it fail first, usually the worker's storage credentials or its reach to storage, then queue a fresh job for the same purge. It runs once `purge_after` has passed and continues from the state the purge recorded. The statement queues nothing while a live job for the purge exists:

       ```sql
       INSERT INTO job_queue (id, job_type, idempotency_key, payload, available_at, max_attempts)
       SELECT fresh.id, 'room.whole.purge', 'whole-room-purge-rerun:' || fresh.id,
              jsonb_build_object('purgeId', p.id), p.purge_after, 10
         FROM room_purge p, (SELECT replace(gen_random_uuid()::text, '-', '') AS id) AS fresh
        WHERE p.id = '<purge-id>' AND p.state IN ('scheduled', 'marker_pending', 'purging')
          AND NOT EXISTS (SELECT 1 FROM job_queue j
                           WHERE j.job_type = 'room.whole.purge' AND j.payload->>'purgeId' = p.id
                             AND j.state IN ('pending', 'running') AND j.attempts < j.max_attempts);
       ```

     - If `purge_state` is empty, an Owner archives the room and schedules its purge again in Room settings. A new 30-day cancellation period starts, and the worker runs the purge once it ends. Scheduling needs the Owner's fresh OIDC sign-in, so allow that one sign-in while mail and viewers stay disabled.

     Duefold cannot purge before `purge_after`. Once the room is gone, run `restore reconcile-marker <purge-id>` for the purge, then `restore enable-external` again.

6. Deploy synthetic canary content first; verify health, headers, scanner freshness, sandbox preflight, watermark, denial, revocation, audit, backup status, and alerts.

## 5. Notification

Coordinate private vulnerability reports through the repository Security tab. Notify affected operators/users based on confirmed scope and applicable law; do not speculate or disclose other viewers. State honestly what Duefold evidence can show: delivery/display events are not proof of reading, append-only audit is not administrator-proof, and downloaded bytes cannot be recalled.

## 6. Post-incident

- Record root cause, control failures, timeline, impact bounds, credential rotations, recovery point/time, tests added, reviewer, and residual risk.
- Update threat model, ASVS map, runbooks, deployment guidance, release policy, and provider conformance evidence.
- Publish a security advisory and fixed signed release when disclosure is safe.
- Do not reopen real external access until every critical/high finding is closed or the Owner has documented why a non-exploitable exception is acceptable; release qualification itself permits no unresolved exploitable high/critical finding.
