# Duefold on Railway + Cloudflare R2 + Resend

**Experimental, synthetic-data-only deployment. This target is not release-qualified.**
Railway cannot provide Duefold's filesystem and network processing sandbox, so do
not use this path for real investor documents or external viewers. Managed setup:
no server to patch and no HTTPS to configure. Roughly 30 minutes.

**Read this first.** Railway's container runtime denies namespace creation, so the
document processing sandbox cannot run there. This guide uses
`DUEFOLD_SANDBOX_ISOLATION=degraded`, which parses untrusted documents without
filesystem or network isolation. [What you are accepting](#what-you-are-accepting)
states precisely what is and is not preserved. For the fully isolated deployment,
use [self-hosting](self-hosting.md) on a Linux VPS.

## What you need

- A Railway account (Hobby is enough to start; the worker wants 4 GB for LibreOffice).
- A Cloudflare account with R2 enabled.
- A Resend account with a verified sending domain.
- An OIDC provider for your team's sign-in — Google Workspace, Microsoft Entra,
  Authentik, or Keycloak.

## 1. Cloudflare R2

Create the bucket and two scoped tokens. Duefold uses two credentials of
different scope on purpose: the web service writes uploads and reads delivery
objects, the worker reads quarantine and writes derivatives. One shared token
would remove that separation.

1. In the Cloudflare dashboard, **R2** → **Create bucket**. Name it `duefold`.
   Pick a location near your users. Leave public access **off** — Duefold serves
   every byte through its own authorization checks and must never hand out a
   storage URL.

2. **R2** → **API** → **Manage API tokens** → **Create API token**, twice:

   | Token name       | Permission           | Scope             |
   | ---------------- | -------------------- | ----------------- |
   | `duefold-web`    | Object Read and Write | The `duefold` bucket |
   | `duefold-worker` | Object Read and Write | The `duefold` bucket |

   Record each token's **Access Key ID** and **Secret Access Key** — the secret is
   shown once. Also note your **account ID** from the R2 overview page.

   R2's token permissions are not fine-grained enough to make the web token
   write-only, so the split here is by identity rather than by capability: two
   independently revocable credentials, which is what you get on R2. AWS S3 with
   two IAM policies gives the stricter version through the same adapter, with no
   code change.

3. Your endpoint is `https://<account-id>.r2.cloudflarestorage.com`.

4. Optional but recommended: **Settings** → **Object lifecycle rules** → add a
   rule aborting incomplete multipart uploads after 1 day, so abandoned uploads
   do not accumulate.

**R2 has no object versioning.** An object that is overwritten or deleted cannot
be restored from a previous version, unlike AWS S3 or Backblaze B2. Duefold never
overwrites an accepted original (originals and derivatives are immutable and
SHA-256 verified), so the realistic exposure is an operator or a compromised
credential deleting objects. The audit log records document deletions, but it
cannot bring bytes back. If that risk matters more than R2's zero egress fees,
use S3 or B2 — the adapter is identical, only the endpoint and credentials change.

## 2. Resend

1. Add and verify your sending domain (**Domains** → **Add Domain**, then the DNS
   records it lists). Sign-in codes arrive as email, so deliverability is
   functional, not cosmetic: a code in a spam folder is a locked-out investor.
2. **API Keys** → **Create API Key**, with **Sending access** only. Copy it.
3. Decide your from-address, e.g. `Duefold <no-reply@yourdomain.com>`.

## 3. OIDC provider

Register Duefold as an application. You need the issuer URL, a client ID, and a
client secret. The redirect URI is:

```
https://<your-duefold-domain>/api/auth/oidc/callback
```

You will not know the domain until step 5, so either register a placeholder and
correct it, or come back to this step.

Duefold defaults `DUEFOLD_OIDC_CLIENT_AUTH_METHOD` to `auto`. It reads the
provider's discovery metadata, prefers `client_secret_post` when advertised,
uses `client_secret_basic` when that is the only advertised method, and follows
the OIDC-standard Basic default when the metadata field is omitted. An
incompatible provider fails startup instead of failing after a user signs in.
If the provider restricts this specific client registration to one of multiple
advertised methods, set `DUEFOLD_OIDC_CLIENT_AUTH_METHOD` explicitly to
`client_secret_post` or `client_secret_basic`. Duefold never retries a consumed
authorization code with another method.

High-consequence actions (ownership transfer, broad grants, export, purge) require
a sign-in less than 15 minutes old. Duefold always requests `max_age` and prefers
the provider's `auth_time` claim. Google never issues `auth_time`: it is absent
from Google's discovery `claims_supported` and is not returned even when `max_age`
is requested, so on Google the instant is inferred from the ID token's `iat`. That
tracks the real sign-in within seconds, but it cannot distinguish a credential
re-entry from a silent SSO re-issue. If you need a provider-asserted
re-authentication guarantee, use Entra, Authentik, or Keycloak, which do issue
`auth_time`.

## 4. Railway project and database

```sh
railway login
railway init --name duefold
```

Add PostgreSQL from the dashboard (**+ New** → **Database** → **PostgreSQL**).
Duefold supports PostgreSQL 16 or newer, matching the core deployment contract;
the role bootstrap refuses an older server before creating application roles.

Duefold uses four database roles, which is a security boundary rather than a
convention: the authenticator role owns sessions and one-time codes but cannot
read document content, and the web process refuses to start if the runtime and
authenticator credentials resolve to the same role.

Open a tunnel to the database, which works without exposing a public proxy:

```sh
railway connect postgres --tunnel-only
```

That prints a local host and port and holds the tunnel open. In a second
terminal, generate four independent passwords (`openssl rand -base64 24` each)
and run the role script through the tunnel:

```sh
PGPASSWORD=<postgres-superuser-password> psql \
  --host 127.0.0.1 --port <tunnel-port> --username postgres --dbname duefold \
  -v migration_password="$MIGRATION_PW" \
  -v runtime_password="$RUNTIME_PW" \
  -v authenticator_password="$AUTH_PW" \
  -v worker_password="$WORKER_PW" \
  -f deploy/postgres-roles.sql
```

The script needs `psql` locally and the database must be named `duefold`; if the
template created `railway` instead, create the `duefold` database first
(`CREATE DATABASE duefold;`) so the script's `ALTER DATABASE duefold OWNER`
succeeds. Close the tunnel with Ctrl+C when it finishes.

Use the database service's **private** host (normally
`postgres.railway.internal`, but copy `RAILWAY_PRIVATE_DOMAIN` rather than
assuming the service name) from its Variables tab. Railway encrypts private
service traffic with WireGuard; the PostgreSQL URL itself therefore uses the
ordinary `postgresql://` scheme without claiming database-level TLS.

