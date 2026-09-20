# Host requirements

What a host must provide to run Duefold, stated without reference to any
particular vendor. Use it to evaluate a platform before committing to it, and to
understand why the [self-hosting guide](self-hosting.md) uses Docker Compose.

Duefold is a standard OCI workload: two Node.js services, a PostgreSQL 16+
database, one private ClamAV service, S3-compatible object storage, generic
OIDC, and SMTP or Resend. Nothing in it is tied to a provider. The one demanding
requirement is the processing sandbox, and it is demanding for a reason: it is
the boundary that keeps a malicious document away from your credentials.

## Check a host before trusting it

Run the probe on the candidate host. It carries no credentials, connects to no
database, and stores nothing:

```sh
docker build -f deploy/preflight-probe.Dockerfile -t duefold-probe .
```

Deploy that image on the host the same way you would deploy the real worker, then
read the report. Prefer the host's exec or SSH facility over the container log —
some platforms do not capture an entrypoint's stdout, and a silent log looks like
a crash:

```sh
sh deploy/preflight-probe.sh --report-only
```

Inside an existing installation, the same report comes from the service itself:

```sh
docker compose exec worker node apps/cli/src/main.ts preflight sandbox
```

`supported=true` means the host can run Duefold. `supported=false` names the
missing features and exits non-zero, so a deployment pipeline can gate on it.
Run it in the web or worker service, never a helper container: the reference
`migrate` service has no sandbox grants and would report failure on a perfectly
good host.

## 1. Kernel isolation for the processing sandbox

