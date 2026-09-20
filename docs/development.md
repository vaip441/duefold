# Development

## Requirements

- Node.js 26.5.0 (`.nvmrc`)
- PostgreSQL 16 or newer (the reference Compose image and CI currently use 18)
- `bubblewrap` and `setpriv`. The tests run real sandboxes, which need unprivileged user namespaces. On Ubuntu 24.04 and later, allow them with `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`. Check with `node apps/cli/src/main.ts preflight sandbox`; `cgroups` and `bounded-tmpfs` read `absent` outside a container, which is expected locally.

## Checks

```sh
npm ci
npm run verify   # format, lint, types, composition, unit tests
```

## Database and browser tests

These suites reset a database called `duefold_test`, so never point them at data you care about. One-time setup, with local throwaway passwords:

```sh
sudo -u postgres createuser --superuser "$USER"
psql -d postgres <<'SQL'
CREATE ROLE duefold_migration LOGIN NOINHERIT PASSWORD 'duefold_local_migration';
CREATE ROLE duefold_runtime LOGIN NOINHERIT PASSWORD 'duefold_local_runtime';
CREATE ROLE duefold_authenticator LOGIN NOINHERIT PASSWORD 'duefold_local_authenticator';
CREATE ROLE duefold_worker LOGIN NOINHERIT PASSWORD 'duefold_local_worker';
CREATE DATABASE duefold_test;
SQL
npx playwright install chromium firefox
```

Then run them:

```sh
cp .env.development.example .env
export $(grep '^DUEFOLD_TEST_' .env | xargs)
npm run test:integration
npm run test:authz
npm run build && npm run test:browser
```

The harness resets the schema as your operating-system user over the local socket. Set `PGUSER` if your PostgreSQL superuser has a different name.

## Layout

| Path              | Contents                                                   |
| ----------------- | ---------------------------------------------------------- |
| `apps/web`        | Fastify server                                             |
| `apps/web-client` | React client                                               |
| `apps/worker`     | Virus scanning and document conversion in the sandbox      |
| `apps/cli`        | Operator commands                                          |
| `modules/`        | Feature modules, selected at build time                    |
| `deploy/`         | Dockerfiles, image policies, database roles, and the host probe |
| `test/`           | Integration, authorization, and browser suites             |
| `compose.yaml`    | Reference Docker Compose deployment                        |

`npm run compose` generates the module registries from `composition.manifest.json` into `.duefold/generated/`. Every build, lint, and typecheck script runs it first.

## Screenshots

`npm run docs:screenshots` regenerates `docs/images/` from synthetic data. It needs the same setup as the browser suite.