## 5. ClamAV

Every upload is scanned before it can be published, and Duefold rejects signatures
older than 24 hours, so this service is required.

Build it from this repository rather than pulling `clamav/clamav-debian` directly:
**+ New** → **GitHub Repo** → your Duefold fork, name it `clamav`, and set
**Settings** → **Build** → Dockerfile path to `deploy/clamav.Dockerfile`. It needs
no variables and no public domain, but it does need egress for signature updates
and about 2 GB of memory. Note its private domain, `clamav.railway.internal`.

The upstream image starts freshclam before clamd, so its first update cannot
notify the daemon and clamd keeps serving the signatures baked into the image
until the next scheduled cycle — observed on a real deployment as clamd reporting
signature 28123 while its own database directory held 28129. Duefold then refuses
to publish anything, correctly. `deploy/clamav.Dockerfile` starts clamd first and
runs one notified update before the daemon, so the scanner is current as soon as
it is reachable.

## 6. Web and worker services

Create two services from your repository, `web` and `worker`. In each service's
**Settings** → **Build**, set the Dockerfile path:

| Service  | Dockerfile                             |
| -------- | -------------------------------------- |
| `web`    | `deploy/railway-web.Dockerfile`        |
| `worker` | `deploy/railway-worker.Dockerfile`     |

These are the Railway variants. They install the same converters and the same
ImageMagick policy as the standard images, and differ only in that they expect
the degraded launch mode.