Duefold never parses an untrusted document inside the credential-bearing web or
worker process. Each conversion and each watermark composition runs in a
[Bubblewrap](https://github.com/containers/bubblewrap) child with an empty root,
no network, no credentials, and dropped capabilities. The worker refuses to start
unless it can observe all seven properties below, and it observes them by
launching a real child and inspecting it, not by checking that a package is
installed.

| Feature             | What the host must allow                                                         |
| ------------------- | -------------------------------------------------------------------------------- |
| `namespaces`        | Unprivileged user, PID, network, IPC, UTS, and cgroup namespace creation          |
| `no-new-privileges` | `setpriv --no-new-privs` before `exec`                                            |
| `read-only-mounts`  | `pivot_root` and read-only bind mounts inside the new namespace                   |
| `denied-egress`     | A network namespace with no interface                                             |
| `seccomp`           | An active seccomp filter (`Seccomp: 2`) that still permits the syscalls above     |
| `cgroups`           | cgroup v2 with finite `memory.max`, `cpu.max`, and `pids.max`                     |
| `bounded-tmpfs`     | A memory-backed `tmpfs` with an explicit `size=` at `/tmp` and the scratch root   |

In container terms this means the workload needs `CAP_SYS_ADMIN`, a seccomp
profile that permits `unshare`, `pivot_root`, `mount`, and `clone` when that
capability is present, sized `tmpfs` mounts, and enforced CPU and memory limits.
`deploy/seccomp-bubblewrap.json` is exactly Moby's default profile plus
`pivot_root`; it is not a relaxation of seccomp.

Two consequences are worth stating plainly:

- A platform that forbids added capabilities, custom seccomp profiles, or `tmpfs`
  declarations cannot run Duefold's sandbox. That is most managed
  application-hosting platforms. It is not a packaging problem that a different
  Dockerfile would solve.
- A persistent disk volume mounted at the scratch path is not a substitute for a
  bounded `tmpfs`. It is neither memory-backed nor size-declared in
  `mountinfo`, and untrusted intermediate bytes would survive on disk.

On Ubuntu hosts, AppArmor restricts unprivileged user namespaces by default;
persist the setting shown in the
[self-hosting guide](self-hosting.md#processing-sandbox-host-requirements).

## 2. PostgreSQL

One PostgreSQL 16 or newer server, reachable over a protected transport, with
**four separate
login roles**: migration, runtime, authenticator, and worker. The split is a
security boundary, not a convention — see the reasoning in
`deploy/postgres-roles.sql`. The web process compares `current_user` across its
two pools at startup and refuses to boot if the runtime and authenticator roles
turn out to be the same role.

A managed database therefore has to let you create additional roles and transfer
database ownership to the migration role. A provider that gives you exactly one
credential and no `CREATE ROLE` cannot host Duefold's schema as designed.

Duefold creates no backups. The host must provide point-in-time or scheduled
backups, and you must prove a restore in an isolated environment before real
documents arrive. Migrations move forward only; going back across one requires a
tested restore plus the matching object-store version.

## 3. Object storage

One private S3-compatible bucket, TLS-protected and encrypted by the provider,
with **two credentials of different scope**: the web key writes quarantined
uploads and reads delivery objects; the worker key reads quarantine and writes
derivatives. Object versioning should be enabled. Public access must be off —
Duefold never hands a storage URL to a client when download is denied.

Required knobs: endpoint, region, bucket, path-style addressing on or off, and
whether the provider supports checksum headers
(`DUEFOLD_STORAGE_CHECKSUM_SUPPORT`). Qualified against Cloudflare R2; AWS S3,
Backblaze B2, MinIO, and other S3-compatible stores work through the same
contract, with no provider-specific code.

## 4. Networking and TLS

- HTTPS at `DUEFOLD_PUBLIC_URL`, terminated before Duefold. The web service
  listens on plain HTTP port 8080.
- Set `DUEFOLD_TRUSTED_PROXIES` to the **actual** address or CIDR of the
  terminating proxy. `true` and hop counts are rejected at startup: a hop count
  cannot prove the immediate peer is your proxy, and OTP rate limiting depends
  on a client address that a caller cannot forge.
- Keep the origin unreachable except through that proxy. If the platform routes
  public traffic straight to the container and appends to a client-supplied
  `X-Forwarded-For`, the client address is spoofable and per-IP throttling
  degrades.
- The worker needs egress to storage, mail, and ClamAV signature updates. The
  sandbox children need none and get none.

## 5. Identity and mail

- Generic OIDC (Authorization Code Flow with PKCE) for team members, with
  `<DUEFOLD_PUBLIC_URL>/api/auth/oidc/callback` registered as the redirect URI.
  Conformance-tested against Google, Microsoft Entra, Authentik, and Keycloak.
- Exactly one of SMTP or Resend for invited-reader one-time codes. Deliverability
  matters more than throughput here: a code that lands in spam is a locked-out
  investor.

## 6. Compute and lifecycle

- Reference sizing: web at 2 vCPU / 2 GiB, worker at 4 vCPU / 4 GiB. Limits must
  be real cgroup limits, since the sandbox preflight requires finite values.
- Both images support `linux/amd64` and `linux/arm64`.
- `linux/amd64` and `linux/arm64` release images are published per tag; run
  `updates check-file` against the signed release manifest before upgrading.
- The web service exposes `/api/health/live` and `/api/health/ready`. Use
  `ready` for deployment gating: it also verifies migrations, storage, and the
  scanner.
- Migrations run as a separate one-shot command before the services start, using
  the migration role. That role must not be the runtime credential.
- Both services handle `SIGTERM`; the worker finishes or releases its job lease.

## Qualified targets

Docker Compose is the qualified target for 1.0, because it is the only one where
every requirement above is verifiable with a file in this repository. Other OCI
hosts are supported to the extent that the probe reports `supported=true` on
them; that is a factual test, not a marketing claim.

For a host that denies namespace creation, `DUEFOLD_SANDBOX_ISOLATION=degraded`
trades filesystem and network isolation for the ability to run there at all. It
confines credentials by running each converter as a separate unprivileged UID
(so it cannot read the service process's `/proc/<pid>/environ`), sweeps every
process owned by that UID when the job ends, and keeps no-new-privileges and the
parent's resource bounds. It requires a separate typed acknowledgement so it
cannot be enabled by accident, and it requires the ability to change UID, so the
service must run with `CAP_SETUID`. It is not equivalent to the namespaced
boundary and does not satisfy the release gate.

Provider-specific notes:

- [Railway + R2 + Resend](railway-deployment.md) — managed deployment guide. Uses
  degraded isolation, because Railway denies namespace creation; read its
  trade-off section before choosing it.
- [Railway platform measurement](railway.md) — what was tested and why the
  sandbox cannot run there.
