# Self-hosting

Duefold serves one organization per installation. The reference deployment needs a Linux host with Docker Compose, HTTPS through a reverse proxy, a private S3-compatible bucket, generic OIDC for members, and either SMTP or Resend. Compose supplies PostgreSQL and ClamAV.

[Host requirements](host-requirements.md) states these requirements without reference to Compose, for evaluating a different host. For managed hosting, see [Railway + Cloudflare R2 + Resend](railway-deployment.md), which documents the isolation trade-off that platform requires.

## Start

1. Clone the repository and copy `.env.example` to `.env`.
2. Fill every required value. Generate each cryptographic key independently:

   ```sh
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
   ```

3. On Ubuntu hosts, persist the user-namespace setting in [Processing sandbox host requirements](#processing-sandbox-host-requirements).
4. Keep `DUEFOLD_BIND=127.0.0.1` and serve HTTPS from a reverse proxy on the host. With Caddy:

   ```caddy
   duefold.example.com {
   	reverse_proxy 127.0.0.1:8080
   }
   ```

5. Start the installation:

   ```sh
   docker compose up -d
   ```

6. Trust the proxy. Requests reach Duefold from the Compose network's gateway, not `127.0.0.1`. Set `DUEFOLD_TRUSTED_PROXIES` to that address—never `true` or a hop count—and apply it:

   ```sh
   docker network inspect duefold_default --format '{{(index .IPAM.Config 0).Gateway}}'
   docker compose up -d
   ```

7. Open `DUEFOLD_PUBLIC_URL`. The first verified address in `DUEFOLD_OWNER_EMAIL_ALLOWLIST` becomes Owner.

The complete configuration contract is documented in [`.env.example`](../.env.example). Use separate credentials for the four database roles and separate web/worker object-storage access.

## Operate

Run operator commands through the migration service:

```sh
docker compose run --rm migrate <command>
```

| Command                                               | What it does                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `db migrate`                                          | Applies pending database migrations. `docker compose up` runs it too.                              |
| `support-bundle`                                      | Prints redacted diagnostics: migration state, job queue, and recovery status.                      |
| `preflight sandbox`                                   | Reports the seven sandbox isolation features. Run it in `web` or `worker`, never `migrate`.         |
| `recover-owner <email>`                               | After a confirmation prompt, makes that invited member the Owner and disables every current Owner. |
| `backup-status`                                       | Shows the recorded backup and restore-drill status.                                                |
| `backup-status acknowledge <retention> <expectation>` | Records the backup retention and recovery expectation you verified with your provider.             |
| `restore drill`                                       | Checks a restored database and records the result.                                                 |
| `updates check-file <manifest>`                       | Verifies a release manifest against the running release and records the answer for Status. See [Upgrade](#upgrade). |

Duefold does not create backups. Enable provider-native database backups and object versioning, and prove restoration in an isolated environment before using real data. Database migrations move forward; rollback across a migration requires a tested database restore and matching object-store version.

## Upgrade

Each release publishes a signed `release-manifest.json`. Verify it with the release public key inside the image you already run, so a tampered release cannot vouch for itself:

```sh
docker compose run --rm \
  -v "$PWD/release-manifest.json:/tmp/release-manifest.json:ro" \
  -e DUEFOLD_UPDATE_PUBLIC_KEY_PATH=/srv/duefold/apps/cli/release-signing-public.pem \
  migrate updates check-file /tmp/release-manifest.json
```

The command exits non-zero if the signature, payload, or public key does not verify, or if the manifest offers a newer release that carries a security advisory. It records its answer for the **Status** section, where it reads as stale after thirty days: run it whenever a release is published. After it succeeds, confirm a current tested backup, set `DUEFOLD_IMAGE_TAG` to the new version, then run:

```sh
docker compose pull
docker compose run --rm migrate db migrate
docker compose up -d
```

The upgrade is complete when `curl -fsS https://duefold.example.com/api/health/ready` returns `{"status":"ready"}` and a newly uploaded test document previews.

## Processing sandbox host requirements

Duefold nests a credential-free Bubblewrap sandbox inside the web and worker containers. On Ubuntu hosts where AppArmor restricts unprivileged user namespaces, enable them persistently before starting Duefold:

```sh
printf 'kernel.apparmor_restrict_unprivileged_userns=0\n' | sudo tee /etc/sysctl.d/90-duefold-userns.conf
sudo sysctl --system
```

Confirm the result from inside the running service, which reports the real boundary rather than the presence of a package:

```sh
docker compose exec worker node apps/cli/src/main.ts preflight sandbox
```

Every feature must read `present`. The command exits non-zero when any is absent, so a deployment check can gate on it.

This host setting permits creation of user namespaces; it does not grant application credentials or network access to processing children. Compose drops every capability and adds back `SYS_ADMIN` only so Bubblewrap can construct its inner mount namespace. Docker's outer AppArmor profile is disabled for web and worker because it blocks that construction, while `no-new-privileges`, the versioned deny-by-default seccomp profile, read-only filesystems, bounded tmpfs mounts, and Bubblewrap's inner namespace remain enforced. Do not replace the supplied seccomp profile with `seccomp=unconfined`.