Generate three independent keys, one per variable — reusing one is rejected at
startup:

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
```

### Shared variables

Set these on **both** services:

```
DUEFOLD_PUBLIC_URL=https://<your-duefold-domain>
DUEFOLD_SANDBOX_ISOLATION=degraded
DUEFOLD_SANDBOX_DEGRADED_ACKNOWLEDGEMENT=I_ACCEPT_UNISOLATED_DOCUMENT_PARSING_ON_THIS_HOST
DUEFOLD_AUTH_MAIL_FROM=Duefold <no-reply@yourdomain.com>
DUEFOLD_RESEND_API_KEY=re_...
DUEFOLD_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
DUEFOLD_STORAGE_REGION=auto
DUEFOLD_STORAGE_BUCKET=duefold
DUEFOLD_STORAGE_PATH_STYLE=false
DUEFOLD_STORAGE_CHECKSUM_SUPPORT=true
DUEFOLD_OTP_DIGEST_KEY=<key 1>
DUEFOLD_CLAMAV_HOST=clamav.railway.internal
DUEFOLD_CLAMAV_PORT=3310
```

`DUEFOLD_STORAGE_CHECKSUM_SUPPORT=true` is correct for R2: it supports SHA-256
composite checksums on multipart uploads, which is how Duefold verifies that
stored bytes match what was uploaded.

The mail adapter is chosen at build time in `composition.manifest.json`. Set
`"mail": "resend"` there before deploying, otherwise the SMTP adapter is compiled
in and will reject the Resend key.

### Web service only

```
DUEFOLD_DATABASE_URL=postgresql://duefold_runtime:<runtime-pw>@postgres.railway.internal:5432/duefold
DUEFOLD_AUTH_DATABASE_URL=postgresql://duefold_authenticator:<auth-pw>@postgres.railway.internal:5432/duefold
DUEFOLD_ORGANIZATION_NAME=Your Company
DUEFOLD_OWNER_EMAIL_ALLOWLIST=you@yourdomain.com
DUEFOLD_OIDC_ISSUER=https://accounts.google.com
DUEFOLD_OIDC_CLIENT_ID=<client id>
DUEFOLD_OIDC_CLIENT_SECRET=<client secret>
DUEFOLD_NETWORK_HMAC_KEY=<key 2>
DUEFOLD_STORAGE_WEB_ACCESS_KEY_ID=<duefold-web token key id>
DUEFOLD_STORAGE_WEB_SECRET_ACCESS_KEY=<duefold-web token secret>
DUEFOLD_WATERMARK_IMAGE_PROGRAM=/usr/bin/magick-im7.q16
PORT=8080
DUEFOLD_PORT=8080
```

Set both `PORT` and `DUEFOLD_PORT`. Railway uses `PORT` for its health check and
edge routing; `DUEFOLD_PORT` is what the server binds.

Leave `DUEFOLD_TRUSTED_PROXIES` unset. Railway appends the client IP to any
`X-Forwarded-For` a caller supplies and publishes no stable proxy CIDR, so there
is no value that would be safe to trust. The consequence is that per-IP rate
limiting on sign-in codes keys on Railway's edge address rather than the reader's,
making it coarser. Duefold rejects `true` and hop counts precisely to stop this
from becoming a silent spoofing hole.

### Worker service only

```
DUEFOLD_WORKER_DATABASE_URL=postgresql://duefold_worker:<worker-pw>@postgres.railway.internal:5432/duefold
DUEFOLD_PII_HMAC_KEY=<key 3>
DUEFOLD_STORAGE_WORKER_ACCESS_KEY_ID=<duefold-worker token key id>
DUEFOLD_STORAGE_WORKER_SECRET_ACCESS_KEY=<duefold-worker token secret>
DUEFOLD_SANDBOX_MODE=production
DUEFOLD_PROCESSOR_PDF_PROGRAM=/usr/bin/mutool
DUEFOLD_PROCESSOR_OFFICE_PROGRAM=/usr/lib/libreoffice/program/soffice.bin
DUEFOLD_PROCESSOR_IMAGE_PROGRAM=/usr/bin/magick-im7.q16
DUEFOLD_PROCESSOR_TEXT_PROGRAM=/usr/bin/magick-im7.q16
```

### Resources and health check

On the web service: **Settings** → **Networking** → **Generate Domain** (or add
your own), and set the health check path to `/api/health/ready`. That endpoint
verifies migrations, storage, and the scanner, not just that the process is up.

Give the worker at least 4 GB of memory; LibreOffice conversion of a large
spreadsheet will exceed less. The web service is comfortable at 2 GB.

Keep both services at **one replica**. Converter identities are reserved per
process but the cleanup sweep selects processes by UID, so two replicas sharing a
kernel namespace would terminate each other's in-flight conversions. Railway
replicas are separate containers, which is safe; scaling within a single container
is not.

## 7. Deploy and migrate

Deploy both services first, because migrations run inside a deployed container:

```sh
railway up --service web
railway up --service worker
```

Then run migrations through `railway ssh`, which executes **inside** the service
and can therefore resolve `postgres.railway.internal`. `railway run` would run on
your own machine, where that host does not exist:

```sh
railway ssh --service worker -- \
  env DUEFOLD_MIGRATION_DATABASE_URL="postgresql://duefold_migration:<migration-pw>@postgres.railway.internal:5432/duefold" \
  node apps/cli/src/main.ts db migrate
