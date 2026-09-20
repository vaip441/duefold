# Railway

**Status: not a qualified target. The sandbox cannot run here — measured, not assumed.**

This page is the platform measurement. For the actual deployment guide, which
accepts the trade-off documented below, see
[Railway + R2 + Resend](railway-deployment.md).

Duefold is a plain OCI workload and nothing in it is written for a specific
vendor, but Railway's container boundary does not expose what the processing
sandbox needs. That was tested on Railway rather than inferred from
documentation.

## Measured result

Probe deployed 2026-09-20, `us-west2`, Railway runtime V2, kernel
`6.18.15+deb13-cloud-amd64`, image built from `deploy/preflight-probe.Dockerfile`:

```
namespaces=absent
seccomp=present
cgroups=present
no-new-privileges=absent
read-only-mounts=absent
bounded-tmpfs=absent
denied-egress=absent
supported=false
```

Bubblewrap's own message and the cause:

```
bwrap: Creating new namespace failed: Permission denied
```

The container runs as uid 0 with `CapEff: 00000000800405fb` — `CAP_SYS_CHROOT` is
present, **`CAP_SYS_ADMIN` is not**. `unshare` is denied for every namespace type
(`--user` with `EACCES`, `--mount`, `--pid`, `--net`, `--ipc`, `--uts`,
`--cgroup` with `EPERM`), even though the kernel's own sysctls would permit them
(`max_user_namespaces=2014631`, `unprivileged_userns_clone=1`). The denial is
Railway's capability set and seccomp filter, not the host kernel.

`cgroups=present` is the one requirement Railway does satisfy: limits are real
and finite (`memory.max=8000000000`, `cpu.max=800000 100000`,
`pids.max=1000`). `bounded-tmpfs` is absent because no `tmpfs` exists at `/tmp`
or the scratch root, as expected.

**This is the structural outcome, not the narrow one.** Four of the seven features
depend on creating a namespace, so no Dockerfile or configuration change restores
the namespaced boundary here. Running on Railway therefore requires
`DUEFOLD_SANDBOX_ISOLATION=degraded`, which confines credentials by running
converters as a separate unprivileged UID but gives up filesystem and network
isolation — see
[the deployment guide's trade-off section](railway-deployment.md#what-you-are-accepting).
Reversing this needs Railway to grant `CAP_SYS_ADMIN` or equivalent namespace
permission to deployed services; their privileged-mode request remains open.

Re-run the probe if Railway changes its runtime. The result above expires
whenever they do.

## What blocks it

Every untrusted document byte in Duefold is parsed inside a Bubblewrap child with
an empty root and no network or credentials. The worker verifies that boundary
exists at startup and refuses to run without it; the web service starts but fails
every protected document view, because watermark composition uses the same
sandbox. The seven properties it requires are listed in
[Host requirements](host-requirements.md#1-kernel-isolation-for-the-processing-sandbox).

Compose grants them with `cap_add: SYS_ADMIN`, a seccomp profile, and sized
`tmpfs` mounts. Railway offers no equivalent:

| Requirement                        | Railway                                                      |
| ---------------------------------- | ------------------------------------------------------------ |
| Namespace creation (`unshare`)     | Denied for every namespace type (measured)                    |
| Added capability (`CAP_SYS_ADMIN`) | Not granted; privileged mode is an open feature request       |
| Custom seccomp profile             | Not configurable                                             |
| Sized `tmpfs` mounts               | Not configurable; volumes are persistent disk, not `tmpfs`   |
| Nested containers                  | Not supported                                                |
| Real cgroup limits                 | Available and finite (measured)                              |

Railway has given the same answer to comparable workloads — Judge0's cgroup
sandbox and Chromium's namespace sandbox both failed there for this reason.

## Repeat the spike

Fifteen minutes, one throwaway service, no credentials involved. The probe image
reads no configuration, connects to nothing, and stores nothing. Repeat it after
any Railway runtime change; the recorded result is a measurement with an expiry,
not a permanent property.

1. Create an empty Railway project and add a service from this repository.

2. Point the service at the probe Dockerfile. In the service's variables:

   ```
   RAILWAY_DOCKERFILE_PATH=deploy/preflight-probe.Dockerfile
   ```

3. Give the service real limits, since `cgroups` requires finite values: 2 vCPU
   and 2 GiB is enough. Do not attach a volume and do not add a domain.

4. Deploy it:

   ```sh
   railway up --service probe --ci
   ```

5. Read the report over SSH rather than from the deployment log. Railway did not
   capture this probe's entrypoint stdout in the observed run, and a silent log
   is easy to misread as a crash:

   ```sh
   railway ssh --service probe -- sh -c 'cd /srv/duefold && node apps/cli/src/main.ts preflight sandbox'
   railway ssh --service probe -- sh -c 'cd /srv/duefold && sh deploy/preflight-probe.sh --report-only'
   ```

   The first is the decision. The second explains it: Bubblewrap's own message,
   the cgroup limit files, the mounts at `/tmp` and the scratch root, the
   effective capability mask, and per-namespace `unshare` results.

6. Delete the project and record the full output. It is the input to a decision,
   and it expires whenever Railway changes its runtime.

   ```sh
   railway delete --project <id> --yes
   ```

### Reading the result

| Report                                      | What it means                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `supported=true`                            | Railway can run Duefold as built. Qualify it properly: upload, scan, convert, watermark, deny, and audit on a real deploy.  |
| Only `bounded-tmpfs=absent`                 | Narrow gap. `invokeSandboxed` already meters scratch in userspace, so a portable bound is a reviewable `DESIGN_SPEC.md` amendment, not a quiet patch. |
| `namespaces=absent` with a permission error | Structural, and what was observed. No packaging change fixes it; only the platform granting namespace permission does.      |
| `cgroups=absent`                            | Usually a missing service limit rather than a platform property. Set explicit limits and re-run before concluding.          |

## What already works on Railway

Everything except the sandbox. PostgreSQL 16+ (with your own four roles), ClamAV
on the private network, Resend or SMTP, and any generic OIDC provider all work
unchanged. Railway Buckets are S3-compatible but issue a single credential set,
where Duefold expects two of different scope, so the deployment guide uses
Cloudflare R2 instead.

The [experimental deployment guide](railway-deployment.md) covers each of these
for synthetic evaluation only, including the two things easiest to get wrong:
setting both `PORT` and `DUEFOLD_PORT`, and leaving `DUEFOLD_TRUSTED_PROXIES`
unset because Railway's edge appends to caller-supplied `X-Forwarded-For` and
publishes no stable proxy CIDR.
The guide uses Railway's WireGuard-encrypted private database network rather
than the public TCP proxy.

## If Railway ever grants namespace permission

The probe is the check. If it reports `supported=true`, switch to the standard
`deploy/web.Dockerfile` and `deploy/worker.Dockerfile` and delete the two
degraded-isolation variables; no data migration is involved. Documenting Railway
as a qualified target would additionally need an amendment to `DESIGN_SPEC.md`
section 6.3 and a full release-gate run against a Railway deployment, including
the malware, conversion-failure, denial, and audit paths.