```

The web service fails its health check until migrations have applied, so expect
the first deployment to go healthy only after this step. Redeploy it if Railway
already marked it failed.

## 8. Verify

```sh
curl -fsS https://<your-domain>/api/health/ready
```

Expect `{"status":"ready"}`. Then confirm the degraded mode is active and
acknowledged, rather than silently something else:

```sh
railway logs --service worker | grep sandbox.degraded
```

You should see one `SANDBOX_ISOLATION_DEGRADED` warning per start. Both services
emit it; its absence when you expected degraded mode means the variables did not
apply.

Finally, the path that exercises everything: open your domain, sign in with the
allowlisted address (the first verified allowlisted identity becomes Owner),
create a room, upload a PDF and a spreadsheet, wait for processing, publish, then
invite a reader at an address you control and confirm the code arrives and the
document renders with a watermark.

Upload the EICAR test file too. It must be quarantined as malware, not published —
that is how you know scanning is really in the path.

## What you are accepting

Duefold normally parses every untrusted document inside a Bubblewrap namespace:
an empty filesystem root, no network, no credentials, per-job. Railway's runtime
denies namespace creation, so on Railway that boundary does not exist and a
weaker one is rebuilt from UNIX privilege separation instead.

What still holds:

- **credentials stay out of reach.** Converters run as a throwaway UID
  (`duefold-conv0`..`7`), not as the service user. This matters more than
  scrubbing the child's environment, which is not sufficient on its own:
  `/proc/<pid>/environ` is an exec-time snapshot readable by the owning UID, so a
  converter sharing the service's UID could read the service's environment
  directly and recover the database URL, both R2 secrets, the OIDC secret, and
  every HMAC key. A different UID cannot: the kernel denies `environ`, `maps`, and
  the `fd` table across UIDs. There is a regression test for exactly this.

  What a converter UID *can* still read from the service process is
  `/proc/<pid>/cmdline`, `status`, and `mountinfo`. None of the three carries a
  secret here, because both services are launched as plain
  `node apps/<service>/src/main.ts` with all configuration supplied through the
  environment. Keep it that way: passing a credential as a command-line argument
  would make it world-readable to every converter.
- **descendants cannot outlive their job.** Every process owned by the
  per-invocation UID is killed when the job ends. A process group would not be
  enough, because `setsid` escapes it; an unprivileged `--no-new-privs` process
  cannot change its own UID, so it cannot escape the sweep.
- **no new privileges**, enforced before exec, so the converter cannot regain the
  UID it was dropped from.
- **bounded resources**: parent-enforced timeout, output ceiling, and
  scratch-size monitor, plus a cap of eight concurrent converters.
- **ImageMagick's script-bearing SVG/MSVG and URL/HTTPS coders stay disabled**,
  which matters more here than under a namespace, because it is now the main
  barrier against a crafted file reading local paths or making requests.

What is genuinely lost, and cannot be rebuilt without a namespace:

- **filesystem isolation.** The converter sees the container's real root and can
  read anything world-readable, including Duefold's own application code. It
  cannot read the service process's environment or files private to the service
  UID.
- **network isolation.** The proxy variables only redirect well-behaved HTTP
  clients; deliberate malicious code can open a socket, including to Railway's
  private network.

The concrete risk: a malicious document that exploits LibreOffice, MuPDF, or
ImageMagick gets code execution as an unprivileged throwaway UID with network
access. It cannot read your deployment's secrets, and it is killed when the job
ends. That is a genuine reduction from the namespaced boundary — a namespace
would also deny the filesystem and the network — but it is not a credential
disclosure path.

This is why the isolation setting requires a second typed acknowledgement rather
than a single flag. It is a material risk acceptance for synthetic evaluation,
not a qualified production configuration. Do not use it for real documents or
external viewers. The risk increases further when uploaders are not fully
trusted, because network access alone creates a meaningful exploitation and
exfiltration path.

Both Railway images therefore run as root, unlike the standard images, because
dropping to the service user would remove `CAP_SETUID` and make the UID
separation above impossible. The converters themselves never run as root.

If you later move to a host that permits namespaces, delete
`DUEFOLD_SANDBOX_ISOLATION` and `DUEFOLD_SANDBOX_DEGRADED_ACKNOWLEDGEMENT` and
switch to the standard Dockerfiles. No data migration is involved.

## Operating it

Backups are Railway's. Enable them on the PostgreSQL service and prove a restore
into a scratch database. Keep this deployment synthetic-only: R2 has no
versioning, object loss is permanent, and degraded processing does not satisfy
the release gate.

Operator commands run inside a deployed service, not on your machine:

```sh
railway ssh --service worker -- node apps/cli/src/main.ts support-bundle
railway ssh --service worker -- node apps/cli/src/main.ts preflight sandbox
```

`preflight sandbox` will report `supported=false` here, which is expected and
correct: it describes the namespaced boundary, which this deployment does not
have.

Migrations only move forward. Rolling back across one requires a tested database
restore plus the matching object-store state.
