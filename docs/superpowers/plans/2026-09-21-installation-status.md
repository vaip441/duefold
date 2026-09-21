# Installation Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Owner or Admin can read the `DESIGN_SPEC.md` §20.2 security/deployment status and set the installation-wide original-download default, with every status fact read where it is already true or observed by the one process that can see it.

**Architecture:** Three migrations, one per owning module. 024 (`core-security`) adds a one-row-per-check observation table with a writer per process and the Owner/Admin deployment readers. 025 (`rooms-documents`) adds the content reader (failed processing, recovery record) and seeds `status.observe`, an hourly worker job that probes storage privacy, storage versioning and scanner signatures. 026 (`participants-access`) makes the installation download default a reviewed change. The CLI records update availability (`updates check-file`). OIDC is reported from the discovery check the web process must pass before it starts. The web process only reads, and receives its build facts through `WebRuntime` rather than importing generated registries. The browser adds Status and Installation sections to the Administration view; each owns its state.

**Tech Stack:** Node 26.5.0, TypeScript 5.9.3, Fastify, PostgreSQL (plpgsql `SECURITY DEFINER`), TypeBox, pg, `@aws-sdk/client-s3`, `openid-client` 6.8.8, React 19, Base UI dialogs, Vitest 5, Playwright 1.63, axe-core.

**Spec:** `docs/superpowers/specs/2026-09-20-room-admin-surface-design.md` — milestone 3 of 3 (§4.7, §5, §6.1, §7, §9, §10). `DESIGN_SPEC.md` §9.3, §9.4, §18.1, §19, §20.1–§20.3 and §21.2 are the product rules these tasks implement.

## Global Constraints

- Node is pinned to **26.5.0**; npm `>=11.0.0`. **No new dependency.** `@aws-sdk/client-s3` and `openid-client` are already dependencies.
- Migrations are **one global sequence across all four modules** and **immutable once applied**. This plan uses **`024_deployment_status.sql`** (`core-security`), **`025_content_status.sql`** (`rooms-documents`) and **`026_installation_settings.sql`** (`participants-access`). Task 3 appends to 025, which is valid only while it has not been applied to a durable database; during development re-run `npm run db:reset`. If 025 is applied anywhere before Task 3, put Task 3's SQL in `027_status_observation_job.sql` instead.
- Every new function is `SECURITY DEFINER SET search_path=public,pg_temp`, `REVOKE ALL ... FROM PUBLIC`, `ALTER FUNCTION ... OWNER TO duefold_migration`, and granted to exactly the credential that calls it: `duefold_runtime` for readers and mutations the web calls, `duefold_worker` for the worker's observation writer, and no one for the update writer (the CLI connects as the migration role, which owns it). New tables are `REVOKE ALL ... FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker`.
- **Invariant 14:** the installation download mutation and its `audit_event` row commit in one transaction, inside the function. Status observations are not security mutations: they write no audit row, and are overwritten in place (spec §9). **Invariant 4:** every new route is `audience: 'member'` with no role branch in its handler, and declares `...protectedErrorResponses()` from `modules/core-security/src/routes/error-envelope.ts` beside its success schema.
- **Owner/Admin in SQL.** Every status and installation function starts with `PERFORM assert_organization_administrator(p_actor_id)` (017), so a plain Member and a Room Manager are refused identically with `42501`.
- **Refusals are SQLSTATEs.** `42501` forbidden, `22023`/`23514` invalid, `40001` stale revision, `55000` wrong state. TypeScript never throws for user input; it throws only when a function that must return a row returned none.
- **Authorize before anything else**, then validate, then lock, then check revision, then state, then freshness, then the phrase. Freshness is decided in SQL; wrappers pass `identity.oidcAuthenticatedAt ?? null` and never pre-check.
- **Status carries no configuration.** An observation stores a `code` matching `^[A-Z][A-Z0-9_]{0,63}$`, never prose, so an issuer URL, endpoint, bucket, host, credential, e-mail or object key cannot be written. A route test asserts the response contains none of the configured values (spec §7).
- **Client.** Mutations return `Promise<PresentedFailure | null>` through `committed()`; reviews return `Promise<Outcome<T>>` through `settle()` (`apps/web-client/src/workspace/outcome.ts`). A dialog owns its pending and failure state (`ConfirmationDialog`). Parsers validate every field and fail closed with `ApiError('unavailable')`. Every string goes through `translate()` with a key in `apps/web-client/src/i18n/en.ts`; message keys are looked up through typed `Record`s, never built from template literals. State is named in words, never by colour alone.
- **Size.** No file over 1000 lines. `Workspace.tsx` (535) changes one label and must not grow. `AdministrationView.tsx` (170) may grow by at most 30 lines. `test/support/browser-server.ts` (1055) may grow by exactly the two lines the runtime's `deployment` field needs. `apps/worker/src/runner.ts` (256) may grow by at most 4. `apps/web-client/src/styles/components.css` (1020) must not grow: the status table reuses `df-register`, `df-state` and `data-label`.
- **Maps.** `CODEBASE_MAP.md` and the module maps (`modules/*/README.md`) change in the same task that adds a route family or public entry point. After editing a map, run `npx vitest run --project unit test/unit/codebase-map.test.ts`.
- **Comments** state a rule once, where it is owned. No history narration ("used to", "previously", "was") in new code or migrations; the git log holds history.
- **Every role that can reach a surface, and one that cannot,** is exercised: Owner and Admin may; a plain Member and a Room Manager may not. Browser accessibility runs axe in **both** light and dark through `settleTheme` (`test/browser/theme.ts`).
- **Running tests on this machine.** `free -h` first; run one command at a time — the combined `npm run verify` has exhausted memory here. `.env` is not shell-sourceable, so pass it to node:
  - `npm run compose` after any migration, route, job or declaration change;
  - authz: `node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/<file>`;
  - integration: `node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2 test/integration/<file>`;
  - unit: `npx vitest run --project unit --maxWorkers=2 <pattern>`;
  - browser: `node --env-file=.env ./node_modules/@playwright/test/cli.js test test/browser/<file> --project=chromium --project=firefox --project=mobile-chromium` (the configured single worker; WebKit cannot start on this host);
  - format touched files with `npx prettier --write <files>` before `npm run lint`.
- **Commits** follow each task only with the user's approval for this plan's execution (AGENTS.md). Without it, stop after the verification step and report.

## File map

| File | Responsibility |
|---|---|
| `modules/core-security/migrations/024_deployment_status.sql` | observation table, worker and update writers, deployment and observation readers |
| `modules/core-security/src/status-observations.ts` | check and code vocabulary, the code → result table, the two recorders |
| `modules/core-security/src/deployment-status.ts` | `DeploymentFacts`, `migrationStatus`, `presentUpdateObservation`, `readDeploymentStatus` |
| `modules/core-security/src/release.ts` | `applicationVersion`, `compareReleaseVersions` |
| `modules/core-security/src/routes/deployment-status.ts` | `GET /api/status` |
| `modules/rooms-documents/migrations/025_content_status.sql` | content reader; `status.observe` seed |
| `modules/rooms-documents/src/content-status.ts` | `readContentStatus` |
| `modules/rooms-documents/src/routes/content-status.ts` | `GET /api/status/content` |
| `modules/rooms-documents/src/storage/status-probe.ts` | storage privacy and versioning probes |
| `modules/rooms-documents/src/jobs/status-observe.ts` | the hourly observation job |
| `modules/participants-access/migrations/026_installation_settings.sql` | installation reader, download review and apply |
| `modules/participants-access/src/installation-settings.ts` | wrappers |
| `modules/participants-access/src/routes/installation.ts` | `GET /api/installation` |
| `modules/participants-access/src/routes/installation-download.ts` | `POST /api/installation/download-policy` |
| `apps/web/src/deployment-facts.ts` | the composition this process was built from |
| `apps/cli/src/lifecycle.ts` | `updateObservation` |
| `apps/web-client/src/api/status-codes.ts` | the browser's copy of the status code vocabulary, import-free |
| `apps/web-client/src/api/status.ts`, `apps/web-client/src/api/installation.ts` | parsed clients |
| `apps/web-client/src/workspace/useLoad.ts`, `useInstallationSettings.ts` | a section's read; the Installation section's read and change |
| `apps/web-client/src/workspace/status-rows.ts` | pure mapping from facts to worded rows |
| `apps/web-client/src/components/StatusPanel.tsx` | the Status section |
| `apps/web-client/src/components/InstallationPanel.tsx`, `InstallationDownloadControls.tsx` | the Installation section |
| `apps/web-client/src/workspace/views/InstallationSections.tsx` | hook-to-panel wrappers the Administration view renders |
| `test/authz/installation-status.test.ts` | 024 and 025 SQL |
| `test/authz/installation-status-routes.test.ts` | both status routes |
| `test/authz/installation-download.test.ts` | 026 and its routes |
| `test/integration/status-observation.test.ts` | the job through the real runner |
| `test/integration/cli-status-observations.test.ts` | `updates check-file` recording |
| `test/unit/status-codes.test.ts` | client and server code vocabularies agree |
| `test/support/status-seeding.ts` | browser-test observation seeding |
| `test/browser/installation-status.spec.ts` | journeys and accessibility |
| `docs/installation-status-http-contract.md` | the HTTP contract, grown task by task |

---

### Task 1: Observations and the deployment readers (024)

**Files:**
- Create: `modules/core-security/migrations/024_deployment_status.sql`
- Modify: `modules/core-security/src/declaration.ts` (migrations array, after `017_organization_administration`)
- Create: `modules/core-security/src/status-observations.ts`
- Create: `modules/core-security/src/release.ts`, `modules/core-security/src/release.unit.test.ts`
- Create: `modules/core-security/src/deployment-status.ts`, `modules/core-security/src/deployment-status.unit.test.ts`
- Test: `test/authz/installation-status.test.ts`

**Interfaces:**
- Consumes: `assert_organization_administrator(p_actor_id text)` (017); `read_applied_migration_ids()` (created by `migrate.ts`); `job_queue` (001); `resetRoomSchema`, `seedMember`, `seedRoom`, `staffRoom` from `test/authz/support/room-fixture.ts`; `migrationPool`, `databasePool`, `authPool`, `workerPool`, `closePools` from `test/authz/support/database.ts`.
- Produces:
  - SQL `record_worker_status_observation(p_check text, p_result text, p_code text, p_evidence_at timestamptz) RETURNS void` — `duefold_worker` only; checks `storage-privacy`, `storage-versioning`, `scanner`.
  - SQL `record_update_observation(p_result text, p_code text, p_offered_version text) RETURNS void` — the migration role only.
  - SQL `read_deployment_status(p_actor_id text) RETURNS TABLE(applied_migrations text[], jobs_due integer, jobs_running integer, jobs_failed_recently integer, oldest_due_seconds integer, mail_delivered_at timestamptz, mail_failed_recently integer)` — Owner/Admin.
  - SQL `read_status_observations(p_actor_id text) RETURNS TABLE(check_name text, result text, code text, evidence_at timestamptz, evidence_version text, observed_at timestamptz, stale boolean)` — Owner/Admin; four rows in display order.
  - TS `status-observations.ts`: `ObservationResult`, `StatusCheck`, `WorkerCheck`; `STATUS_CHECKS`; `CHECK_CODES` and the unions derived from it (`StoragePrivacyCode`, `StorageVersioningCode`, `ScannerCode`, `UpdateCode`, `ObservationCode`); `observationResult(code)`; `WorkerObservation`, `recordWorkerObservation(pool, observation)`; `UpdateObservation`, `recordUpdateObservation(pool, observation)`.
  - TS `release.ts`: `applicationVersion(): string` (root `package.json`, `X.Y.Z`), `compareReleaseVersions(left, right): number | null`.
  - TS `deployment-status.ts`: `DeploymentFacts`, `MigrationStatus`, `migrationStatus(applied, expected)`, `CheckObservation`, `presentUpdateObservation(observation, runningVersion)`, `DeploymentStatus`, `readDeploymentStatus({pool, identity, facts})`.

Observations are what no web request can learn: whether the bucket refuses strangers, whether it keeps versions, how old the scanner's signatures are, and whether a newer release exists. Everything else on the surface is read live. The worker observes hourly and the CLI when an operator runs it, so each check has one writer granted only to that process, and each row turns `stale` on its own.

OIDC is not an observation. The CLI's `migrate` service runs on a network with no egress (`compose.yaml`, `internal: true`) and the worker holds no OIDC configuration, while the web process performs discovery and client-authentication negotiation at startup and refuses to start if either fails (`discoverOidc`). `DeploymentFacts.oidcDiscoveryConformedAt` reports that check and when it passed.

An update check compares the offered release with the one running when the operator made it. After the upgrade it describes, the offer no longer stands, so `presentUpdateObservation` reads an offered release that is now installed as current.

- [x] **Step 1: Write the failing tests**

Create `test/authz/installation-status.test.ts`:

```ts
/**
 * The status surface's database side: who may record an observation, what an observation
 * may contain, and who may read the deployment facts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createOpaqueId } from '@duefold/shared/ids';
import {
  authPool,
  closePools,
  databasePool,
  migrationPool,
  workerPool,
} from './support/database.ts';
import { resetRoomSchema, seedMember, seedRoom, staffRoom } from './support/room-fixture.ts';

let ownerId = '';
let adminId = '';
let plainMemberId = '';
let managerId = '';

beforeAll(async () => {
  ownerId = await resetRoomSchema('Installation status');
  adminId = await seedMember('admin', 'status.admin');
  plainMemberId = await seedMember('member', 'status.plain');
  managerId = await seedMember('member', 'status.manager');
  await staffRoom(managerId, await seedRoom(ownerId, 'Status room'), 'manager', ownerId);
});
afterAll(closePools);

const recordWorker = (
  pool: Pool,
  check: string,
  result: string,
  code: string,
  evidenceAt: Date | null = null,
) =>
  pool.query('SELECT record_worker_status_observation($1,$2,$3,$4)', [
    check,
    result,
    code,
    evidenceAt,
  ]);

const recordUpdate = (pool: Pool, result: string, code: string, offered: string | null) =>
  pool.query('SELECT record_update_observation($1,$2,$3)', [result, code, offered]);

async function observation(check: string) {
  return (
    await migrationPool.query<{
      result: string;
      code: string;
      evidence_at: Date | null;
      evidence_version: string | null;
    }>(
      'SELECT result,code,evidence_at,evidence_version FROM deployment_status_observation WHERE check_name=$1',
      [check],
    )
  ).rows[0];
}

describe('recording an observation', () => {
  it('lets the worker record the checks it runs, and overwrites the previous answer', async () => {
    await recordWorker(workerPool, 'storage-privacy', 'fail', 'ANONYMOUS_READ_ALLOWED');
    await recordWorker(workerPool, 'storage-privacy', 'pass', 'ANONYMOUS_ACCESS_REFUSED');
    const built = new Date('2026-09-20T06:24:19.000Z');
    await recordWorker(workerPool, 'scanner', 'pass', 'SIGNATURES_CURRENT', built);
    expect(await observation('storage-privacy')).toStrictEqual({
      result: 'pass',
      code: 'ANONYMOUS_ACCESS_REFUSED',
      evidence_at: null,
      evidence_version: null,
    });
    expect((await observation('scanner'))?.evidence_at).toStrictEqual(built);
    expect(
      (
        await migrationPool.query<{ n: number }>(
          "SELECT count(*)::int n FROM deployment_status_observation WHERE check_name='storage-privacy'",
        )
      ).rows[0]?.n,
    ).toBe(1);
  });

  it('lets the CLI, as the migration role, record the update check', async () => {
    await recordUpdate(migrationPool, 'attention', 'UPDATE_AVAILABLE', '1.4.0');
    expect(await observation('updates')).toStrictEqual({
      result: 'attention',
      code: 'UPDATE_AVAILABLE',
      evidence_at: null,
      evidence_version: '1.4.0',
    });
  });

  it("refuses the worker the CLI's check, and every other credential both writers", async () => {
    await expect(
      recordWorker(workerPool, 'updates', 'pass', 'UPDATE_CURRENT'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(recordUpdate(workerPool, 'pass', 'UPDATE_CURRENT', null)).rejects.toMatchObject({
      code: '42501',
    });
    for (const pool of [databasePool, authPool]) {
      await expect(
        recordWorker(pool, 'storage-privacy', 'pass', 'ANONYMOUS_ACCESS_REFUSED'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(recordUpdate(pool, 'pass', 'UPDATE_CURRENT', null)).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('stores codes, never prose, so no configuration can be written into status', async () => {
    for (const code of [
      'https://issuer.example/.well-known',
      'bucket duefold-private',
      'owner@example.test',
      'lowercase_code',
      '',
    ])
      await expect(
        recordWorker(workerPool, 'storage-privacy', 'fail', code),
      ).rejects.toMatchObject({ code: '23514' });
  });

  it('binds each evidence column to its one check', async () => {
    await expect(
      recordWorker(workerPool, 'storage-versioning', 'pass', 'VERSIONING_ENABLED', new Date()),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      recordUpdate(migrationPool, 'attention', 'UPDATE_AVAILABLE', 'latest'),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('holds no table grant for any application credential', async () => {
    for (const role of ['duefold_runtime', 'duefold_authenticator', 'duefold_worker'])
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
        expect(
          (
            await migrationPool.query<{ held: boolean }>(
              "SELECT has_table_privilege($1,'deployment_status_observation',$2) AS held",
              [role, privilege],
            )
          ).rows[0]?.held,
          `${role} ${privilege}`,
        ).toBe(false);
  });
});

describe('reading the deployment status', () => {
  it.each([
    ['Owner', () => ownerId],
    ['Admin', () => adminId],
  ])('answers %s with the migration ledger', async (_label, actor) => {
    const row = (
      await databasePool.query<{ applied_migrations: string[] }>(
        'SELECT * FROM read_deployment_status($1)',
        [actor()],
      )
    ).rows[0];
    const ledger = (
      await migrationPool.query<{ id: string }>('SELECT id FROM duefold_migration ORDER BY id')
    ).rows.map(({ id }) => id);
    expect(row?.applied_migrations).toStrictEqual(ledger);
  });

  it.each([
    ['plain Member', () => plainMemberId],
    ['Room Manager', () => managerId],
  ])('refuses a %s, identically', async (_label, actor) => {
    for (const reader of ['read_deployment_status', 'read_status_observations'])
      await expect(
        databasePool.query(`SELECT * FROM ${reader}($1)`, [actor()]),
      ).rejects.toMatchObject({ code: '42501', message: 'organization administration forbidden' });
  });

  it('is not callable by the worker or the authenticator', async () => {
    for (const pool of [workerPool, authPool])
      await expect(
        pool.query('SELECT * FROM read_deployment_status($1)', [ownerId]),
      ).rejects.toMatchObject({ code: '42501' });
  });

  it('counts due work, not work scheduled for later, and looks back seven days for failures', async () => {
    await migrationPool.query('DELETE FROM job_queue');
    const job = (
      type: string,
      state: 'pending' | 'succeeded' | 'failed',
      availableAgo: string,
      updatedAgo = '0 seconds',
    ) =>
      migrationPool.query(
        `INSERT INTO job_queue(id,job_type,idempotency_key,payload,state,available_at,updated_at)
         VALUES($1,$2,$3,'{}'::jsonb,$4,statement_timestamp()-$5::interval,
                statement_timestamp()-$6::interval)`,
        [createOpaqueId(), type, `status-test:${createOpaqueId()}`, state, availableAgo, updatedAgo],
      );
    await job('document.source.validate', 'pending', '20 minutes');
    await job('document.source.validate', 'pending', '1 minute');
    await job('ownership.preview.purge', 'pending', '-1 hour');
    await job('export.cleanup', 'failed', '2 days', '2 days');
    await job('export.cleanup', 'failed', '10 days', '10 days');
    await job('mail.member_invitation', 'succeeded', '3 hours', '3 hours');
    await job('auth.otp.deliver', 'failed', '1 day', '1 day');

    const row = (
      await databasePool.query<{
        jobs_due: number;
        jobs_running: number;
        jobs_failed_recently: number;
        oldest_due_seconds: number | null;
        mail_delivered_at: Date | null;
        mail_failed_recently: number;
      }>('SELECT * FROM read_deployment_status($1)', [ownerId])
    ).rows[0];
    expect(row).toMatchObject({
      jobs_due: 2,
      jobs_running: 0,
      jobs_failed_recently: 2,
      mail_failed_recently: 1,
    });
    expect(row?.oldest_due_seconds).toBeGreaterThanOrEqual(20 * 60);
    expect(row?.oldest_due_seconds).toBeLessThan(21 * 60);
    expect(row?.mail_delivered_at?.getTime()).toBeLessThan(Date.now() - 2 * 3_600_000);
  });

  it('lists every check in display order, unobserved ones as nulls', async () => {
    await migrationPool.query('DELETE FROM deployment_status_observation');
    await recordWorker(workerPool, 'scanner', 'fail', 'SIGNATURES_STALE', new Date(0));
    const rows = (
      await databasePool.query<{ check_name: string; code: string | null; stale: boolean }>(
        'SELECT check_name,code,stale FROM read_status_observations($1)',
        [adminId],
      )
    ).rows;
    expect(rows).toStrictEqual([
      { check_name: 'storage-privacy', code: null, stale: false },
      { check_name: 'storage-versioning', code: null, stale: false },
      { check_name: 'scanner', code: 'SIGNATURES_STALE', stale: false },
      { check_name: 'updates', code: null, stale: false },
    ]);
  });

  it('marks a worker check stale after three hours and the update check after thirty days', async () => {
    await recordWorker(workerPool, 'storage-versioning', 'pass', 'VERSIONING_ENABLED');
    await recordUpdate(migrationPool, 'pass', 'UPDATE_CURRENT', null);
    const age = (check: string, ago: string) =>
      migrationPool.query(
        'UPDATE deployment_status_observation SET observed_at=statement_timestamp()-$2::interval WHERE check_name=$1',
        [check, ago],
      );
    const stale = async (check: string) =>
      (
        await databasePool.query<{ stale: boolean }>(
          'SELECT stale FROM read_status_observations($1) WHERE check_name=$2',
          [ownerId, check],
        )
      ).rows[0]?.stale;
    await age('storage-versioning', '2 hours 50 minutes');
    await age('updates', '29 days');
    expect([await stale('storage-versioning'), await stale('updates')]).toStrictEqual([
      false,
      false,
    ]);
    await age('storage-versioning', '3 hours 10 minutes');
    await age('updates', '31 days');
    expect([await stale('storage-versioning'), await stale('updates')]).toStrictEqual([
      true,
      true,
    ]);
  });
});
```

Create `modules/core-security/src/release.unit.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applicationVersion, compareReleaseVersions } from './release.ts';

describe('applicationVersion', () => {
  it('is the root package version every image carries', () => {
    const root = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { readonly version: string };
    expect(applicationVersion()).toBe(root.version);
  });
});

describe('compareReleaseVersions', () => {
  it('orders numerically, part by part', () => {
    expect(compareReleaseVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareReleaseVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareReleaseVersions('1.4.2', '1.4.2')).toBe(0);
  });

  it('refuses to order anything that is not X.Y.Z', () => {
    expect(compareReleaseVersions('1.2', '1.2.0')).toBeNull();
    expect(compareReleaseVersions('1.2.0-rc.1', '1.2.0')).toBeNull();
    expect(compareReleaseVersions('1.2.0', 'latest')).toBeNull();
  });
});
```

Create `modules/core-security/src/deployment-status.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  migrationStatus,
  presentUpdateObservation,
  type CheckObservation,
} from './deployment-status.ts';

describe('migrationStatus', () => {
  const registry = ['017_b', '001_a', '020_c'];

  it('is current when the ledger is the registry in order', () => {
    expect(migrationStatus(['001_a', '017_b', '020_c'], registry)).toStrictEqual({
      state: 'current',
      appliedCount: 3,
      expectedCount: 3,
      latestApplied: '020_c',
    });
  });

  it('is pending when the ledger is a strict prefix, as when an image is newer than its database', () => {
    expect(migrationStatus(['001_a'], registry)).toMatchObject({
      state: 'pending',
      appliedCount: 1,
      latestApplied: '001_a',
    });
    expect(migrationStatus([], registry)).toMatchObject({ state: 'pending', latestApplied: null });
  });

  it('is unrecognized when the ledger names something this image did not produce', () => {
    expect(migrationStatus(['001_a', '018_x'], registry).state).toBe('unrecognized');
    expect(migrationStatus(['001_a', '017_b', '020_c', '030_z'], registry).state).toBe(
      'unrecognized',
    );
  });
});

describe('presentUpdateObservation', () => {
  const offer: CheckObservation = {
    result: 'attention',
    code: 'UPDATE_AVAILABLE',
    evidenceAt: null,
    evidenceVersion: '1.5.0',
    observedAt: '2026-09-01T00:00:00.000Z',
    stale: false,
  };

  it('keeps an offer of a release newer than the running one', () => {
    expect(presentUpdateObservation(offer, '1.4.0')).toStrictEqual(offer);
  });

  it('reads an offer that has since been installed as current', () => {
    expect(presentUpdateObservation(offer, '1.5.0')).toStrictEqual({
      ...offer,
      result: 'pass',
      code: 'UPDATE_CURRENT',
      evidenceVersion: null,
    });
    expect(
      presentUpdateObservation({ ...offer, result: 'fail', code: 'SECURITY_ADVISORY' }, '1.6.0'),
    ).toMatchObject({ result: 'pass', code: 'UPDATE_CURRENT' });
  });

  it('leaves an observation that offers nothing alone', () => {
    const unverified: CheckObservation = {
      ...offer,
      result: 'fail',
      code: 'UPDATE_MANIFEST_UNVERIFIED',
      evidenceVersion: null,
    };
    expect(presentUpdateObservation(unverified, '9.9.9')).toStrictEqual(unverified);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run --project unit --maxWorkers=2 deployment-status release
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/installation-status.test.ts
```

Expected: FAIL — `deployment-status.ts` and `release.ts` do not exist; `record_worker_status_observation` does not exist.

- [x] **Step 3: Write migration 024**

Create `modules/core-security/migrations/024_deployment_status.sql`:

```sql
-- Duefold deployment status: observations recorded by the process that can make them, and
-- the Owner/Admin readers the status surface shows. Immutable after application.

/*
 * One row per check, overwritten in place. A check that has never run has no row.
 *
 * `code` is a code, not a summary: its pattern cannot hold an issuer URL, endpoint, bucket,
 * host, e-mail, key or path, so no observation can carry configuration (§20.3). Each
 * evidence column belongs to one check.
 */
CREATE TABLE deployment_status_observation (
  check_name text PRIMARY KEY
    CHECK (check_name IN ('storage-privacy','storage-versioning','scanner','updates')),
  result text NOT NULL CHECK (result IN ('pass','attention','fail')),
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  evidence_at timestamptz CHECK (evidence_at IS NULL OR check_name='scanner'),
  evidence_version text CHECK (evidence_version IS NULL
    OR (check_name='updates' AND evidence_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$')),
  observed_at timestamptz NOT NULL
);
COMMENT ON TABLE deployment_status_observation IS
  'Latest answer of each status check that only the worker or an operator can make. Codes only; no configuration.';
REVOKE ALL ON deployment_status_observation
  FROM PUBLIC,duefold_runtime,duefold_authenticator,duefold_worker;

/*
 * Each check has exactly one writer, granted only to the process that runs it: the worker
 * observes storage and the scanner; the CLI, connecting as the migration role, records the
 * update check. The web credential writes nothing here.
 */
CREATE FUNCTION record_worker_status_observation(
  p_check text,p_result text,p_code text,p_evidence_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_check IS NULL OR p_check NOT IN ('storage-privacy','storage-versioning','scanner') THEN
    RAISE EXCEPTION 'not a worker status check' USING ERRCODE='42501';
  END IF;
  INSERT INTO deployment_status_observation(check_name,result,code,evidence_at,observed_at)
  VALUES(p_check,p_result,p_code,p_evidence_at,statement_timestamp())
  ON CONFLICT (check_name) DO UPDATE
    SET result=EXCLUDED.result,code=EXCLUDED.code,evidence_at=EXCLUDED.evidence_at,
        observed_at=EXCLUDED.observed_at;
END $$;

CREATE FUNCTION record_update_observation(
  p_result text,p_code text,p_offered_version text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO deployment_status_observation(check_name,result,code,evidence_version,observed_at)
  VALUES('updates',p_result,p_code,p_offered_version,statement_timestamp())
  ON CONFLICT (check_name) DO UPDATE
    SET result=EXCLUDED.result,code=EXCLUDED.code,evidence_version=EXCLUDED.evidence_version,
        observed_at=EXCLUDED.observed_at;
END $$;

/*
 * The facts the status surface reads from PostgreSQL.
 *
 * `jobs_due` counts pending work whose time has come; a self-rescheduling sweep waiting for
 * its next hour is not a backlog. Its age is computed here, on the database clock, so the
 * browser never does arithmetic on its own clock. Failures and mail evidence look back seven
 * days, so a fault that has been fixed stops being reported without anyone deleting history.
 * The mail job types are core-security's required mail.
 */
CREATE FUNCTION read_deployment_status(p_actor_id text)
RETURNS TABLE(applied_migrations text[],jobs_due integer,jobs_running integer,
              jobs_failed_recently integer,oldest_due_seconds integer,
              mail_delivered_at timestamptz,mail_failed_recently integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  mail_jobs constant text[] := ARRAY['auth.otp.deliver','mail.viewer_invitation','mail.member_invitation'];
  window_start constant timestamptz := statement_timestamp()-interval '7 days';
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  RETURN QUERY
    SELECT
      ARRAY(SELECT a.id FROM read_applied_migration_ids() a),
      (SELECT count(*)::integer FROM job_queue j
        WHERE j.state='pending' AND j.available_at<=statement_timestamp()),
      (SELECT count(*)::integer FROM job_queue j WHERE j.state='running'),
      (SELECT count(*)::integer FROM job_queue j
        WHERE j.state='failed' AND j.updated_at>window_start),
      (SELECT floor(extract(epoch FROM statement_timestamp()-min(j.available_at)))::integer
         FROM job_queue j WHERE j.state='pending' AND j.available_at<=statement_timestamp()),
      (SELECT max(j.updated_at) FROM job_queue j
        WHERE j.state='succeeded' AND j.job_type=ANY(mail_jobs)),
      (SELECT count(*)::integer FROM job_queue j
        WHERE j.state='failed' AND j.job_type=ANY(mail_jobs) AND j.updated_at>window_start);
END $$;

/*
 * Every check, in display order, whether or not it has run. Staleness follows each check's
 * writer: the worker observes hourly, so three missed runs is stale; the update check is as
 * fresh as the last time an operator ran it, and thirty days without one is stale.
 */
CREATE FUNCTION read_status_observations(p_actor_id text)
RETURNS TABLE(check_name text,result text,code text,evidence_at timestamptz,
              evidence_version text,observed_at timestamptz,stale boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  RETURN QUERY
    SELECT c.name,o.result,o.code,o.evidence_at,o.evidence_version,o.observed_at,
           coalesce(o.observed_at<statement_timestamp()-c.stale_after,false)
      FROM (VALUES (1,'storage-privacy',interval '3 hours'),
                   (2,'storage-versioning',interval '3 hours'),
                   (3,'scanner',interval '3 hours'),
                   (4,'updates',interval '30 days')) AS c(ordinal,name,stale_after)
      LEFT JOIN deployment_status_observation o ON o.check_name=c.name
     ORDER BY c.ordinal;
END $$;

REVOKE ALL ON FUNCTION record_worker_status_observation(text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_update_observation(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_deployment_status(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_status_observations(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_worker_status_observation(text,text,text,timestamptz) TO duefold_worker;
GRANT EXECUTE ON FUNCTION read_deployment_status(text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION read_status_observations(text) TO duefold_runtime;
ALTER FUNCTION record_worker_status_observation(text,text,text,timestamptz) OWNER TO duefold_migration;
ALTER FUNCTION record_update_observation(text,text,text) OWNER TO duefold_migration;
ALTER FUNCTION read_deployment_status(text) OWNER TO duefold_migration;
ALTER FUNCTION read_status_observations(text) OWNER TO duefold_migration;
```

In `modules/core-security/src/declaration.ts`, add after `017_organization_administration`:

```ts
    { id: '024_deployment_status', file: '024_deployment_status.sql' },
```

- [x] **Step 4: Write the vocabulary and the recorders**

Create `modules/core-security/src/status-observations.ts`:

```ts
/**
 * The status checks only the worker or an operator can make, the codes each may answer, and
 * the one writer each is allowed. A code decides its result, so the pair cannot disagree.
 */
import type { Pool } from 'pg';

export type ObservationResult = 'pass' | 'attention' | 'fail';
export type WorkerCheck = 'storage-privacy' | 'storage-versioning' | 'scanner';
export type StatusCheck = WorkerCheck | 'updates';

/** Display order, which `read_status_observations` also answers in. */
export const STATUS_CHECKS: readonly StatusCheck[] = [
  'storage-privacy',
  'storage-versioning',
  'scanner',
  'updates',
];

/** Every code each check may answer. The browser mirrors it (`test/unit/status-codes.test.ts`). */
export const CHECK_CODES = {
  'storage-privacy': [
    'ANONYMOUS_ACCESS_REFUSED',
    'ANONYMOUS_READ_ALLOWED',
    'ANONYMOUS_LIST_ALLOWED',
    'STORAGE_PROBE_INCONCLUSIVE',
    'STORAGE_UNREACHABLE',
  ],
  'storage-versioning': [
    'VERSIONING_ENABLED',
    'VERSIONING_SUSPENDED',
    'VERSIONING_NEVER_ENABLED',
    'VERSIONING_NOT_DETECTABLE',
    'STORAGE_UNREACHABLE',
  ],
  scanner: ['SIGNATURES_CURRENT', 'SIGNATURES_STALE', 'SCANNER_UNAVAILABLE'],
  updates: [
    'UPDATE_CURRENT',
    'UPDATE_AVAILABLE',
    'SECURITY_ADVISORY',
    'UPDATE_MANIFEST_UNVERIFIED',
    'UPDATE_VERSION_UNRECOGNIZED',
  ],
} as const satisfies Readonly<Record<StatusCheck, readonly string[]>>;

export type StoragePrivacyCode = (typeof CHECK_CODES)['storage-privacy'][number];
export type StorageVersioningCode = (typeof CHECK_CODES)['storage-versioning'][number];
export type ScannerCode = (typeof CHECK_CODES)['scanner'][number];
export type UpdateCode = (typeof CHECK_CODES)['updates'][number];
export type ObservationCode = (typeof CHECK_CODES)[StatusCheck][number];

/* Every code's result. A code missing here, or one no check answers, fails to compile. */
const RESULT: Readonly<Record<ObservationCode, ObservationResult>> = {
  ANONYMOUS_ACCESS_REFUSED: 'pass',
  ANONYMOUS_READ_ALLOWED: 'fail',
  ANONYMOUS_LIST_ALLOWED: 'fail',
  STORAGE_PROBE_INCONCLUSIVE: 'attention',
  STORAGE_UNREACHABLE: 'fail',
  VERSIONING_ENABLED: 'pass',
  VERSIONING_SUSPENDED: 'attention',
  VERSIONING_NEVER_ENABLED: 'attention',
  VERSIONING_NOT_DETECTABLE: 'attention',
  SIGNATURES_CURRENT: 'pass',
  SIGNATURES_STALE: 'fail',
  SCANNER_UNAVAILABLE: 'fail',
  UPDATE_CURRENT: 'pass',
  UPDATE_AVAILABLE: 'attention',
  SECURITY_ADVISORY: 'fail',
  UPDATE_MANIFEST_UNVERIFIED: 'fail',
  UPDATE_VERSION_UNRECOGNIZED: 'attention',
};

export function observationResult(code: ObservationCode): ObservationResult {
  return RESULT[code];
}

export type WorkerObservation =
  | { readonly check: 'storage-privacy'; readonly code: StoragePrivacyCode }
  | { readonly check: 'storage-versioning'; readonly code: StorageVersioningCode }
  | {
      readonly check: 'scanner';
      readonly code: ScannerCode;
      /** The signature build time clamd reported; null when it could not be asked. */
      readonly signaturesBuiltAt: Date | null;
    };

export interface UpdateObservation {
  readonly code: UpdateCode;
  /** The release a newer signed manifest offers; null when none is offered. */
  readonly offeredVersion: string | null;
}

type Queryable = Pick<Pool, 'query'>;

export async function recordWorkerObservation(
  pool: Queryable,
  observation: WorkerObservation,
): Promise<void> {
  await pool.query('SELECT record_worker_status_observation($1,$2,$3,$4)', [
    observation.check,
    RESULT[observation.code],
    observation.code,
    observation.check === 'scanner' ? observation.signaturesBuiltAt : null,
  ]);
}

export async function recordUpdateObservation(
  pool: Queryable,
  observation: UpdateObservation,
): Promise<void> {
  await pool.query('SELECT record_update_observation($1,$2,$3)', [
    RESULT[observation.code],
    observation.code,
    observation.offeredVersion,
  ]);
}
```

- [x] **Step 5: Read the running version**

Create `modules/core-security/src/release.ts`:

```ts
/**
 * The running release: the root `package.json` version, which every image carries. The CLI
 * compares a signed manifest against it, and the status surface reports it.
 */
import { readFileSync } from 'node:fs';

const RELEASE_VERSION = /^([0-9]{1,6})\.([0-9]{1,6})\.([0-9]{1,6})$/u;

export function applicationVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  );
  const version =
    typeof parsed === 'object' && parsed !== null && 'version' in parsed
      ? parsed.version
      : undefined;
  if (typeof version !== 'string' || !RELEASE_VERSION.test(version))
    throw new Error('APPLICATION_VERSION_INVALID');
  return version;
}

/**
 * Negative, zero or positive as `left` is older than, the same as, or newer than `right`.
 * Null when either is not `X.Y.Z`: a version this cannot order is not guessed at.
 */
export function compareReleaseVersions(left: string, right: string): number | null {
  const a = RELEASE_VERSION.exec(left);
  const b = RELEASE_VERSION.exec(right);
  if (a === null || b === null) return null;
  for (const part of [1, 2, 3]) {
    const difference = Number(a[part]) - Number(b[part]);
    if (difference !== 0) return difference;
  }
  return 0;
}
```

- [x] **Step 6: Write the deployment reader**

Create `modules/core-security/src/deployment-status.ts`:

```ts
/**
 * The deployment half of the status surface: what this process was built from, and what
 * PostgreSQL says about migrations, the job queue, mail delivery and the observations.
 */
import type { Pool } from 'pg';
import type { MemberIdentity } from './authorization.ts';
import { compareReleaseVersions } from './release.ts';
import type { ObservationResult, StatusCheck } from './status-observations.ts';

/** Injected through `WebRuntime`: a module does not read the composed registry itself. */
export interface DeploymentFacts {
  readonly applicationVersion: string;
  readonly modules: readonly string[];
  readonly adapters: {
    readonly storage: string;
    readonly mail: string;
    readonly identity: string;
  };
  readonly expectedMigrationIds: readonly string[];
  /** When OIDC discovery and client-authentication negotiation passed at startup. */
  readonly oidcDiscoveryConformedAt: string;
}

export type MigrationState = 'current' | 'pending' | 'unrecognized';

export interface MigrationStatus {
  readonly state: MigrationState;
  readonly appliedCount: number;
  readonly expectedCount: number;
  readonly latestApplied: string | null;
}

/**
 * `pending` only when the ledger is a strict prefix of the registry, which is what an image
 * newer than its database looks like. Any other difference is `unrecognized`: this image did
 * not produce that ledger. Ordered the way `migrate` applies them.
 */
export function migrationStatus(
  applied: readonly string[],
  expected: readonly string[],
): MigrationStatus {
  const registry = [...expected].sort((left, right) => left.localeCompare(right));
  const prefix =
    applied.length <= registry.length && applied.every((id, index) => registry[index] === id);
  return {
    state: !prefix ? 'unrecognized' : applied.length === registry.length ? 'current' : 'pending',
    appliedCount: applied.length,
    expectedCount: registry.length,
    latestApplied: applied.at(-1) ?? null,
  };
}

export interface CheckObservation {
  readonly result: ObservationResult;
  readonly code: string;
  readonly evidenceAt: string | null;
  readonly evidenceVersion: string | null;
  readonly observedAt: string;
  readonly stale: boolean;
}

/**
 * An update check compares the offered release with the one running when it was made. Once
 * the offered release is installed the offer no longer stands, whatever it said.
 */
export function presentUpdateObservation(
  observation: CheckObservation,
  runningVersion: string,
): CheckObservation {
  if (observation.evidenceVersion === null) return observation;
  const order = compareReleaseVersions(observation.evidenceVersion, runningVersion);
  return order !== null && order <= 0
    ? { ...observation, result: 'pass', code: 'UPDATE_CURRENT', evidenceVersion: null }
    : observation;
}

export interface StatusCheckRow {
  readonly check: StatusCheck;
  /** Null when the check has never run. */
  readonly observation: CheckObservation | null;
}

export interface DeploymentStatus {
  readonly application: {
    readonly version: string;
    readonly modules: readonly string[];
    readonly adapters: DeploymentFacts['adapters'];
  };
  readonly oidc: { readonly discoveryConformedAt: string };
  readonly migrations: MigrationStatus;
  readonly queue: {
    readonly due: number;
    readonly running: number;
    readonly failedRecently: number;
    readonly oldestDueSeconds: number | null;
  };
  readonly mail: { readonly lastDeliveredAt: string | null; readonly failedRecently: number };
  readonly checks: readonly StatusCheckRow[];
}

interface DeploymentRow {
  readonly applied_migrations: string[];
  readonly jobs_due: number;
  readonly jobs_running: number;
  readonly jobs_failed_recently: number;
  readonly oldest_due_seconds: number | null;
  readonly mail_delivered_at: Date | null;
  readonly mail_failed_recently: number;
}

interface ObservationRow {
  readonly check_name: StatusCheck;
  readonly result: ObservationResult | null;
  readonly code: string | null;
  readonly evidence_at: Date | null;
  readonly evidence_version: string | null;
  readonly observed_at: Date | null;
  readonly stale: boolean;
}

function observationOf(row: ObservationRow, runningVersion: string): CheckObservation | null {
  if (row.result === null || row.code === null || row.observed_at === null) return null;
  const observation: CheckObservation = {
    result: row.result,
    code: row.code,
    evidenceAt: row.evidence_at?.toISOString() ?? null,
    evidenceVersion: row.evidence_version,
    observedAt: row.observed_at.toISOString(),
    stale: row.stale,
  };
  return row.check_name === 'updates'
    ? presentUpdateObservation(observation, runningVersion)
    : observation;
}

export async function readDeploymentStatus(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly facts: DeploymentFacts;
}): Promise<DeploymentStatus> {
  /* The first call authorizes; the second is only reached by an Owner or Admin. */
  const row = (
    await input.pool.query<DeploymentRow>('SELECT * FROM read_deployment_status($1)', [
      input.identity.id,
    ])
  ).rows[0];
  if (row === undefined) throw new Error('DEPLOYMENT_STATUS_UNAVAILABLE');
  const observations = await input.pool.query<ObservationRow>(
    'SELECT * FROM read_status_observations($1)',
    [input.identity.id],
  );
  return {
    application: {
      version: input.facts.applicationVersion,
      modules: input.facts.modules,
      adapters: input.facts.adapters,
    },
    oidc: { discoveryConformedAt: input.facts.oidcDiscoveryConformedAt },
    migrations: migrationStatus(row.applied_migrations, input.facts.expectedMigrationIds),
    queue: {
      due: row.jobs_due,
      running: row.jobs_running,
      failedRecently: row.jobs_failed_recently,
      oldestDueSeconds: row.oldest_due_seconds,
    },
    mail: {
      lastDeliveredAt: row.mail_delivered_at?.toISOString() ?? null,
      failedRecently: row.mail_failed_recently,
    },
    checks: observations.rows.map((observation) => ({
      check: observation.check_name,
      observation: observationOf(observation, input.facts.applicationVersion),
    })),
  };
}
```

- [x] **Step 7: Run the tests to verify they pass**

```bash
npm run compose
npx vitest run --project unit --maxWorkers=2 deployment-status release
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/installation-status.test.ts
npm run typecheck && npm run lint
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add modules/core-security test/authz/installation-status.test.ts
git commit -m "Record status observations and read deployment status in PostgreSQL"
```

---

### Task 2: The content status reader (025)

**Files:**
- Create: `modules/rooms-documents/migrations/025_content_status.sql`
- Modify: `modules/rooms-documents/src/declaration.ts` (migrations array, after `022_room_administration`)
- Create: `modules/rooms-documents/src/content-status.ts`
- Test: `test/authz/installation-status.test.ts` (append)

**Interfaces:**
- Consumes: `assert_organization_administrator` (017); `operational_recovery_status` (011); `document_version` (002/003).
- Produces:
  - SQL `read_content_status(p_actor_id text) RETURNS TABLE(failed_processing_count integer, backup_status text, backup_retention text, recovery_expectation text, acknowledged_at timestamptz, restore_drill_status text, restore_drill_at timestamptz)` — Owner/Admin.
  - TS `readContentStatus({pool, identity}): Promise<ContentStatus>`; types `ContentStatus`, `BackupStatus`, `RestoreDrillStatus`.

The recovery record already exists: `backup-status acknowledge` and `restore drill` maintain `operational_recovery_status` (`apps/cli/src/lifecycle.ts`). This reader shows it and the one processing number §20.2 names; it copies nothing.

- [x] **Step 1: Write the failing tests**

Append to `test/authz/installation-status.test.ts`:

```ts
describe('reading the content status', () => {
  it('answers an Owner with the recovery record as the CLI left it', async () => {
    const row = (
      await databasePool.query<Record<string, unknown>>('SELECT * FROM read_content_status($1)', [
        ownerId,
      ])
    ).rows[0];
    expect(row).toStrictEqual({
      failed_processing_count: 0,
      backup_status: 'undetermined',
      backup_retention: null,
      recovery_expectation: null,
      acknowledged_at: null,
      restore_drill_status: 'not-tested',
      restore_drill_at: null,
    });
  });

  it('counts versions whose processing failed', async () => {
    const roomId = await seedRoom(ownerId, 'Processing room');
    for (const title of ['First failure', 'Second failure']) {
      const documentId = createOpaqueId();
      await migrationPool.query(
        'INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,$3,$4)',
        [documentId, roomId, title, ownerId],
      );
      await migrationPool.query(
        `INSERT INTO document_version
         (id,document_id,original_filename,object_key,declared_media_type,size_bytes,state,
          failure_kind,failure_code,retained_until)
         VALUES($1,$2,'failed.txt',$3,'text/plain',1,'processing_failed','transient',
                'SCANNER_UNAVAILABLE',statement_timestamp()+interval '7 days')`,
        [createOpaqueId(), documentId, `quarantine/${createOpaqueId()}/${createOpaqueId()}`],
      );
    }
    expect(
      (
        await databasePool.query<{ failed_processing_count: number }>(
          'SELECT failed_processing_count FROM read_content_status($1)',
          [adminId],
        )
      ).rows[0]?.failed_processing_count,
    ).toBe(2);
  });

  it.each([
    ['plain Member', () => plainMemberId],
    ['Room Manager', () => managerId],
  ])('refuses a %s', async (_label, actor) => {
    await expect(
      databasePool.query('SELECT * FROM read_content_status($1)', [actor()]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

```bash
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/installation-status.test.ts -t "content status"
```

Expected: FAIL — `read_content_status` does not exist.

- [x] **Step 3: Write migration 025**

Create `modules/rooms-documents/migrations/025_content_status.sql`:

```sql
-- Duefold content status: failed processing and the recovery record for the Owner/Admin
-- status surface. Immutable after application.

CREATE FUNCTION read_content_status(p_actor_id text)
RETURNS TABLE(failed_processing_count integer,backup_status text,backup_retention text,
              recovery_expectation text,acknowledged_at timestamptz,
              restore_drill_status text,restore_drill_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  RETURN QUERY
    SELECT (SELECT count(*)::integer FROM document_version v WHERE v.state='processing_failed'),
           s.backup_status,s.backup_retention,s.recovery_expectation,s.acknowledged_at,
           s.restore_drill_status,s.restore_drill_at
      FROM operational_recovery_status s
     WHERE s.singleton;
END $$;

REVOKE ALL ON FUNCTION read_content_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_content_status(text) TO duefold_runtime;
ALTER FUNCTION read_content_status(text) OWNER TO duefold_migration;
```

In `modules/rooms-documents/src/declaration.ts`, add after `022_room_administration`:

```ts
    { id: '025_content_status', file: '025_content_status.sql' },
```

- [x] **Step 4: Write the wrapper**

Create `modules/rooms-documents/src/content-status.ts`:

```ts
/**
 * The content half of the status surface: failed processing, and the recovery record the
 * CLI maintains. Authority is `read_content_status`'s.
 */
import type { Pool } from 'pg';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';

export type BackupStatus = 'undetermined' | 'operator-acknowledged';
export type RestoreDrillStatus = 'not-tested' | 'passed' | 'failed';

export interface ContentStatus {
  readonly processing: { readonly failedCount: number };
  readonly recovery: {
    readonly backupStatus: BackupStatus;
    readonly backupRetention: string | null;
    readonly recoveryExpectation: string | null;
    readonly acknowledgedAt: string | null;
    readonly restoreDrillStatus: RestoreDrillStatus;
    readonly restoreDrillAt: string | null;
  };
}

interface ContentRow {
  readonly failed_processing_count: number;
  readonly backup_status: BackupStatus;
  readonly backup_retention: string | null;
  readonly recovery_expectation: string | null;
  readonly acknowledged_at: Date | null;
  readonly restore_drill_status: RestoreDrillStatus;
  readonly restore_drill_at: Date | null;
}

export async function readContentStatus(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
}): Promise<ContentStatus> {
  const row = (
    await input.pool.query<ContentRow>('SELECT * FROM read_content_status($1)', [
      input.identity.id,
    ])
  ).rows[0];
  if (row === undefined) throw new Error('CONTENT_STATUS_UNAVAILABLE');
  return {
    processing: { failedCount: row.failed_processing_count },
    recovery: {
      backupStatus: row.backup_status,
      backupRetention: row.backup_retention,
      recoveryExpectation: row.recovery_expectation,
      acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
      restoreDrillStatus: row.restore_drill_status,
      restoreDrillAt: row.restore_drill_at?.toISOString() ?? null,
    },
  };
}
```

- [x] **Step 5: Run the tests to verify they pass**

```bash
npm run compose
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/installation-status.test.ts
npm run typecheck && npm run lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add modules/rooms-documents test/authz/installation-status.test.ts
git commit -m "Read failed processing and the recovery record for the status surface"
```

---

### Task 3: The hourly observation job

**Files:**
- Modify: `modules/rooms-documents/src/scanning/clamav.ts` (add `signaturesCurrent`, `readSignatures`; `checkReady` uses both)
- Modify: `test/integration/branding-lifecycle.test.ts` (its scanner double gains `readSignatures`)
- Modify: `modules/rooms-documents/src/storage/s3-compatible.ts` (export `createStorageClient`, the renamed `createClient`)
- Create: `modules/rooms-documents/src/storage/status-probe.ts`, `modules/rooms-documents/src/storage/status-probe.unit.test.ts`
- Create: `modules/rooms-documents/src/jobs/status-observe.ts`, `modules/rooms-documents/src/jobs/status-observe.unit.test.ts`
- Modify: `modules/rooms-documents/migrations/025_content_status.sql` (append the seed)
- Modify: `modules/rooms-documents/src/declaration.ts` (jobs array, after `export.cleanup`)
- Modify: `apps/worker/src/runner.ts` (dependency types), `apps/worker/src/main.ts` (one storage config, the probe)
- Modify: `test/support/s3-endpoint.ts` (answer `GetBucketVersioning`)
- Test: `test/integration/status-observation.test.ts`

**Interfaces:**
- Consumes: `recordWorkerObservation`, `WorkerObservation`, `StoragePrivacyCode`, `StorageVersioningCode` (Task 1); `record_worker_status_observation` (Task 1); `workerStorageConfig`, `WorkerStorageConfig` (`s3-compatible.ts`); `JobRunner`, `JobContext`, `LeasedJob` (`apps/worker/src/runner.ts`).
- Produces:
  - `signaturesCurrent(signatureDate: Date, now: Date, maximumAgeMilliseconds?: number): boolean` and `ClamAvClient.readSignatures(): Promise<{signatureVersion: string; signatureDate: Date}>`.
  - `createStorageClient(config: StorageConfig): S3Client` exported from `s3-compatible.ts`.
  - `StorageStatusProbe {privacy(): Promise<StoragePrivacyCode>; versioning(): Promise<StorageVersioningCode>}`, `createStorageStatusProbe(config, fetchImpl?)`, and the pure `anonymousAccessCode`, `versioningCode`, `bucketUrl`.
  - Job `status.observe` (`rooms-documents`, worker) with `StatusObserveDependencies {pool; storageProbe; scanner: Pick<ClamAvClient, 'readSignatures'>}` and `scannerObservation(scanner, now)`.

The job is declared by `rooms-documents` because it needs the worker's storage credential and the scanner, and it records into `core-security`'s table through `core-security`'s writer: `rooms-documents requires core-security`, so the dependency points the right way. Each probe answers with a code rather than throwing, so one unreachable dependency never hides the other two observations.

The seed waits an hour, as the ownership preview sweep's does (017). A seed that was due at once would be the earliest pending row in every freshly migrated test database, and any `JobRunner` built for another job would claim it first and fail it as `UNKNOWN_JOB_TYPE`.

- [ ] **Step 1: Write the failing unit tests**

Create `modules/rooms-documents/src/storage/status-probe.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { workerStorageConfig } from './s3-compatible.ts';
import {
  anonymousAccessCode,
  bucketUrl,
  createStorageStatusProbe,
  versioningCode,
} from './status-probe.ts';

const config = workerStorageConfig({
  endpoint: 'https://storage.example',
  region: 'auto',
  bucket: 'duefold',
  credentials: { accessKeyId: 'worker-key', secretAccessKey: 'worker-secret' },
  pathStyle: true,
  checksumSupport: false,
});

describe('anonymousAccessCode', () => {
  it.each([
    [403, 403, 'ANONYMOUS_ACCESS_REFUSED'],
    [401, 403, 'ANONYMOUS_ACCESS_REFUSED'],
    [404, 403, 'ANONYMOUS_READ_ALLOWED'],
    [200, 403, 'ANONYMOUS_READ_ALLOWED'],
    [403, 200, 'ANONYMOUS_LIST_ALLOWED'],
    [403, 500, 'STORAGE_PROBE_INCONCLUSIVE'],
    [301, 403, 'STORAGE_PROBE_INCONCLUSIVE'],
  ] as const)('object %i, listing %i → %s', (objectStatus, listStatus, code) => {
    expect(anonymousAccessCode(objectStatus, listStatus)).toBe(code);
  });
});

describe('versioningCode', () => {
  it('names each state the API can answer, and never reads silence as enabled', () => {
    expect(versioningCode('Enabled')).toBe('VERSIONING_ENABLED');
    expect(versioningCode('Suspended')).toBe('VERSIONING_SUSPENDED');
    expect(versioningCode(undefined)).toBe('VERSIONING_NEVER_ENABLED');
  });
});

describe('bucketUrl', () => {
  it('addresses the bucket the way the adapter is configured', () => {
    expect(bucketUrl(config, 'k').href).toBe('https://storage.example/duefold/k');
    expect(bucketUrl({ ...config, pathStyle: false }, 'k').href).toBe(
      'https://duefold.storage.example/k',
    );
    expect(bucketUrl({ ...config, endpoint: 'https://storage.example/s3/' }, 'k').href).toBe(
      'https://storage.example/s3/duefold/k',
    );
  });
});

describe('the privacy probe', () => {
  function answering(objectStatus: number, listStatus: number) {
    const requests: { readonly url: string; readonly method: string; readonly headers: Headers }[] =
      [];
    const fetchImpl: typeof fetch = (input, init) => {
      const url = input instanceof URL ? input.href : String(input);
      requests.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
      return Promise.resolve(
        new Response(null, { status: url.includes('list-type=2') ? listStatus : objectStatus }),
      );
    };
    return { requests, probe: createStorageStatusProbe(config, fetchImpl) };
  }

  it('asks as a stranger: no credential, one random key and one listing', async () => {
    const { requests, probe } = answering(403, 403);
    expect(await probe.privacy()).toBe('ANONYMOUS_ACCESS_REFUSED');
    expect(requests.map(({ method }) => method).sort()).toStrictEqual(['GET', 'HEAD']);
    expect(requests.every(({ headers }) => !headers.has('authorization'))).toBe(true);
    expect(requests.find(({ method }) => method === 'HEAD')?.url).toMatch(
      /^https:\/\/storage\.example\/duefold\/status-probe\/[A-Za-z0-9_-]{32}$/u,
    );
  });

  it('reports a namespace that answers strangers as public read', async () => {
    expect(await answering(404, 403).probe.privacy()).toBe('ANONYMOUS_READ_ALLOWED');
  });

  it('reports an unreachable endpoint, and lets any other fault through', async () => {
    const unreachable = createStorageStatusProbe(config, () =>
      Promise.reject(new TypeError('fetch failed')),
    );
    expect(await unreachable.privacy()).toBe('STORAGE_UNREACHABLE');
    const faulty = createStorageStatusProbe(config, () =>
      Promise.reject(new Error('unexpected')),
    );
    await expect(faulty.privacy()).rejects.toThrow('unexpected');
  });
});
```

Create `modules/rooms-documents/src/jobs/status-observe.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scannerObservation } from './status-observe.ts';

const now = new Date('2026-09-21T12:00:00Z');
const reporting = (signatureDate: Date) => ({
  readSignatures: () => Promise.resolve({ signatureVersion: '28129', signatureDate }),
});

describe('scannerObservation', () => {
  it('reports current signatures with their build time', async () => {
    const built = new Date('2026-09-21T06:00:00Z');
    expect(await scannerObservation(reporting(built), now)).toStrictEqual({
      check: 'scanner',
      code: 'SIGNATURES_CURRENT',
      signaturesBuiltAt: built,
    });
  });

  it('reports signatures older than a day as stale, and keeps the build time', async () => {
    const built = new Date('2026-09-19T12:00:00Z');
    expect(await scannerObservation(reporting(built), now)).toStrictEqual({
      check: 'scanner',
      code: 'SIGNATURES_STALE',
      signaturesBuiltAt: built,
    });
  });

  it('treats a build time in the future as stale, as scanning does', async () => {
    const built = new Date('2026-09-21T13:00:00Z');
    expect((await scannerObservation(reporting(built), now)).code).toBe('SIGNATURES_STALE');
  });

  it('reports a scanner it could not ask without inventing a build time', async () => {
    expect(
      await scannerObservation(
        { readSignatures: () => Promise.reject(new Error('ECONNREFUSED')) },
        now,
      ),
    ).toStrictEqual({ check: 'scanner', code: 'SCANNER_UNAVAILABLE', signaturesBuiltAt: null });
  });
});
```

- [ ] **Step 2: Write the failing integration test**

Create `test/integration/status-observation.test.ts`:

```ts
/**
 * The hourly status observation, driven through the real `JobRunner` against the real
 * queue, the S3 test endpoint and the clamd double: the migration seeds it, the runner
 * reaches the handler, each observation is recorded, and the schedule re-arms under the
 * job's own lease.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatedJobs } from '../../.duefold/generated/jobs.ts';
import { JobRunner } from '../../apps/worker/src/runner.ts';
import {
  createHandler,
  type StatusObserveDependencies,
} from '../../modules/rooms-documents/src/jobs/status-observe.ts';
import { createClamAvClient } from '../../modules/rooms-documents/src/scanning/clamav.ts';
import { workerStorageConfig } from '../../modules/rooms-documents/src/storage/s3-compatible.ts';
import { createStorageStatusProbe } from '../../modules/rooms-documents/src/storage/status-probe.ts';
import { closePools, migrationPool, resetSchema, workerPool } from '../authz/support/database.ts';
import { startClamAvTestEndpoint } from '../support/clamav-endpoint.ts';
import { startS3TestEndpoint } from '../support/s3-endpoint.ts';

const endpoints: { close(): Promise<void> }[] = [];

beforeAll(resetSchema);
afterAll(async () => {
  for (const endpoint of endpoints) await endpoint.close();
  await closePools();
});

async function storage(options: Parameters<typeof startS3TestEndpoint>[0] = {}) {
  const endpoint = await startS3TestEndpoint(options);
  endpoints.push(endpoint);
  return createStorageStatusProbe(
    workerStorageConfig({
      endpoint: endpoint.endpoint,
      region: 'us-east-1',
      bucket: endpoint.bucket,
      credentials: {
        accessKeyId: endpoint.accessKeyId,
        secretAccessKey: endpoint.secretAccessKey,
      },
      pathStyle: true,
      checksumSupport: false,
    }),
  );
}

async function scanner(options: Parameters<typeof startClamAvTestEndpoint>[0]) {
  const endpoint = await startClamAvTestEndpoint(options);
  endpoints.push(endpoint);
  return createClamAvClient({
    socket: { host: endpoint.host, port: endpoint.port },
    timeoutMilliseconds: 5_000,
  });
}

async function observe(dependencies: Omit<StatusObserveDependencies, 'pool'>): Promise<void> {
  await migrationPool.query(
    `UPDATE job_queue SET available_at=statement_timestamp()-interval '1 minute'
      WHERE job_type='status.observe' AND state='pending'`,
  );
  const runner = new JobRunner(
    workerPool,
    new Map([['status.observe', createHandler({ pool: workerPool, ...dependencies })]]),
  );
  expect(await runner.runOne()).toBe(true);
}

async function observations() {
  return (
    await migrationPool.query<{
      check_name: string;
      result: string;
      code: string;
      evidence_at: Date | null;
    }>('SELECT check_name,result,code,evidence_at FROM deployment_status_observation ORDER BY check_name')
  ).rows;
}

describe('the status observation job', () => {
  it('is declared as a rooms-documents worker job under the id the migration seeds', () => {
    const declared = generatedJobs.find(({ id }) => id === 'status.observe');
    expect(declared).toMatchObject({ id: 'status.observe', module: 'rooms-documents' });
    expect(typeof declared?.handlerFactory).toBe('function');
  });

  it('is queued by the migration an hour out, so no deployment step arms it', async () => {
    const rows = (
      await migrationPool.query<{ state: string; idempotency_key: string; available_at: Date }>(
        "SELECT state,idempotency_key,available_at FROM job_queue WHERE job_type='status.observe'",
      )
    ).rows;
    expect(rows.map(({ state, idempotency_key }) => ({ state, idempotency_key }))).toStrictEqual([
      { state: 'pending', idempotency_key: 'status-observe:initial' },
    ]);
    expect(rows[0]?.available_at.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it('records storage privacy, versioning and current signatures with their build time', async () => {
    /* clamd's VERSION reply carries whole seconds. */
    const built = new Date(Math.floor(Date.now() / 1_000) * 1_000 - 3_600_000);
    await observe({
      storageProbe: await storage(),
      scanner: await scanner({ signatureDate: built }),
    });
    expect(await observations()).toStrictEqual([
      { check_name: 'scanner', result: 'pass', code: 'SIGNATURES_CURRENT', evidence_at: built },
      {
        check_name: 'storage-privacy',
        result: 'pass',
        code: 'ANONYMOUS_ACCESS_REFUSED',
        evidence_at: null,
      },
      {
        check_name: 'storage-versioning',
        result: 'pass',
        code: 'VERSIONING_ENABLED',
        evidence_at: null,
      },
    ]);
  });

  it('queues exactly one successor, an hour out', async () => {
    const pending = (
      await migrationPool.query<{ available_at: Date }>(
        "SELECT available_at FROM job_queue WHERE job_type='status.observe' AND state='pending'",
      )
    ).rows;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.available_at.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it('answers each dependency on its own, so one failure hides nothing', async () => {
    await observe({
      storageProbe: await storage({ versioning: 'not-implemented' }),
      scanner: await scanner({ signatureDate: new Date(), disconnectDuring: 'version' }),
    });
    expect(
      (await observations()).map(({ check_name, code, evidence_at }) => ({
        check_name,
        code,
        evidence_at,
      })),
    ).toStrictEqual([
      { check_name: 'scanner', code: 'SCANNER_UNAVAILABLE', evidence_at: null },
      { check_name: 'storage-privacy', code: 'ANONYMOUS_ACCESS_REFUSED', evidence_at: null },
      { check_name: 'storage-versioning', code: 'VERSIONING_NOT_DETECTABLE', evidence_at: null },
    ]);
  });

  it('reports stale signatures as failing and keeps their build time', async () => {
    const built = new Date(Math.floor(Date.now() / 1_000) * 1_000 - 3 * 86_400_000);
    await observe({
      storageProbe: await storage({ versioning: 'Suspended' }),
      scanner: await scanner({ signatureDate: built }),
    });
    expect(await observations()).toContainEqual({
      check_name: 'scanner',
      result: 'fail',
      code: 'SIGNATURES_STALE',
      evidence_at: built,
    });
    expect(await observations()).toContainEqual({
      check_name: 'storage-versioning',
      result: 'attention',
      code: 'VERSIONING_SUSPENDED',
      evidence_at: null,
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx vitest run --project unit --maxWorkers=2 status-probe status-observe
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2 test/integration/status-observation.test.ts
```

Expected: FAIL — `status-probe.ts` and `status-observe.ts` do not exist; `status.observe` is not declared.

- [ ] **Step 4: Give the scanner client an unjudged read**

In `modules/rooms-documents/src/scanning/clamav.ts`, add after `MAX_SIGNATURE_AGE_MILLISECONDS`:

```ts
/** Whether signatures built at `signatureDate` are young enough to scan with. */
export function signaturesCurrent(
  signatureDate: Date,
  now: Date,
  maximumAgeMilliseconds: number = MAX_SIGNATURE_AGE_MILLISECONDS,
): boolean {
  const age = now.getTime() - signatureDate.getTime();
  return age >= 0 && age <= maximumAgeMilliseconds;
}
```

Replace `checkReady` inside `createClamAvClient` with the pair below, and return `{ checkReady, readSignatures, scan }`:

```ts
  /** The signatures clamd reports, without judging their age. */
  async function readSignatures(): Promise<{
    readonly signatureVersion: string;
    readonly signatureDate: Date;
  }> {
    const result = version(await command(options, Buffer.from('zVERSION\0')));
    return { signatureVersion: result.signatureVersion, signatureDate: result.date };
  }
  async function checkReady(): Promise<{
    readonly signatureVersion: string;
    readonly signatureDate: Date;
  }> {
    const signatures = await readSignatures();
    const now = (options.now ?? (() => new Date()))();
    if (
      !signaturesCurrent(
        signatures.signatureDate,
        now,
        options.maximumSignatureAgeMilliseconds ?? MAX_SIGNATURE_AGE_MILLISECONDS,
      )
    )
      throw new Error('SCANNER_SIGNATURES_STALE');
    return signatures;
  }
```

`ClamAvClient` is `ReturnType<typeof createClamAvClient>`, so the branding lifecycle test's hand-written scanner (`test/integration/branding-lifecycle.test.ts:125`) needs the new member. Add beside its `checkReady`:

```ts
        readSignatures: () =>
          Promise.resolve({ signatureVersion: 'fixture', signatureDate: new Date() }),
```

- [ ] **Step 5: Write the storage probe**

In `modules/rooms-documents/src/storage/s3-compatible.ts`, rename `function createClient(config: StorageConfig): S3Client` to `export function createStorageClient(config: StorageConfig): S3Client` and update its three callers in that file (`createWebStorage`, `createDeliveryStorage`, `createWorkerStorage`). `git grep -n "createClient(" modules/rooms-documents/src/storage` must return nothing afterwards.

Create `modules/rooms-documents/src/storage/status-probe.ts`:

```ts
/**
 * What the worker can observe about the bucket without writing to it.
 *
 * Privacy: two unauthenticated requests to the S3 API — one for a random key, one for a
 * listing — must both be refused. A 404 for the key means the API tells strangers what
 * exists, which is public read. Only the API endpoint is reachable from here: a public URL a
 * provider serves outside it (R2's `r2.dev` domain, a CDN) is invisible to this check, and
 * the status surface says so.
 *
 * Versioning: asked with the worker credential. A provider that does not implement the call,
 * or a credential not permitted to make it, reads as not detectable, never as enabled.
 */
import { GetBucketVersioningCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { createOpaqueId } from '@duefold/shared/ids';
import type {
  StoragePrivacyCode,
  StorageVersioningCode,
} from '../../../core-security/src/status-observations.ts';
import { createStorageClient, type WorkerStorageConfig } from './s3-compatible.ts';

export interface StorageStatusProbe {
  privacy(): Promise<StoragePrivacyCode>;
  versioning(): Promise<StorageVersioningCode>;
}

const PROBE_TIMEOUT_MILLISECONDS = 10_000;
/* Forbidden, method not allowed, not implemented: the question cannot be answered here. */
const UNANSWERABLE = new Set([403, 405, 501]);

export function anonymousAccessCode(objectStatus: number, listStatus: number): StoragePrivacyCode {
  if (listStatus === 200) return 'ANONYMOUS_LIST_ALLOWED';
  if (objectStatus === 200 || objectStatus === 404) return 'ANONYMOUS_READ_ALLOWED';
  const refused = (status: number): boolean => status === 401 || status === 403;
  return refused(objectStatus) && refused(listStatus)
    ? 'ANONYMOUS_ACCESS_REFUSED'
    : 'STORAGE_PROBE_INCONCLUSIVE';
}

export function versioningCode(status: string | undefined): StorageVersioningCode {
  if (status === 'Enabled') return 'VERSIONING_ENABLED';
  if (status === 'Suspended') return 'VERSIONING_SUSPENDED';
  return 'VERSIONING_NEVER_ENABLED';
}

/** The bucket's S3 API address for `key`, addressed the way the adapter is configured. */
export function bucketUrl(
  config: Pick<WorkerStorageConfig, 'endpoint' | 'bucket' | 'pathStyle'>,
  key: string,
): URL {
  const url = new URL(config.endpoint);
  const base = url.pathname.replace(/\/+$/u, '');
  if (config.pathStyle) url.pathname = `${base}/${config.bucket}/${key}`;
  else {
    url.hostname = `${config.bucket}.${url.hostname}`;
    url.pathname = `${base}/${key}`;
  }
  return url;
}

export function createStorageStatusProbe(
  config: WorkerStorageConfig,
  fetchImpl: typeof fetch = fetch,
): StorageStatusProbe {
  const client = createStorageClient(config);
  const anonymousStatus = async (url: URL, method: 'HEAD' | 'GET'): Promise<number> =>
    (
      await fetchImpl(url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS),
      })
    ).status;
  return {
    async privacy() {
      const object = bucketUrl(config, `status-probe/${createOpaqueId()}`);
      const listing = bucketUrl(config, '');
      listing.search = '?list-type=2&max-keys=1';
      try {
        const [objectStatus, listStatus] = await Promise.all([
          anonymousStatus(object, 'HEAD'),
          anonymousStatus(listing, 'GET'),
        ]);
        return anonymousAccessCode(objectStatus, listStatus);
      } catch (error: unknown) {
        /* fetch rejects with a TypeError when the endpoint cannot be reached, and the timeout
           aborts with a TimeoutError. Anything else is a fault, not an answer. */
        if (
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === 'TimeoutError')
        )
          return 'STORAGE_UNREACHABLE';
        throw error;
      }
    },
    async versioning() {
      try {
        const answer = await client.send(
          new GetBucketVersioningCommand({ Bucket: config.bucket }),
          { abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MILLISECONDS) },
        );
        return versioningCode(answer.Status);
      } catch (error: unknown) {
        return error instanceof S3ServiceException &&
          UNANSWERABLE.has(error.$metadata.httpStatusCode ?? 0)
          ? 'VERSIONING_NOT_DETECTABLE'
          : 'STORAGE_UNREACHABLE';
      }
    },
  };
}
```

- [ ] **Step 6: Write the job and declare it**

Create `modules/rooms-documents/src/jobs/status-observe.ts`:

```ts
/**
 * The hourly observation of what only the worker can see: whether the bucket refuses
 * strangers, whether it keeps versions, and how old the scanner's signatures are.
 *
 * Self-rescheduling like `ownership.preview.purge`: the next run is queued inside the lease
 * that performed this one, so a crashed worker does not end the schedule and a lost lease
 * cannot start a second one.
 */
import type { Pool } from 'pg';
import { createOpaqueId } from '@duefold/shared/ids';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';
import {
  recordWorkerObservation,
  type WorkerObservation,
} from '../../../core-security/src/status-observations.ts';
import { signaturesCurrent, type ClamAvClient } from '../scanning/clamav.ts';
import type { StorageStatusProbe } from '../storage/status-probe.ts';

export interface StatusObserveDependencies {
  readonly pool: Pool;
  readonly storageProbe: StorageStatusProbe;
  readonly scanner: Pick<ClamAvClient, 'readSignatures'>;
}

export async function scannerObservation(
  scanner: Pick<ClamAvClient, 'readSignatures'>,
  now: Date,
): Promise<Extract<WorkerObservation, { readonly check: 'scanner' }>> {
  let signatureDate: Date;
  try {
    ({ signatureDate } = await scanner.readSignatures());
  } catch {
    /* Unreachable, timed out, or an unreadable reply: in each case it cannot scan. */
    return { check: 'scanner', code: 'SCANNER_UNAVAILABLE', signaturesBuiltAt: null };
  }
  return {
    check: 'scanner',
    code: signaturesCurrent(signatureDate, now) ? 'SIGNATURES_CURRENT' : 'SIGNATURES_STALE',
    signaturesBuiltAt: signatureDate,
  };
}

export function createHandler(dependencies: StatusObserveDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const [privacy, versioning, scanner] = await Promise.all([
      dependencies.storageProbe.privacy(),
      dependencies.storageProbe.versioning(),
      scannerObservation(dependencies.scanner, new Date()),
    ]);
    await recordWorkerObservation(dependencies.pool, { check: 'storage-privacy', code: privacy });
    await recordWorkerObservation(dependencies.pool, {
      check: 'storage-versioning',
      code: versioning,
    });
    await recordWorkerObservation(dependencies.pool, scanner);
    await context.assertLease();
    const scheduled = await dependencies.pool.query(
      `INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
       SELECT $4,'status.observe','status-observe:'||$1,'{}'::jsonb,
         statement_timestamp()+interval '1 hour',10
       FROM job_queue j WHERE j.id=$1 AND j.state='running' AND j.lease_owner=$2
         AND j.lease_token=$3 AND j.lease_expires_at>statement_timestamp()`,
      [job.id, context.leaseOwner, job.lease_token, createOpaqueId()],
    );
    if (scheduled.rowCount !== 1) throw new Error('JOB_LEASE_LOST');
  };
}
```

Append to `modules/rooms-documents/migrations/025_content_status.sql`:

```sql
-- The status observation job, seeded once and due an hour after migration; each run queues
-- the next under its own lease.
INSERT INTO job_queue(id,job_type,idempotency_key,payload,available_at,max_attempts)
VALUES(replace(gen_random_uuid()::text,'-',''),'status.observe','status-observe:initial',
       '{}'::jsonb,statement_timestamp()+interval '1 hour',10);
```

In `modules/rooms-documents/src/declaration.ts`, add after the `export.cleanup` job:

```ts
    {
      id: 'status.observe',
      handler: 'jobs/status-observe.ts',
      handlerFactoryExport: 'createHandler',
      service: 'worker',
    },
```

- [ ] **Step 7: Wire the worker**

In `apps/worker/src/runner.ts`, import the dependency type and add it to both `rooms-documents` intersections (`JobHandlerDependencies.roomsDocuments` and the second member of `JobHandlerFactory`'s union):

```ts
import type { StatusObserveDependencies } from '../../../modules/rooms-documents/src/jobs/status-observe.ts';
```

```ts
    RoomPurgeDependencies &
    StatusObserveDependencies;
```

In `apps/worker/src/main.ts`, build the storage configuration once and give both consumers the same one:

```ts
import { createStorageStatusProbe } from '../../../modules/rooms-documents/src/storage/status-probe.ts';
```

```ts
  const storageConfig = workerStorageConfig({
    endpoint: stringConfig(config, 'DUEFOLD_STORAGE_ENDPOINT'),
    region: stringConfig(config, 'DUEFOLD_STORAGE_REGION'),
    bucket: stringConfig(config, 'DUEFOLD_STORAGE_BUCKET'),
    credentials: {
      accessKeyId: stringConfig(config, 'DUEFOLD_STORAGE_WORKER_ACCESS_KEY_ID'),
      secretAccessKey: stringConfig(config, 'DUEFOLD_STORAGE_WORKER_SECRET_ACCESS_KEY'),
    },
    pathStyle: config['DUEFOLD_STORAGE_PATH_STYLE'] === true,
    checksumSupport: config['DUEFOLD_STORAGE_CHECKSUM_SUPPORT'] === true,
  });
```

and in `roomsDocuments`:

```ts
      storage: createWorkerStorage(storageConfig),
      storageProbe: createStorageStatusProbe(storageConfig),
```

- [ ] **Step 8: Let the S3 double answer versioning**

In `test/support/s3-endpoint.ts`, give `startS3TestEndpoint` an options parameter:

```ts
export interface S3TestEndpointOptions {
  /** What `GetBucketVersioning` answers. A bucket with versioning enabled by default. */
  readonly versioning?: 'Enabled' | 'Suspended' | 'absent' | 'not-implemented';
}

export async function startS3TestEndpoint(
  options: S3TestEndpointOptions = {},
): Promise<S3TestEndpoint> {
  const versioning = options.versioning ?? 'Enabled';
```

and answer the bucket-level request immediately after the `authorized(...)` refusal and before `keyFrom`, which only recognises `/<bucket>/<key>`:

```ts
      if (request.method === 'GET' && url.searchParams.has('versioning')) {
        if (versioning === 'not-implemented') {
          xml(response, 501, '<Error><Code>NotImplemented</Code></Error>');
          return;
        }
        xml(
          response,
          200,
          versioning === 'absent'
            ? '<VersioningConfiguration></VersioningConfiguration>'
            : `<VersioningConfiguration><Status>${versioning}</Status></VersioningConfiguration>`,
        );
        return;
      }
```

Existing callers pass no options and behave as before.

- [ ] **Step 9: Run the tests to verify they pass**

```bash
npm run compose
npx vitest run --project unit --maxWorkers=2 status-probe status-observe processing
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2 test/integration/status-observation.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2 test/integration/private-content.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2 test/integration/branding-lifecycle.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2 test/integration/ownership-preview-sweep.test.ts
npm run typecheck && npm run lint
wc -l apps/worker/src/runner.ts
```

Expected: PASS; `runner.ts` at most 260 lines. The private-content and branding suites prove the scanner and storage refactors changed nothing; the preview sweep suite proves the new seed does not jump its queue.

- [ ] **Step 10: Commit**

```bash
git add modules/rooms-documents apps/worker test/support/s3-endpoint.ts test/integration/status-observation.test.ts test/integration/branding-lifecycle.test.ts
git commit -m "Observe storage privacy, versioning and scanner signatures hourly"
```

---

### Task 4: The status routes

**Files:**
- Create: `apps/web/src/deployment-facts.ts`
- Modify: `apps/web/src/runtime.ts` (`deployment` field), `apps/web/src/main.ts` (runtime object), `apps/web/src/app.ts` (`ROUTE_FACTORIES`, `memberFactory` ids)
- Modify: `test/support/web-runtime.ts`, `test/support/browser-server.ts` (runtime objects)
- Create: `modules/core-security/src/routes/deployment-status.ts`
- Create: `modules/rooms-documents/src/routes/content-status.ts`
- Modify: `modules/core-security/src/declaration.ts`, `modules/rooms-documents/src/declaration.ts` (routes)
- Create: `docs/installation-status-http-contract.md`
- Modify: `CODEBASE_MAP.md`, `modules/core-security/README.md`, `modules/rooms-documents/README.md`
- Test: `test/authz/installation-status-routes.test.ts`

**Interfaces:**
- Consumes: `readDeploymentStatus`, `DeploymentFacts`, `applicationVersion` (Task 1); `readContentStatus` (Task 2); `protectedErrorResponses` (`error-envelope.ts`); `composedManifest`, `generatedMigrations` (`.duefold/generated`); `discoverOidc` (`modules/core-security/src/auth/oidc.ts`).
- Produces:
  - `WebRuntime.deployment: DeploymentFacts`; `composedDeploymentFacts(oidcDiscoveryConformedAt: Date): DeploymentFacts` in `apps/web/src/deployment-facts.ts`.
  - `GET /api/status` (route id `installation.status.read`) → `DeploymentStatus`.
  - `GET /api/status/content` (route id `installation.content.read`) → `ContentStatus`.

The status route answers what this process was built from, so it needs the composed manifest and migration registry. A module never imports the generated registries; the web entry point already does, so it builds `DeploymentFacts` once and hands them over through `WebRuntime`, as it does the readiness checks. The entry point also knows when OIDC discovery passed: `discoverOidc` runs before anything is served, so the instant just after it returns is the conformance time the surface reports.

- [ ] **Step 1: Write the failing tests**

Create `test/authz/installation-status-routes.test.ts`:

```ts
/**
 * `GET /api/status` and `GET /api/status/content` through the real app and real sessions.
 * Neither handler branches on role; every refusal is PostgreSQL's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpaqueId } from '@duefold/shared/ids';
import { composedManifest } from '../../.duefold/generated/manifest.ts';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { generatedRoutes } from '../../.duefold/generated/routes.ts';
import { acknowledgeBackupStatus } from '../../apps/cli/src/lifecycle.ts';
import { applicationVersion } from '../../modules/core-security/src/release.ts';
import { testWebRuntime } from '../support/web-runtime.ts';
import { closePools, migrationPool, workerPool } from './support/database.ts';
import { app, headers, memberSession, viewerCookie } from './support/route-fixture.ts';
import { resetRoomSchema, seedMember, seedRoom, staffRoom } from './support/room-fixture.ts';

let ownerId = '';
let adminId = '';
let plainMemberId = '';
let managerId = '';
let viewerId = '';

beforeAll(async () => {
  ownerId = await resetRoomSchema('Status routes');
  adminId = await seedMember('admin', 'status.routes.admin');
  plainMemberId = await seedMember('member', 'status.routes.plain');
  managerId = await seedMember('member', 'status.routes.manager');
  await staffRoom(managerId, await seedRoom(ownerId, 'Status routes room'), 'manager', ownerId);
  viewerId = createOpaqueId();
  await migrationPool.query(
    'INSERT INTO viewer (id,email_key,email_display,session_family_id) VALUES ($1,$2,$2,$3)',
    [viewerId, 'status.viewer@example.test', createOpaqueId()],
  );
});
afterAll(closePools);

async function read(url: string, memberId: string) {
  const instance = await app();
  const response = await instance.inject({
    method: 'GET',
    url,
    headers: headers(await memberSession(memberId), false),
  });
  await instance.close();
  return response;
}

const PATHS = ['/api/status', '/api/status/content'] as const;

describe('status route declarations', () => {
  it('declares both routes member-audience, without CSRF, with the validated error envelope', () => {
    for (const [id, path] of [
      ['installation.status.read', '/api/status'],
      ['installation.content.read', '/api/status/content'],
    ] as const) {
      const route = generatedRoutes.find((entry) => entry.id === id);
      expect(route).toMatchObject({ method: 'GET', path, audience: 'member', csrf: false });
      const responses = (route?.schema as { readonly response: Record<string, unknown> })
        .response;
      for (const status of [400, 401, 403, 409, 500])
        expect(responses[String(status)], `${id} ${status}`).toBeDefined();
    }
  });
});

describe.each(PATHS)('GET %s', (url) => {
  it('denies an unauthenticated request and a viewer session', async () => {
    const instance = await app();
    expect((await instance.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(
      (await instance.inject({ method: 'GET', url, headers: await viewerCookie(viewerId) }))
        .statusCode,
    ).toBe(401);
    await instance.close();
  });

  it.each([
    ['plain Member', () => plainMemberId],
    ['Room Manager', () => managerId],
  ])('refuses a %s with the uniform 403', async (_label, actor) => {
    const response = await read(url, actor());
    expect(response.statusCode).toBe(403);
    expect(response.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
  });
});

describe('GET /api/status', () => {
  it.each([
    ['Owner', () => ownerId],
    ['Admin', () => adminId],
  ])('answers %s with the composition this process was built from', async (_label, actor) => {
    const response = await read('/api/status', actor());
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      application: unknown;
      oidc: { readonly discoveryConformedAt: string };
      migrations: unknown;
      checks: readonly { readonly check: string; readonly observation: unknown }[];
    }>();
    expect(body.application).toStrictEqual({
      version: applicationVersion(),
      modules: [...composedManifest.modules],
      adapters: { ...composedManifest.adapters },
    });
    const registry = generatedMigrations.map(({ id }) => id).sort();
    expect(body.migrations).toStrictEqual({
      state: 'current',
      appliedCount: registry.length,
      expectedCount: registry.length,
      latestApplied: registry.at(-1),
    });
    expect(Number.isNaN(Date.parse(body.oidc.discoveryConformedAt))).toBe(false);
    expect(body.checks.map(({ check }) => check)).toStrictEqual([
      'storage-privacy',
      'storage-versioning',
      'scanner',
      'updates',
    ]);
  });

  it('reads an offered release that is now running as current', async () => {
    await migrationPool.query('SELECT record_update_observation($1,$2,$3)', [
      'attention',
      'UPDATE_AVAILABLE',
      applicationVersion(),
    ]);
    const body = (await read('/api/status', ownerId)).json<{
      checks: readonly { readonly check: string; readonly observation: unknown }[];
    }>();
    expect(body.checks.find(({ check }) => check === 'updates')?.observation).toMatchObject({
      result: 'pass',
      code: 'UPDATE_CURRENT',
      evidenceVersion: null,
    });
  });

  it('reports an observation with its evidence and whether it is stale', async () => {
    const built = new Date(Math.floor(Date.now() / 1_000) * 1_000 - 2 * 86_400_000);
    await workerPool.query('SELECT record_worker_status_observation($1,$2,$3,$4)', [
      'scanner',
      'fail',
      'SIGNATURES_STALE',
      built,
    ]);
    const body = (await read('/api/status', ownerId)).json<{
      checks: readonly { readonly check: string; readonly observation: unknown }[];
    }>();
    expect(body.checks.find(({ check }) => check === 'scanner')?.observation).toMatchObject({
      result: 'fail',
      code: 'SIGNATURES_STALE',
      evidenceAt: built.toISOString(),
      evidenceVersion: null,
      stale: false,
    });
  });

  it('carries none of the values this process was configured with', async () => {
    const configured = testWebRuntime();
    const body = (await read('/api/status', ownerId)).body;
    for (const value of [
      process.env['DUEFOLD_TEST_DATABASE_URL'],
      process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'],
      configured.oidc.serverMetadata().issuer,
      configured.oidcRedirectUri,
      configured.organizationName,
      configured.otpDigestKey,
      configured.networkHmacKey,
    ])
      if (value !== undefined) expect(body).not.toContain(value);
    expect(body).not.toContain('@');
  });
});

describe('GET /api/status/content', () => {
  it('answers an Owner with the recovery record, as the CLI changes it', async () => {
    expect((await read('/api/status/content', ownerId)).json()).toStrictEqual({
      processing: { failedCount: 0 },
      recovery: {
        backupStatus: 'undetermined',
        backupRetention: null,
        recoveryExpectation: null,
        acknowledgedAt: null,
        restoreDrillStatus: 'not-tested',
        restoreDrillAt: null,
      },
    });
    await acknowledgeBackupStatus(migrationPool, {
      retention: '35 days point-in-time recovery',
      expectation: 'Restore within four hours to the last hour',
    });
    const recovery = (
      await read('/api/status/content', adminId)
    ).json<{ recovery: Record<string, unknown> }>().recovery;
    expect(recovery).toMatchObject({
      backupStatus: 'operator-acknowledged',
      backupRetention: '35 days point-in-time recovery',
      recoveryExpectation: 'Restore within four hours to the last hour',
    });
    expect(typeof recovery['acknowledgedAt']).toBe('string');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/installation-status-routes.test.ts
```

Expected: FAIL — `/api/status` and `/api/status/content` are 404.

- [ ] **Step 3: Hand the web process its build facts**

Create `apps/web/src/deployment-facts.ts`:

```ts
/** The composition this process was built from, as the status surface reports it. */
import { composedManifest } from '../../../.duefold/generated/manifest.ts';
import { generatedMigrations } from '../../../.duefold/generated/migrations.ts';
import type { DeploymentFacts } from '../../../modules/core-security/src/deployment-status.ts';
import { applicationVersion } from '../../../modules/core-security/src/release.ts';

export function composedDeploymentFacts(oidcDiscoveryConformedAt: Date): DeploymentFacts {
  return {
    applicationVersion: applicationVersion(),
    modules: [...composedManifest.modules],
    adapters: { ...composedManifest.adapters },
    expectedMigrationIds: generatedMigrations.map(({ id }) => id),
    oidcDiscoveryConformedAt: oidcDiscoveryConformedAt.toISOString(),
  };
}
```

In `apps/web/src/runtime.ts`, import `type DeploymentFacts` from `'../../../modules/core-security/src/deployment-status.ts'` and add to `WebRuntime`:

```ts
  /** What this process was built from, for the status surface. */
  readonly deployment: DeploymentFacts;
```

In `apps/web/src/main.ts`, capture the instant discovery passed immediately after the `discoverOidc` call and before `startupStage = 'database'`:

```ts
  const oidcDiscoveryConformedAt = new Date();
```

and add `deployment: composedDeploymentFacts(oidcDiscoveryConformedAt),` to the runtime object after `authPool`. In `testWebRuntime` (`test/support/web-runtime.ts`, before `...overrides`) and in `test/support/browser-server.ts` (after `authPool`) add `deployment: composedDeploymentFacts(new Date()),`. Each file imports `composedDeploymentFacts` from `apps/web/src/deployment-facts.ts`; `browser-server.ts` grows by exactly these two lines.

- [ ] **Step 4: Add the routes**

Create `modules/core-security/src/routes/deployment-status.ts`:

```ts
import { Type } from '@sinclair/typebox';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../authorization.ts';
import { readDeploymentStatus } from '../deployment-status.ts';
import { protectedErrorResponses } from './error-envelope.ts';

const COUNT = Type.Integer({ minimum: 0 });
const INSTANT = Type.String({ format: 'date-time' });
const NAME = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' });
const RELEASE = Type.String({ pattern: '^[0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6}$' });
const closed = { additionalProperties: false } as const;

const OBSERVATION = Type.Object(
  {
    result: Type.Union([Type.Literal('pass'), Type.Literal('attention'), Type.Literal('fail')]),
    code: Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' }),
    evidenceAt: Type.Union([INSTANT, Type.Null()]),
    evidenceVersion: Type.Union([RELEASE, Type.Null()]),
    observedAt: INSTANT,
    stale: Type.Boolean(),
  },
  closed,
);

/**
 * What an Owner or Admin reads about this deployment. Every string is a version, a module
 * or adapter name, a migration id or a code; nothing here can carry configuration.
 */
export const schema = {
  response: {
    200: Type.Object(
      {
        application: Type.Object(
          {
            version: RELEASE,
            modules: Type.Array(NAME, { minItems: 1, maxItems: 4 }),
            adapters: Type.Object({ storage: NAME, mail: NAME, identity: NAME }, closed),
          },
          closed,
        ),
        oidc: Type.Object({ discoveryConformedAt: INSTANT }, closed),
        migrations: Type.Object(
          {
            state: Type.Union([
              Type.Literal('current'),
              Type.Literal('pending'),
              Type.Literal('unrecognized'),
            ]),
            appliedCount: COUNT,
            expectedCount: COUNT,
            latestApplied: Type.Union([
              Type.String({ pattern: '^[0-9]{3}_[a-z0-9_]{1,80}$' }),
              Type.Null(),
            ]),
          },
          closed,
        ),
        queue: Type.Object(
          {
            due: COUNT,
            running: COUNT,
            failedRecently: COUNT,
            oldestDueSeconds: Type.Union([COUNT, Type.Null()]),
          },
          closed,
        ),
        mail: Type.Object(
          { lastDeliveredAt: Type.Union([INSTANT, Type.Null()]), failedRecently: COUNT },
          closed,
        ),
        checks: Type.Array(
          Type.Object(
            {
              check: Type.Union([
                Type.Literal('storage-privacy'),
                Type.Literal('storage-versioning'),
                Type.Literal('scanner'),
                Type.Literal('updates'),
              ]),
              observation: Type.Union([OBSERVATION, Type.Null()]),
            },
            closed,
          ),
          { minItems: 4, maxItems: 4 },
        ),
      },
      closed,
    ),
    ...protectedErrorResponses(),
  },
};

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return () => readDeploymentStatus({ pool: runtime.pool, identity, facts: runtime.deployment });
}

export function handler(): never {
  throw new Error('deployment status route runtime not initialized');
}
```

Create `modules/rooms-documents/src/routes/content-status.ts`:

```ts
import { Type } from '@sinclair/typebox';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { protectedErrorResponses } from '../../../core-security/src/routes/error-envelope.ts';
import { readContentStatus } from '../content-status.ts';

const INSTANT = Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);
const TEXT = Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]);
const closed = { additionalProperties: false } as const;

export const schema = {
  response: {
    200: Type.Object(
      {
        processing: Type.Object({ failedCount: Type.Integer({ minimum: 0 }) }, closed),
        recovery: Type.Object(
          {
            backupStatus: Type.Union([
              Type.Literal('undetermined'),
              Type.Literal('operator-acknowledged'),
            ]),
            backupRetention: TEXT,
            recoveryExpectation: TEXT,
            acknowledgedAt: INSTANT,
            restoreDrillStatus: Type.Union([
              Type.Literal('not-tested'),
              Type.Literal('passed'),
              Type.Literal('failed'),
            ]),
            restoreDrillAt: INSTANT,
          },
          closed,
        ),
      },
      closed,
    ),
    ...protectedErrorResponses(),
  },
};

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return () => readContentStatus({ pool: runtime.pool, identity });
}

export function handler(): never {
  throw new Error('content status route runtime not initialized');
}
```

In `modules/core-security/src/declaration.ts`, add after `organization.members.actions`:

```ts
    {
      id: 'installation.status.read',
      method: 'GET',
      path: '/api/status',
      audience: 'member',
      handler: 'routes/deployment-status.ts',
      handlerFactoryExport: 'createHandler',
    },
```

In `modules/rooms-documents/src/declaration.ts`, add after `room.create`:

```ts
    {
      id: 'installation.content.read',
      method: 'GET',
      path: '/api/status/content',
      audience: 'member',
      handler: 'routes/content-status.ts',
      handlerFactoryExport: 'createHandler',
    },
```

In `apps/web/src/app.ts`, add both ids to `ROUTE_FACTORIES` and to `memberFactory`'s id union:

```ts
  'installation.status.read': memberFactory('installation.status.read'),
  'installation.content.read': memberFactory('installation.content.read'),
```

```ts
    | 'installation.status.read'
    | 'installation.content.read'
```

- [ ] **Step 5: Start the contract and the maps**

Create `docs/installation-status-http-contract.md`:

````markdown
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
````

In `modules/core-security/README.md`, add before `## Does not own`:

```markdown
## Installation status

- [Deployment status](src/deployment-status.ts) and [status observations](src/status-observations.ts) — build facts, OIDC startup conformance, migration state, queue, mail evidence, and the checks only the worker or the CLI can make
- [Running release](src/release.ts)
- [Status route](src/routes/deployment-status.ts), described in the [installation status HTTP contract](../../docs/installation-status-http-contract.md)
- [Status database functions](migrations/024_deployment_status.sql)
- [Status authorization suites](../../test/authz/installation-status.test.ts) and [routes](../../test/authz/installation-status-routes.test.ts)
```

In `modules/rooms-documents/README.md`, add to `## Start here`:

```markdown
- [Content status](src/content-status.ts), [status route](src/routes/content-status.ts), [storage status probe](src/storage/status-probe.ts) and [status observation job](src/jobs/status-observe.ts) — failed processing, the recovery record, and the hourly storage and scanner observations for the installation status surface.
```

In `CODEBASE_MAP.md`, add a row after "Organization members, …":

```markdown
| Installation status and installation settings | [core-security installation status](modules/core-security/README.md#installation-status), [rooms-documents](modules/rooms-documents/README.md), [participants-access](modules/participants-access/README.md) | [installation status HTTP contract](docs/installation-status-http-contract.md) | [status authorization](test/authz/installation-status.test.ts), [status routes](test/authz/installation-status-routes.test.ts), [status observation job](test/integration/status-observation.test.ts) |
```

and add the contract to `## Canonical documents`:

```markdown
- [Installation status HTTP contract](docs/installation-status-http-contract.md)
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run compose
npx vitest run --project unit --maxWorkers=2 test/unit/codebase-map.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/installation-status-routes.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/security-routes.test.ts
npm run typecheck && npm run lint
npm run compose:verify && npm run compose:verify:minimal && npm run compose
wc -l test/support/browser-server.ts
```

Expected: PASS; `browser-server.ts` is 1057 lines.

- [ ] **Step 7: Commit**

```bash
git add modules/core-security modules/rooms-documents apps/web test/support test/authz/installation-status-routes.test.ts docs/installation-status-http-contract.md CODEBASE_MAP.md
git commit -m "Serve the deployment and content status to Owners and Admins"
```

---

### Task 5: The update check records its answer

**Files:**
- Modify: `apps/cli/src/lifecycle.ts` (add `updateObservation`), `apps/cli/src/lifecycle.unit.test.ts`
- Modify: `apps/cli/src/main.ts` (`updates check-file` records and needs the database)
- Modify: `test/authz/support/database.ts` (export the migration connection string it already uses)
- Modify: `docs/self-hosting.md` (command table, Upgrade)
- Test: `test/integration/cli-status-observations.test.ts`

**Interfaces:**
- Consumes: `verifyReleaseManifest`, `ReleaseManifest` (`lifecycle.ts`); `compareReleaseVersions`, `applicationVersion` (`release.ts`, Task 1); `recordUpdateObservation`, `observationResult`, `UpdateObservation` (Task 1).
- Produces: `updateObservation(raw: string, publicKeyPem: string, runningVersion: string): UpdateObservation`; `migrationDatabaseUrl` exported from `test/authz/support/database.ts`.

`updates check-file` already runs through the `migrate` service with the migration credential (`docs/self-hosting.md`, Upgrade), which is the credential `record_update_observation` accepts. A manifest that fails verification is recorded as unverified and fails the command, as today it fails it by throwing; a newer release carrying a security advisory also fails the command, so a deployment gate stops on it.

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/src/lifecycle.unit.test.ts` (and add `updateObservation` to its import from `./lifecycle.ts`):

```ts
describe('updateObservation', () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' });
  const signed = (version: string, securityAdvisory = false): string => {
    const payload = {
      version,
      webImageDigest: `sha256:${'a'.repeat(64)}`,
      workerImageDigest: `sha256:${'b'.repeat(64)}`,
      securityAdvisory,
    };
    const signature = sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString(
      'base64url',
    );
    return JSON.stringify({ ...payload, signature });
  };

  it('is current when the manifest offers this release or an older one', () => {
    expect(updateObservation(signed('1.4.0'), publicKey, '1.4.0')).toStrictEqual({
      code: 'UPDATE_CURRENT',
      offeredVersion: null,
    });
    expect(updateObservation(signed('1.3.9'), publicKey, '1.4.0').code).toBe('UPDATE_CURRENT');
  });

  it('names a newer release', () => {
    expect(updateObservation(signed('1.5.0'), publicKey, '1.4.0')).toStrictEqual({
      code: 'UPDATE_AVAILABLE',
      offeredVersion: '1.5.0',
    });
  });

  it('marks a newer release that carries a security advisory', () => {
    expect(updateObservation(signed('1.5.0', true), publicKey, '1.4.0')).toStrictEqual({
      code: 'SECURITY_ADVISORY',
      offeredVersion: '1.5.0',
    });
  });

  it('records a tampered or unreadable manifest as unverified rather than trusting it', () => {
    const original = JSON.parse(signed('1.5.0')) as Record<string, unknown>;
    const tampered = JSON.stringify({ ...original, version: '9.0.0' });
    expect(updateObservation(tampered, publicKey, '1.4.0')).toStrictEqual({
      code: 'UPDATE_MANIFEST_UNVERIFIED',
      offeredVersion: null,
    });
    expect(updateObservation('not a manifest', publicKey, '1.4.0').code).toBe(
      'UPDATE_MANIFEST_UNVERIFIED',
    );
  });

  it('does not order a release it cannot read', () => {
    expect(updateObservation(signed('2.0.0-rc.1'), publicKey, '1.4.0')).toStrictEqual({
      code: 'UPDATE_VERSION_UNRECOGNIZED',
      offeredVersion: null,
    });
  });
});
```

In `test/authz/support/database.ts`, lift the migration pool's connection string into an export and use it for the pool:

```ts
export const migrationDatabaseUrl =
  process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'] ??
  'postgresql://duefold_migration:duefold_local_migration@127.0.0.1:5432/duefold_test';
export const migrationPool = new Pool({ connectionString: migrationDatabaseUrl, max: 4 });
```

Create `test/integration/cli-status-observations.test.ts`:

```ts
/**
 * `updates check-file` run through `runCli` as an operator runs it, recording into the real
 * database as the migration role.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../apps/cli/src/main.ts';
import { applicationVersion } from '../../modules/core-security/src/release.ts';
import {
  closePools,
  migrationDatabaseUrl,
  migrationPool,
  resetSchema,
} from '../authz/support/database.ts';

const keys = generateKeyPairSync('ed25519');
let directory = '';
let keyPath = '';
let output: string[] = [];
let previousExitCode: typeof process.exitCode;

beforeAll(async () => {
  await resetSchema();
  directory = await mkdtemp(join(tmpdir(), 'duefold-updates-'));
  keyPath = join(directory, 'release-signing-public.pem');
  await writeFile(keyPath, keys.publicKey.export({ format: 'pem', type: 'spki' }));
});
afterAll(closePools);
beforeEach(() => {
  output = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    output.push(String(line));
  });
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = previousExitCode;
});

async function manifest(version: string, securityAdvisory: boolean, tamper = false) {
  const payload = {
    version,
    webImageDigest: `sha256:${'a'.repeat(64)}`,
    workerImageDigest: `sha256:${'b'.repeat(64)}`,
    securityAdvisory,
  };
  const signature = sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString(
    'base64url',
  );
  const path = join(directory, `${version}-${String(securityAdvisory)}-${String(tamper)}.json`);
  await writeFile(
    path,
    JSON.stringify({ ...payload, ...(tamper ? { version: '99.0.0' } : {}), signature }),
  );
  return path;
}

async function checkFile(path: string): Promise<void> {
  await runCli(['updates', 'check-file', path], {
    DUEFOLD_MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    DUEFOLD_UPDATE_PUBLIC_KEY_PATH: keyPath,
  });
}

async function recorded() {
  return (
    await migrationPool.query<{ result: string; code: string; evidence_version: string | null }>(
      "SELECT result,code,evidence_version FROM deployment_status_observation WHERE check_name='updates'",
    )
  ).rows[0];
}

const newer = (): string => `${String(Number(applicationVersion().split('.')[0]) + 1)}.0.0`;

describe('updates check-file', () => {
  it('records the running release as current and exits cleanly', async () => {
    await checkFile(await manifest(applicationVersion(), false));
    expect(await recorded()).toStrictEqual({
      result: 'pass',
      code: 'UPDATE_CURRENT',
      evidence_version: null,
    });
    expect(output.join('\n')).toContain('"code":"UPDATE_CURRENT"');
    expect(process.exitCode).toBeUndefined();
  });

  it('records a newer release with a security advisory, names it, and fails the command', async () => {
    await checkFile(await manifest(newer(), true));
    expect(await recorded()).toStrictEqual({
      result: 'fail',
      code: 'SECURITY_ADVISORY',
      evidence_version: newer(),
    });
    expect(process.exitCode).toBe(1);
  });

  it('records a tampered manifest as unverified and fails the command', async () => {
    await checkFile(await manifest(newer(), false, true));
    expect(await recorded()).toStrictEqual({
      result: 'fail',
      code: 'UPDATE_MANIFEST_UNVERIFIED',
      evidence_version: null,
    });
    expect(process.exitCode).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run --project unit --maxWorkers=2 lifecycle
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2 test/integration/cli-status-observations.test.ts
```

Expected: FAIL — `updateObservation` is not exported; the command records nothing.

- [ ] **Step 3: Classify a manifest against the running release**

In `apps/cli/src/lifecycle.ts`, import `compareReleaseVersions` from `'../../../modules/core-security/src/release.ts'` and `type UpdateObservation` from `'../../../modules/core-security/src/status-observations.ts'`, and add after `verifyReleaseManifest`:

```ts
/**
 * What a signed release manifest says about the running release. A manifest that fails
 * verification is unverified, never trusted or ignored; a release this cannot order is
 * unrecognized, never guessed at.
 */
export function updateObservation(
  raw: string,
  publicKeyPem: string,
  runningVersion: string,
): UpdateObservation {
  let manifest: ReleaseManifest;
  try {
    manifest = verifyReleaseManifest(raw, publicKeyPem);
  } catch (error: unknown) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error &&
        (error.message === 'UPDATE_MANIFEST_INVALID' ||
          error.message === 'UPDATE_MANIFEST_SIGNATURE_INVALID'))
    )
      return { code: 'UPDATE_MANIFEST_UNVERIFIED', offeredVersion: null };
    throw error;
  }
  const order = compareReleaseVersions(manifest.version, runningVersion);
  if (order === null) return { code: 'UPDATE_VERSION_UNRECOGNIZED', offeredVersion: null };
  if (order <= 0) return { code: 'UPDATE_CURRENT', offeredVersion: null };
  return {
    code: manifest.securityAdvisory ? 'SECURITY_ADVISORY' : 'UPDATE_AVAILABLE',
    offeredVersion: manifest.version,
  };
}
```

A public key that cannot be read still throws: that is the operator's configuration, not the release's answer.

- [ ] **Step 4: Record it from the command**

In `apps/cli/src/main.ts`, replace `verifyReleaseManifest` with `updateObservation` in the import from `./lifecycle.ts`, add

```ts
import { applicationVersion } from '../../../modules/core-security/src/release.ts';
import {
  observationResult,
  recordUpdateObservation,
} from '../../../modules/core-security/src/status-observations.ts';
```

and replace the `updates check-file` command with:

```ts
  {
    /**
     * Verifies a signed release manifest against the running release and records the answer
     * for the status surface. An unverified manifest, or a newer release carrying a security
     * advisory, fails the command so a deployment gate stops on it.
     */
    matches: ([group, command, file, extra]) =>
      group === 'updates' &&
      command === 'check-file' &&
      file !== undefined &&
      extra === undefined,
    configKeys: [MIGRATION_URL, 'DUEFOLD_UPDATE_PUBLIC_KEY_PATH'],
    database: true,
    run: async (context) => {
      const observation = updateObservation(
        await readFile(argument(context, 2), 'utf8'),
        await readFile(requiredString(context.config, 'DUEFOLD_UPDATE_PUBLIC_KEY_PATH'), 'utf8'),
        applicationVersion(),
      );
      await recordUpdateObservation(database(context), observation);
      console.log(JSON.stringify({ check: 'updates', ...observation }));
      if (observationResult(observation.code) === 'fail') process.exitCode = 1;
    },
  },
```

- [ ] **Step 5: Tell operators**

In `docs/self-hosting.md`, change the `updates check-file <manifest>` row to:

```markdown
| `updates check-file <manifest>`                       | Verifies a release manifest against the running release and records the answer for Status. See [Upgrade](#upgrade). |
```

and replace the sentence after the Upgrade command block with:

```markdown
The command exits non-zero if the signature, payload, or public key does not verify, or if the manifest offers a newer release that carries a security advisory. It records its answer for the **Status** section, where it reads as stale after thirty days: run it whenever a release is published. After it succeeds, confirm a current tested backup, set `DUEFOLD_IMAGE_TAG` to the new version, then run:
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run --project unit --maxWorkers=2 lifecycle
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2 test/integration/cli-status-observations.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2 apps/cli/src/main.integration.test.ts
npm run typecheck && npm run lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/cli test/authz/support/database.ts test/integration/cli-status-observations.test.ts docs/self-hosting.md
git commit -m "Record the update check for the status surface"
```

---

### Task 6: The installation download default as a reviewed change (026)

**Files:**
- Create: `modules/participants-access/migrations/026_installation_settings.sql`
- Create: `modules/participants-access/src/installation-settings.ts`
- Create: `modules/participants-access/src/routes/installation.ts`, `modules/participants-access/src/routes/installation-download.ts`
- Modify: `modules/participants-access/src/declaration.ts` (routes; migrations after `023_room_settings`)
- Modify: `apps/web/src/app.ts` (`ROUTE_FACTORIES`, `memberFactory` ids)
- Modify: `docs/installation-status-http-contract.md` (append), `modules/participants-access/README.md`, `CODEBASE_MAP.md`
- Test: `test/authz/installation-download.test.ts`

**Interfaces:**
- Consumes: `assert_organization_administrator` (017); `organization.installation_download_policy`, `organization.policy_revision`, `room.download_policy`, `document.download_policy`, `protect_installation_download_policy` (007); `published_structure_entry` (004); `DownloadPolicy` (`room-settings.ts`); `protectedErrorResponses`.
- Produces:
  - SQL `read_installation_settings(p_actor_id text) RETURNS TABLE(download_policy text, policy_revision integer, inheriting_room_count integer)` — Owner/Admin.
  - SQL `dry_run_installation_download_policy(p_actor_id text, p_policy text) RETURNS jsonb` — `{currentPolicy, proposedPolicy, inheritingRoomCount, affectedDocumentCount, requiresFreshAuthentication, expectedRevision, confirmation}`, `confirmation` null when denying.
  - SQL `apply_installation_download_policy(p_actor_id text, p_policy text, p_expected_revision integer, p_oidc_authenticated_at timestamptz, p_confirmation text, p_audit_id text, p_correlation_id text) RETURNS integer`.
  - TS `readInstallationSettings`, `dryRunInstallationDownloadPolicy`, `applyInstallationDownloadPolicy`; types `InstallationSettings`, `InstallationDownloadImpact`, `InstallationDownloadChange`.
  - `GET /api/installation` (id `installation.settings.read`) → `{settings}`; `POST /api/installation/download-policy` (id `installation.download-policy`) → `{impact}` | `{revision}`.

Changing the default reaches every room without its own policy at once. Allowing is the broad direction (§9.4): a review naming the inheriting rooms and the published documents viewers can open now, the phrase `ALLOW ORIGINAL DOWNLOADS`, and a fresh sign-in. Denying is the restrictive direction, like returning a room to draft: the same review, one confirmation, no phrase, no freshness. The 007 setter loses its runtime grant, so nothing reaches the change without these rules.

The reader carries no capability object: every one of these functions refuses on the same predicate, so a successful read is the capability.

- [ ] **Step 1: Write the failing tests**

Create `test/authz/installation-download.test.ts`:

```ts
/**
 * The installation-wide download default: who may read and change it, what the review
 * counts, and the asymmetric rules for allowing and denying.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { generatedRoutes } from '../../.duefold/generated/routes.ts';
import { closePools, databasePool, migrationPool } from './support/database.ts';
import { app, headers, memberSession } from './support/route-fixture.ts';
import { resetRoomSchema, seedMember, seedRoom, staffRoom } from './support/room-fixture.ts';

let ownerId = '';
let adminId = '';
let plainMemberId = '';
let managerId = '';
let inheritingDocumentId = '';
let overriddenRoomDocumentId = '';

const fresh = () => new Date();
const stale = () => new Date(Date.now() - 20 * 60_000);

async function publishedDocument(roomId: string, override: 'allow' | 'deny' | null) {
  const documentId = createOpaqueId();
  const versionId = createOpaqueId();
  await migrationPool.query(
    'INSERT INTO document(id,room_id,display_title,created_by,download_policy) VALUES($1,$2,$3,$4,$5)',
    [documentId, roomId, 'Memorandum', ownerId, override],
  );
  await migrationPool.query(
    `INSERT INTO document_version
     (id,document_id,original_filename,object_key,declared_media_type,size_bytes,state)
     VALUES($1,$2,'memo.txt',$3,'text/plain',1,'quarantine')`,
    [versionId, documentId, `quarantine/${createOpaqueId()}/${createOpaqueId()}`],
  );
  await migrationPool.query(
    `INSERT INTO published_structure_entry
     (room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,
      order_key,source_revision,published_version_id)
     VALUES($1,$2,'document',$3,NULL,'Memorandum','',1000,1,$4)`,
    [roomId, createOpaqueId(), documentId, versionId],
  );
  return documentId;
}

const publish = (roomId: string) =>
  migrationPool.query("UPDATE room SET published_revision=1,state='published' WHERE id=$1", [
    roomId,
  ]);

beforeAll(async () => {
  ownerId = await resetRoomSchema('Installation download');
  adminId = await seedMember('admin', 'installation.admin');
  plainMemberId = await seedMember('member', 'installation.plain');
  managerId = await seedMember('member', 'installation.manager');
  /* Published and inheriting: its inheriting document is what allowing reaches. */
  const inheriting = await seedRoom(ownerId, 'Inheriting room');
  await staffRoom(managerId, inheriting, 'manager', ownerId);
  inheritingDocumentId = await publishedDocument(inheriting, null);
  await publishedDocument(inheriting, 'allow');
  await publish(inheriting);
  /* Published with its own policy: the default does not reach it. */
  const overridden = await seedRoom(ownerId, 'Overridden room');
  await migrationPool.query("UPDATE room SET download_policy='deny' WHERE id=$1", [overridden]);
  overriddenRoomDocumentId = await publishedDocument(overridden, null);
  await publish(overridden);
  /* A draft inherits, but nothing in it is reachable yet. */
  await publishedDocument(await seedRoom(ownerId, 'Draft room'), null);
});
afterAll(closePools);

const revision = async (): Promise<number> =>
  (await migrationPool.query<{ policy_revision: number }>('SELECT policy_revision FROM organization'))
    .rows[0]?.policy_revision ?? 0;

const review = (actor: string, policy: string) =>
  databasePool.query<{ impact: Record<string, unknown> }>(
    'SELECT dry_run_installation_download_policy($1,$2) AS impact',
    [actor, policy],
  );

const apply = (
  actor: string,
  policy: string,
  expected: number,
  authenticatedAt: Date | null,
  confirmation: string | null,
) =>
  databasePool.query<{ revision: number }>(
    'SELECT apply_installation_download_policy($1,$2,$3,$4,$5,$6,$7) AS revision',
    [actor, policy, expected, authenticatedAt, confirmation, createOpaqueId(), createCorrelationId()],
  );

const effective = async (documentId: string): Promise<string | undefined> =>
  (
    await migrationPool.query<{ policy: string }>(
      'SELECT resolve_document_download_policy($1) AS policy',
      [documentId],
    )
  ).rows[0]?.policy;

describe('reading the installation settings', () => {
  it.each([
    ['Owner', () => ownerId],
    ['Admin', () => adminId],
  ])('answers %s with the default and how many rooms inherit it', async (_label, actor) => {
    expect(
      (await databasePool.query('SELECT * FROM read_installation_settings($1)', [actor()])).rows,
    ).toStrictEqual([{ download_policy: 'deny', policy_revision: 1, inheriting_room_count: 2 }]);
  });

  it.each([
    ['plain Member', () => plainMemberId],
    ['Room Manager', () => managerId],
  ])('refuses a %s, before looking at anything it sent', async (_label, actor) => {
    await expect(
      databasePool.query('SELECT * FROM read_installation_settings($1)', [actor()]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(review(actor(), 'not-a-policy')).rejects.toMatchObject({ code: '42501' });
    await expect(apply(actor(), 'allow', 999, stale(), null)).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('reviewing a change', () => {
  it('names the inheriting rooms and the published documents viewers can open now', async () => {
    expect((await review(adminId, 'allow')).rows[0]?.impact).toStrictEqual({
      currentPolicy: 'deny',
      proposedPolicy: 'allow',
      inheritingRoomCount: 2,
      affectedDocumentCount: 1,
      requiresFreshAuthentication: true,
      expectedRevision: 1,
      confirmation: 'ALLOW ORIGINAL DOWNLOADS',
    });
  });

  it('refuses to review the value already held, and a value that is not a policy', async () => {
    await expect(review(adminId, 'deny')).rejects.toMatchObject({ code: '55000' });
    await expect(review(adminId, 'sometimes')).rejects.toMatchObject({ code: '22023' });
  });
});

describe('allowing original downloads installation-wide', () => {
  it('needs a fresh sign-in, the exact phrase and the current revision', async () => {
    const expected = await revision();
    await expect(
      apply(ownerId, 'allow', expected, stale(), 'ALLOW ORIGINAL DOWNLOADS'),
    ).rejects.toMatchObject({ code: '42501', message: 'fresh OIDC required' });
    await expect(apply(ownerId, 'allow', expected, fresh(), 'allow')).rejects.toMatchObject({
      code: '22023',
    });
    await expect(apply(ownerId, 'allow', expected, fresh(), null)).rejects.toMatchObject({
      code: '22023',
    });
    await expect(
      apply(ownerId, 'allow', expected + 1, fresh(), 'ALLOW ORIGINAL DOWNLOADS'),
    ).rejects.toMatchObject({ code: '40001' });
  });

  it('changes what every inheriting document resolves to, and audits it', async () => {
    const expected = await revision();
    const applied = await apply(adminId, 'allow', expected, fresh(), 'ALLOW ORIGINAL DOWNLOADS');
    expect(applied.rows[0]?.revision).toBe(expected + 1);
    expect(await effective(inheritingDocumentId)).toBe('allow');
    expect(await effective(overriddenRoomDocumentId)).toBe('deny');
    expect(
      (
        await migrationPool.query(
          `SELECT actor_id,resource_type,reason_code,detail FROM audit_event
            WHERE reason_code='INSTALLATION_DOWNLOAD_POLICY_CHANGED' ORDER BY occurred_at DESC LIMIT 1`,
        )
      ).rows[0],
    ).toStrictEqual({
      actor_id: adminId,
      resource_type: 'organization',
      reason_code: 'INSTALLATION_DOWNLOAD_POLICY_CHANGED',
      detail: { policy: 'allow', policyRevision: expected + 1 },
    });
  });
});

describe('denying original downloads installation-wide', () => {
  it('takes no phrase and no fresh sign-in, because it only removes access', async () => {
    const expected = await revision();
    await expect(
      apply(ownerId, 'deny', expected, stale(), 'ALLOW ORIGINAL DOWNLOADS'),
    ).rejects.toMatchObject({ code: '22023' });
    expect((await apply(ownerId, 'deny', expected, stale(), null)).rows[0]?.revision).toBe(
      expected + 1,
    );
    expect(await effective(inheritingDocumentId)).toBe('deny');
  });

  it('refuses a change to the value already held', async () => {
    await expect(apply(ownerId, 'deny', await revision(), fresh(), null)).rejects.toMatchObject({
      code: '55000',
    });
  });
});

describe('the setter from 007', () => {
  it('is no longer callable by the web credential', async () => {
    await expect(
      databasePool.query('SELECT set_installation_download_policy($1,$2,$3,$4,$5)', [
        ownerId,
        'allow',
        await revision(),
        createOpaqueId(),
        createCorrelationId(),
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('the installation routes', () => {
  it('declares both routes member-audience, CSRF on the change, with the error envelope', () => {
    for (const [id, method, path, csrf] of [
      ['installation.settings.read', 'GET', '/api/installation', false],
      ['installation.download-policy', 'POST', '/api/installation/download-policy', true],
    ] as const) {
      const route = generatedRoutes.find((entry) => entry.id === id);
      expect(route).toMatchObject({ method, path, audience: 'member', csrf });
      const responses = (route?.schema as { readonly response: Record<string, unknown> })
        .response;
      for (const status of [400, 401, 403, 409, 500])
        expect(responses[String(status)], `${id} ${status}`).toBeDefined();
    }
  });

  it('reads the settings for an Admin and refuses a plain Member uniformly', async () => {
    const instance = await app();
    const read = async (memberId: string) =>
      instance.inject({
        method: 'GET',
        url: '/api/installation',
        headers: headers(await memberSession(memberId), false),
      });
    expect((await read(adminId)).json()).toStrictEqual({
      settings: { downloadPolicy: 'deny', revision: await revision(), inheritingRoomCount: 2 },
    });
    const refused = await read(plainMemberId);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
    await instance.close();
  });

  it('reviews, then asks a stale session to sign in again before allowing', async () => {
    const instance = await app();
    const post = async (payload: Record<string, unknown>, authenticatedAt: Date) =>
      instance.inject({
        method: 'POST',
        url: '/api/installation/download-policy',
        headers: headers(await memberSession(ownerId, authenticatedAt)),
        payload,
      });
    const reviewed = await post({ action: 'dry-run', policy: 'allow' }, fresh());
    expect(reviewed.statusCode).toBe(200);
    const { impact } = reviewed.json<{
      impact: { expectedRevision: number; confirmation: string };
    }>();
    const change = {
      action: 'apply',
      policy: 'allow',
      expectedRevision: impact.expectedRevision,
      confirmation: impact.confirmation,
    };
    const refused = await post(change, stale());
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe(
      'FRESH_AUTHENTICATION_REQUIRED',
    );
    const applied = await post(change, fresh());
    expect(applied.json()).toStrictEqual({ revision: impact.expectedRevision + 1 });
    const denied = await post(
      { action: 'apply', policy: 'deny', expectedRevision: impact.expectedRevision + 1 },
      stale(),
    );
    expect(denied.json()).toStrictEqual({ revision: impact.expectedRevision + 2 });
    await instance.close();
  });

  it('rejects a deny that carries a phrase, and any change without CSRF', async () => {
    const instance = await app();
    const session = await memberSession(ownerId);
    const payload = {
      action: 'apply',
      policy: 'deny',
      expectedRevision: await revision(),
      confirmation: 'ALLOW ORIGINAL DOWNLOADS',
    };
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/api/installation/download-policy',
          headers: headers(session),
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: '/api/installation/download-policy',
          headers: headers(session, false),
          payload: { action: 'dry-run', policy: 'allow' },
        })
      ).statusCode,
    ).toBe(403);
    await instance.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/installation-download.test.ts
```

Expected: FAIL — `read_installation_settings` does not exist.

- [ ] **Step 3: Write migration 026**

Create `modules/participants-access/migrations/026_installation_settings.sql`:

```sql
-- Duefold installation settings: the installation-wide original-download default as a
-- reviewed change. Immutable after application.

CREATE FUNCTION installation_download_allow_confirmation() RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT 'ALLOW ORIGINAL DOWNLOADS'::text
$$;

CREATE FUNCTION read_installation_settings(p_actor_id text)
RETURNS TABLE(download_policy text,policy_revision integer,inheriting_room_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  RETURN QUERY
    SELECT o.installation_download_policy,o.policy_revision,
           (SELECT count(*)::integer FROM room r WHERE r.download_policy IS NULL)
      FROM organization o;
END $$;

/*
 * What changing the default reaches: every room without its own policy, and of what viewers
 * can open today, every published document in a published room where neither the room nor
 * the document sets its own policy. Allowing is the broad direction (§9.4), so it carries the
 * phrase and needs a fresh sign-in; denying only removes access and needs neither.
 */
CREATE FUNCTION dry_run_installation_download_policy(p_actor_id text,p_policy text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_policy text; current_revision integer;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_policy IS NULL OR p_policy NOT IN ('allow','deny') THEN
    RAISE EXCEPTION 'invalid download policy' USING ERRCODE='22023';
  END IF;
  SELECT o.installation_download_policy,o.policy_revision INTO current_policy,current_revision
    FROM organization o;
  IF current_policy=p_policy THEN
    RAISE EXCEPTION 'installation already has that download policy' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object(
    'currentPolicy',current_policy,
    'proposedPolicy',p_policy,
    'inheritingRoomCount',(SELECT count(*)::integer FROM room r WHERE r.download_policy IS NULL),
    'affectedDocumentCount',(SELECT count(*)::integer
       FROM published_structure_entry e
       JOIN room r ON r.id=e.room_id
       JOIN document d ON d.id=e.resource_id
      WHERE e.resource_kind='document' AND r.state='published'
        AND r.download_policy IS NULL AND d.download_policy IS NULL),
    'requiresFreshAuthentication',p_policy='allow',
    'expectedRevision',current_revision,
    'confirmation',CASE WHEN p_policy='allow' THEN installation_download_allow_confirmation() END);
END $$;

CREATE FUNCTION apply_installation_download_policy(
  p_actor_id text,p_policy text,p_expected_revision integer,
  p_oidc_authenticated_at timestamptz,p_confirmation text,p_audit_id text,p_correlation_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_policy text; current_revision integer; next_revision integer;
BEGIN
  PERFORM assert_organization_administrator(p_actor_id);
  IF p_policy IS NULL OR p_policy NOT IN ('allow','deny')
     OR (p_policy='deny') <> (p_confirmation IS NULL) THEN
    RAISE EXCEPTION 'invalid installation download change' USING ERRCODE='22023';
  END IF;
  SELECT o.installation_download_policy,o.policy_revision INTO current_policy,current_revision
    FROM organization o FOR UPDATE;
  IF current_revision<>p_expected_revision THEN
    RAISE EXCEPTION 'stale installation policy' USING ERRCODE='40001';
  END IF;
  IF current_policy=p_policy THEN
    RAISE EXCEPTION 'installation already has that download policy' USING ERRCODE='55000';
  END IF;
  IF p_policy='allow' AND (p_oidc_authenticated_at IS NULL
       OR p_oidc_authenticated_at>statement_timestamp()
       OR p_oidc_authenticated_at<=statement_timestamp()-interval '15 minutes') THEN
    RAISE EXCEPTION 'fresh OIDC required' USING ERRCODE='42501';
  END IF;
  IF p_policy='allow' AND p_confirmation IS DISTINCT FROM installation_download_allow_confirmation() THEN
    RAISE EXCEPTION 'typed confirmation mismatch' USING ERRCODE='22023';
  END IF;
  UPDATE organization SET installation_download_policy=p_policy,policy_revision=policy_revision+1
  RETURNING policy_revision INTO next_revision;
  INSERT INTO audit_event(id,event_type,actor_kind,actor_id,resource_type,result,reason_code,
                          correlation_id,detail)
  VALUES(p_audit_id,'download.policy','member',p_actor_id,'organization','success',
         'INSTALLATION_DOWNLOAD_POLICY_CHANGED',p_correlation_id,
         jsonb_build_object('policy',p_policy,'policyRevision',next_revision));
  RETURN next_revision;
END $$;

-- The 007 setter changes the default with none of the review's rules; the web credential
-- reaches the default only through the functions above.
REVOKE EXECUTE ON FUNCTION set_installation_download_policy(text,text,integer,text,text)
  FROM duefold_runtime;

REVOKE ALL ON FUNCTION installation_download_allow_confirmation() FROM PUBLIC;
REVOKE ALL ON FUNCTION read_installation_settings(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION dry_run_installation_download_policy(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_installation_download_policy(text,text,integer,timestamptz,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_installation_settings(text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION dry_run_installation_download_policy(text,text) TO duefold_runtime;
GRANT EXECUTE ON FUNCTION apply_installation_download_policy(text,text,integer,timestamptz,text,text,text) TO duefold_runtime;
ALTER FUNCTION installation_download_allow_confirmation() OWNER TO duefold_migration;
ALTER FUNCTION read_installation_settings(text) OWNER TO duefold_migration;
ALTER FUNCTION dry_run_installation_download_policy(text,text) OWNER TO duefold_migration;
ALTER FUNCTION apply_installation_download_policy(text,text,integer,timestamptz,text,text,text) OWNER TO duefold_migration;
```

The update runs as `duefold_migration`, the function's owner, which is what `protect_installation_download_policy` (007) admits.

In `modules/participants-access/src/declaration.ts`, add `{ id: '026_installation_settings', file: '026_installation_settings.sql' }` after `023_room_settings`.

- [ ] **Step 4: Write the wrappers**

Create `modules/participants-access/src/installation-settings.ts`:

```ts
/**
 * The installation-wide download default. Thin wrappers: authority, freshness, the phrase and
 * the audit row are the `SECURITY DEFINER` functions'.
 */
import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';
import type { DownloadPolicy } from './room-settings.ts';

export interface InstallationSettings {
  readonly downloadPolicy: DownloadPolicy;
  readonly revision: number;
  readonly inheritingRoomCount: number;
}

export interface InstallationDownloadImpact {
  readonly currentPolicy: DownloadPolicy;
  readonly proposedPolicy: DownloadPolicy;
  readonly inheritingRoomCount: number;
  readonly affectedDocumentCount: number;
  readonly requiresFreshAuthentication: boolean;
  readonly expectedRevision: number;
  /** The phrase allowing needs; null when denying, which takes none. */
  readonly confirmation: string | null;
}

/** Allowing carries the phrase it was reviewed under; denying has no field for one. */
export type InstallationDownloadChange =
  | { readonly policy: 'allow'; readonly expectedRevision: number; readonly confirmation: string }
  | { readonly policy: 'deny'; readonly expectedRevision: number };

export async function readInstallationSettings(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
}): Promise<InstallationSettings> {
  const row = (
    await input.pool.query<{
      download_policy: DownloadPolicy;
      policy_revision: number;
      inheriting_room_count: number;
    }>('SELECT * FROM read_installation_settings($1)', [input.identity.id])
  ).rows[0];
  if (row === undefined) throw new Error('INSTALLATION_SETTINGS_UNAVAILABLE');
  return {
    downloadPolicy: row.download_policy,
    revision: row.policy_revision,
    inheritingRoomCount: row.inheriting_room_count,
  };
}

export async function dryRunInstallationDownloadPolicy(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly policy: DownloadPolicy;
}): Promise<InstallationDownloadImpact> {
  const impact = (
    await input.pool.query<{ impact: InstallationDownloadImpact }>(
      'SELECT dry_run_installation_download_policy($1,$2) AS impact',
      [input.identity.id, input.policy],
    )
  ).rows[0]?.impact;
  if (impact === undefined) throw new Error('INSTALLATION_DOWNLOAD_IMPACT_UNAVAILABLE');
  return impact;
}

export async function applyInstallationDownloadPolicy(
  input: { readonly pool: Pool; readonly identity: MemberIdentity } & InstallationDownloadChange,
): Promise<{ readonly revision: number }> {
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT apply_installation_download_policy($1,$2,$3,$4,$5,$6,$7) AS revision',
      [
        input.identity.id,
        input.policy,
        input.expectedRevision,
        input.identity.oidcAuthenticatedAt ?? null,
        input.policy === 'allow' ? input.confirmation : null,
        createOpaqueId(),
        createCorrelationId(),
      ],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('INSTALLATION_DOWNLOAD_CHANGE_UNAVAILABLE');
  return { revision };
}
```

- [ ] **Step 5: Add the routes**

Create `modules/participants-access/src/routes/installation.ts`:

```ts
import { Type } from '@sinclair/typebox';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { protectedErrorResponses } from '../../../core-security/src/routes/error-envelope.ts';
import { readInstallationSettings } from '../installation-settings.ts';

const closed = { additionalProperties: false } as const;

export const schema = {
  response: {
    200: Type.Object(
      {
        settings: Type.Object(
          {
            downloadPolicy: Type.Union([Type.Literal('allow'), Type.Literal('deny')]),
            revision: Type.Integer({ minimum: 1 }),
            inheritingRoomCount: Type.Integer({ minimum: 0 }),
          },
          closed,
        ),
      },
      closed,
    ),
    ...protectedErrorResponses(),
  },
};

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async () => ({ settings: await readInstallationSettings({ pool: runtime.pool, identity }) });
}

export function handler(): never {
  throw new Error('installation route runtime not initialized');
}
```

Create `modules/participants-access/src/routes/installation-download.ts`:

```ts
import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { protectedErrorResponses } from '../../../core-security/src/routes/error-envelope.ts';
import {
  applyInstallationDownloadPolicy,
  dryRunInstallationDownloadPolicy,
} from '../installation-settings.ts';
import type { DownloadPolicy } from '../room-settings.ts';

const POLICY = Type.Union([Type.Literal('allow'), Type.Literal('deny')]);
const REVISION = Type.Integer({ minimum: 1 });
const PHRASE = Type.String({ minLength: 1, maxLength: 200 });
const closed = { additionalProperties: false } as const;

const IMPACT = Type.Object(
  {
    currentPolicy: POLICY,
    proposedPolicy: POLICY,
    inheritingRoomCount: Type.Integer({ minimum: 0 }),
    affectedDocumentCount: Type.Integer({ minimum: 0 }),
    requiresFreshAuthentication: Type.Boolean(),
    expectedRevision: REVISION,
    confirmation: Type.Union([PHRASE, Type.Null()]),
  },
  closed,
);

/**
 * The installation download default. Allowing names the phrase it was reviewed under;
 * denying has no field for one, so the pairing the SQL refuses cannot be sent.
 */
export const schema = {
  body: Type.Union([
    Type.Object({ action: Type.Literal('dry-run'), policy: POLICY }, closed),
    Type.Object(
      {
        action: Type.Literal('apply'),
        policy: Type.Literal('allow'),
        expectedRevision: REVISION,
        confirmation: PHRASE,
      },
      closed,
    ),
    Type.Object(
      { action: Type.Literal('apply'), policy: Type.Literal('deny'), expectedRevision: REVISION },
      closed,
    ),
  ]),
  response: {
    200: Type.Union([
      Type.Object({ impact: IMPACT }, closed),
      Type.Object({ revision: REVISION }, closed),
    ]),
    ...protectedErrorResponses(),
  },
};

type Body =
  | { readonly action: 'dry-run'; readonly policy: DownloadPolicy }
  | {
      readonly action: 'apply';
      readonly policy: 'allow';
      readonly expectedRevision: number;
      readonly confirmation: string;
    }
  | { readonly action: 'apply'; readonly policy: 'deny'; readonly expectedRevision: number };

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const body = request.body as Body;
    const pool = runtime.pool;
    if (body.action === 'dry-run')
      return {
        impact: await dryRunInstallationDownloadPolicy({ pool, identity, policy: body.policy }),
      };
    return body.policy === 'allow'
      ? applyInstallationDownloadPolicy({
          pool,
          identity,
          policy: 'allow',
          expectedRevision: body.expectedRevision,
          confirmation: body.confirmation,
        })
      : applyInstallationDownloadPolicy({
          pool,
          identity,
          policy: 'deny',
          expectedRevision: body.expectedRevision,
        });
  };
}

export function handler(): never {
  throw new Error('installation download route runtime not initialized');
}
```

In `modules/participants-access/src/declaration.ts`, add after `counterparty.change`:

```ts
    {
      id: 'installation.settings.read',
      method: 'GET',
      path: '/api/installation',
      audience: 'member',
      handler: 'routes/installation.ts',
      handlerFactoryExport: 'createHandler',
    },
    {
      id: 'installation.download-policy',
      method: 'POST',
      path: '/api/installation/download-policy',
      audience: 'member',
      handler: 'routes/installation-download.ts',
      handlerFactoryExport: 'createHandler',
    },
```

In `apps/web/src/app.ts`, add both to `ROUTE_FACTORIES` and to `memberFactory`'s id union:

```ts
  'installation.settings.read': memberFactory('installation.settings.read'),
  'installation.download-policy': memberFactory('installation.download-policy'),
```

```ts
    | 'installation.settings.read'
    | 'installation.download-policy'
```

- [ ] **Step 6: Extend the contract and the maps**

Append to `docs/installation-status-http-contract.md`:

````markdown
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
````

In `modules/participants-access/README.md`, add to `## Start here`:

```markdown
- [Installation settings](src/installation-settings.ts) with its [read route](src/routes/installation.ts) and [download default route](src/routes/installation-download.ts) — the installation-wide original-download default as a reviewed change; see the [installation status HTTP contract](../../docs/installation-status-http-contract.md) and the [installation download suite](../../test/authz/installation-download.test.ts).
```

In `CODEBASE_MAP.md`, add `[installation download](test/authz/installation-download.test.ts)` to the installation row's Primary tests.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm run compose
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/installation-download.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/room-download-policy.test.ts
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2 test/authz/participant-grants.test.ts
npx vitest run --project unit --maxWorkers=2 test/unit/codebase-map.test.ts
npm run typecheck && npm run lint
```

Expected: PASS. No suite calls `set_installation_download_policy` (`git grep -n set_installation_download_policy test` returns nothing), so revoking its runtime grant breaks no test; the download-policy and grant suites prove resolution is unchanged.

- [ ] **Step 8: Commit**

```bash
git add modules/participants-access apps/web/src/app.ts test/authz/installation-download.test.ts docs/installation-status-http-contract.md CODEBASE_MAP.md
git commit -m "Make the installation download default a reviewed change"
```

---

### Task 7: The Status section

**Files:**
- Modify: `apps/web-client/src/api/transport.ts` (add `oneOf`, `instantOrNull`, `requireRecord`, `requireBoolean`, `textOrNull`)
- Modify: `apps/web-client/src/api/room-settings.ts`, `apps/web-client/src/api/participants.ts`, `apps/web-client/src/api/administration.ts` (import those helpers instead of defining them)
- Create: `apps/web-client/src/api/status-codes.ts`, `apps/web-client/src/api/status.ts`, `apps/web-client/src/api/status.unit.test.ts`
- Modify: `apps/web-client/src/api/client.ts` (re-export)
- Create: `apps/web-client/src/workspace/useLoad.ts`
- Create: `apps/web-client/src/workspace/status-rows.ts`, `apps/web-client/src/workspace/status-rows.unit.test.ts`
- Create: `apps/web-client/src/components/StatusPanel.tsx`, `apps/web-client/src/components/StatusPanel.unit.test.tsx`
- Create: `apps/web-client/src/workspace/views/InstallationSections.tsx`
- Modify: `apps/web-client/src/workspace/views/AdministrationView.tsx` (section list, Status render, inner nav label)
- Modify: `apps/web-client/src/routes/Workspace.tsx` (outer tab label key only)
- Modify: `apps/web-client/src/workspace/views/views.unit.test.tsx`, `test/browser/members.spec.ts` (the outer tab is Administration)
- Modify: `apps/web-client/src/i18n/en.ts`
- Create: `test/unit/status-codes.test.ts`
- Modify: `CODEBASE_MAP.md`, `modules/core-security/README.md`

**Interfaces:**
- Consumes: `GET /api/status`, `GET /api/status/content` (Task 4); `CHECK_CODES`, `STATUS_CHECKS` (`modules/core-security/src/status-observations.ts`, Task 1), which the browser mirrors; `presentFailure`, `classifyLoad`, `FailureNotice`, `Notice`, `SectionNav`, `composeSections`, `currentSection`.
- Produces:
  - `oneOf`, `instantOrNull`, `requireRecord`, `requireBoolean`, `textOrNull` exported from `api/transport.ts`.
  - `loadInstallationStatus(signal?): Promise<InstallationStatus>` and types `InstallationStatus`, `DeploymentStatus`, `ContentStatus`, `CheckObservation`, `StatusCheckRow`, `StatusCheck`, `ObservationCode` from `api/client.ts`.
  - `useLoad<T>(loader: (signal: AbortSignal) => Promise<T>): LoadedSection<T>` with `LoadedSection<T> {load: Load<T>; failure: PresentedFailure | null; reload(): void}`.
  - `statusRows(status): readonly StatusRow[]`, `formatInstant(iso)`, `STATE_LABEL`, types `StatusRow`, `RowState`, `RowTime`.
  - `StatusPanel({section: LoadedSection<InstallationStatus>})`; `StatusSection()` in `InstallationSections.tsx`.

Status is one read of both routes: a partial status is not one a person can act on. Every row names its state in words — passing, needs attention, failing, not yet checked, out of date — and a failing check stays failing when it is also out of date, since the older answer is still the last one known. Instants are the server's; the browser formats them and never subtracts its own clock from them.

The Administration view gains an inner strip once it holds more than Members, so the outer tab becomes **Administration** and the inner strip is labelled "Administration sections": two navigation landmarks with one label would be indistinguishable in a landmark list.

`transport.ts` reads `document.cookie`, which the Node-only root compiler settings cannot type, so the browser's code list lives in import-free `status-codes.ts` and the contract test imports that.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/status-codes.test.ts`:

```ts
/**
 * The browser names every code the server can record, and nothing else. A code the server
 * gained without the browser would fail every status read; one the browser kept after the
 * server dropped it would be copy nobody can see.
 */
import { describe, expect, it } from 'vitest';
import {
  CHECK_CODES as BROWSER_CODES,
  STATUS_CHECKS as BROWSER_CHECKS,
} from '../../apps/web-client/src/api/status-codes.ts';
import {
  CHECK_CODES as SERVER_CODES,
  STATUS_CHECKS as SERVER_CHECKS,
} from '../../modules/core-security/src/status-observations.ts';

describe('the status code vocabulary', () => {
  it('is the same on both sides of the wire', () => {
    expect(BROWSER_CHECKS).toStrictEqual(SERVER_CHECKS);
    expect(BROWSER_CODES).toStrictEqual(SERVER_CODES);
  });
});
```

Create `apps/web-client/src/api/status.unit.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadInstallationStatus } from './status.ts';

const DEPLOYMENT = {
  application: {
    version: '1.0.0',
    modules: ['core-security', 'rooms-documents', 'participants-access'],
    adapters: { storage: 's3-compatible', mail: 'smtp', identity: 'oidc' },
  },
  oidc: { discoveryConformedAt: '2026-09-21T08:00:00.000Z' },
  migrations: { state: 'current', appliedCount: 14, expectedCount: 14, latestApplied: '026_x' },
  queue: { due: 0, running: 0, failedRecently: 0, oldestDueSeconds: null },
  mail: { lastDeliveredAt: null, failedRecently: 0 },
  checks: [
    { check: 'storage-privacy', observation: null },
    { check: 'storage-versioning', observation: null },
    {
      check: 'scanner',
      observation: {
        result: 'pass',
        code: 'SIGNATURES_CURRENT',
        evidenceAt: '2026-09-21T06:00:00.000Z',
        evidenceVersion: null,
        observedAt: '2026-09-21T09:00:00.000Z',
        stale: false,
      },
    },
    { check: 'updates', observation: null },
  ],
};
const CONTENT = {
  processing: { failedCount: 0 },
  recovery: {
    backupStatus: 'undetermined',
    backupRetention: null,
    recoveryExpectation: null,
    acknowledgedAt: null,
    restoreDrillStatus: 'not-tested',
    restoreDrillAt: null,
  },
};

function answering(deployment: unknown, content: unknown = CONTENT): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(
          JSON.stringify(String(input).endsWith('/api/status/content') ? content : deployment),
          { status: 200 },
        ),
      ),
    ),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadInstallationStatus', () => {
  it('reads both routes as one answer', async () => {
    answering(DEPLOYMENT);
    const status = await loadInstallationStatus();
    expect(status.deployment.checks[2]?.observation?.code).toBe('SIGNATURES_CURRENT');
    expect(status.content.recovery.restoreDrillStatus).toBe('not-tested');
  });

  it.each([
    ['a code that belongs to another check', 2, { code: 'UPDATE_AVAILABLE' }],
    ['a result it does not know', 2, { result: 'unknown' }],
    ['an unreadable instant', 2, { observedAt: 'yesterday' }],
  ] as const)('fails closed on %s', async (_label, index, change) => {
    const checks = DEPLOYMENT.checks.map((row, position) =>
      position === index && row.observation !== null
        ? { ...row, observation: { ...row.observation, ...change } }
        : row,
    );
    answering({ ...DEPLOYMENT, checks });
    await expect(loadInstallationStatus()).rejects.toMatchObject({ failure: 'unavailable' });
  });

  it('fails closed when a check is missing or out of order', async () => {
    answering({ ...DEPLOYMENT, checks: DEPLOYMENT.checks.slice(1) });
    await expect(loadInstallationStatus()).rejects.toMatchObject({ failure: 'unavailable' });
    answering({ ...DEPLOYMENT, checks: [...DEPLOYMENT.checks].reverse() });
    await expect(loadInstallationStatus()).rejects.toMatchObject({ failure: 'unavailable' });
  });

  it('fails closed on a recovery state it does not know', async () => {
    answering(DEPLOYMENT, {
      ...CONTENT,
      recovery: { ...CONTENT.recovery, restoreDrillStatus: 'maybe' },
    });
    await expect(loadInstallationStatus()).rejects.toMatchObject({ failure: 'unavailable' });
  });
});
```

Create `apps/web-client/src/workspace/status-rows.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { InstallationStatus } from '../api/client.ts';
import { messages } from '../i18n/en.ts';
import { statusRows } from './status-rows.ts';

const STATUS: InstallationStatus = {
  deployment: {
    application: {
      version: '1.0.0',
      modules: ['core-security', 'rooms-documents'],
      adapters: { storage: 's3-compatible', mail: 'smtp', identity: 'oidc' },
    },
    oidc: { discoveryConformedAt: '2026-09-21T08:00:00.000Z' },
    migrations: { state: 'current', appliedCount: 14, expectedCount: 14, latestApplied: '026_x' },
    queue: { due: 0, running: 0, failedRecently: 0, oldestDueSeconds: null },
    mail: { lastDeliveredAt: '2026-09-21T07:00:00.000Z', failedRecently: 0 },
    checks: [
      { check: 'storage-privacy', observation: null },
      { check: 'storage-versioning', observation: null },
      { check: 'scanner', observation: null },
      { check: 'updates', observation: null },
    ],
  },
  content: {
    processing: { failedCount: 0 },
    recovery: {
      backupStatus: 'undetermined',
      backupRetention: null,
      recoveryExpectation: null,
      acknowledgedAt: null,
      restoreDrillStatus: 'not-tested',
      restoreDrillAt: null,
    },
  },
};

const row = (status: InstallationStatus, id: string) =>
  statusRows(status).find((candidate) => candidate.id === id);

const withCheck = (
  check: InstallationStatus['deployment']['checks'][number],
): InstallationStatus => ({
  ...STATUS,
  deployment: {
    ...STATUS.deployment,
    checks: STATUS.deployment.checks.map((row) => (row.check === check.check ? check : row)),
  },
});

describe('statusRows', () => {
  it("lists §20.2's facts in order", () => {
    expect(statusRows(STATUS).map(({ id }) => id)).toStrictEqual([
      'application',
      'migrations',
      'storage-privacy',
      'storage-versioning',
      'scanner',
      'queue',
      'processing',
      'oidc',
      'mail',
      'backups',
      'restore',
      'updates',
    ]);
  });

  it('says a check that never ran is not yet checked, and when it will be', () => {
    expect(row(STATUS, 'scanner')).toMatchObject({
      state: 'unchecked',
      details: [messages['status.unchecked.worker']],
      time: { kind: 'never' },
    });
    expect(row(STATUS, 'updates')?.details).toStrictEqual([messages['status.unchecked.updates']]);
  });

  it('keeps a failing check failing when it is also out of date, and otherwise reports it out of date', () => {
    const observation = {
      result: 'fail',
      code: 'SIGNATURES_STALE',
      evidenceAt: '2026-09-18T09:00:00.000Z',
      evidenceVersion: null,
      observedAt: '2026-09-21T09:00:00.000Z',
      stale: true,
    } as const;
    expect(row(withCheck({ check: 'scanner', observation }), 'scanner')?.state).toBe('fail');
    expect(
      row(
        withCheck({
          check: 'scanner',
          observation: { ...observation, result: 'pass', code: 'SIGNATURES_CURRENT' },
        }),
        'scanner',
      )?.state,
    ).toBe('stale');
  });

  it("gives the signatures' age in whole days between two server instants", () => {
    const scanner = row(
      withCheck({
        check: 'scanner',
        observation: {
          result: 'fail',
          code: 'SIGNATURES_STALE',
          evidenceAt: '2026-09-18T09:00:00.000Z',
          evidenceVersion: null,
          observedAt: '2026-09-21T10:00:00.000Z',
          stale: false,
        },
      }),
      'scanner',
    );
    expect(scanner?.details[0]).toBe(messages['status.code.SIGNATURES_STALE']);
    expect(scanner?.details[1]).toContain('3 days before');
  });

  it('names the offered release', () => {
    const updates = row(
      withCheck({
        check: 'updates',
        observation: {
          result: 'attention',
          code: 'UPDATE_AVAILABLE',
          evidenceAt: null,
          evidenceVersion: '1.2.0',
          observedAt: '2026-09-21T10:00:00.000Z',
          stale: false,
        },
      }),
      'updates',
    );
    expect(updates?.state).toBe('attention');
    expect(updates?.details.join(' ')).toContain('1.2.0');
  });

  it('fails the migrations row unless the ledger is current', () => {
    expect(row(STATUS, 'migrations')?.state).toBe('pass');
    expect(
      row(
        {
          ...STATUS,
          deployment: {
            ...STATUS.deployment,
            migrations: { ...STATUS.deployment.migrations, state: 'pending', appliedCount: 12 },
          },
        },
        'migrations',
      )?.state,
    ).toBe('fail');
  });

  it('asks for attention when work has waited a quarter of an hour or failed after every retry', () => {
    const queue = (change: Partial<InstallationStatus['deployment']['queue']>) =>
      row(
        {
          ...STATUS,
          deployment: { ...STATUS.deployment, queue: { ...STATUS.deployment.queue, ...change } },
        },
        'queue',
      )?.state;
    expect(queue({ due: 3, oldestDueSeconds: 60 })).toBe('pass');
    expect(queue({ due: 3, oldestDueSeconds: 16 * 60 })).toBe('attention');
    expect(queue({ failedRecently: 1 })).toBe('attention');
  });

  it('reads mail from delivery evidence', () => {
    const mail = (change: Partial<InstallationStatus['deployment']['mail']>) =>
      row(
        {
          ...STATUS,
          deployment: { ...STATUS.deployment, mail: { ...STATUS.deployment.mail, ...change } },
        },
        'mail',
      )?.state;
    expect(mail({})).toBe('pass');
    expect(mail({ lastDeliveredAt: null })).toBe('unchecked');
    expect(mail({ failedRecently: 2 })).toBe('fail');
  });

  it('asks for attention until backups are acknowledged and a restore drill has passed', () => {
    expect(row(STATUS, 'backups')?.state).toBe('attention');
    expect(row(STATUS, 'restore')?.state).toBe('attention');
    const recovered: InstallationStatus = {
      ...STATUS,
      content: {
        ...STATUS.content,
        recovery: {
          backupStatus: 'operator-acknowledged',
          backupRetention: '35 days',
          recoveryExpectation: 'Four hours',
          acknowledgedAt: '2026-09-20T09:00:00.000Z',
          restoreDrillStatus: 'failed',
          restoreDrillAt: '2026-09-20T10:00:00.000Z',
        },
      },
    };
    expect(row(recovered, 'backups')).toMatchObject({
      state: 'pass',
      time: { kind: 'at', iso: '2026-09-20T09:00:00.000Z' },
    });
    expect(row(recovered, 'backups')?.details.join(' ')).toContain('35 days');
    expect(row(recovered, 'restore')?.state).toBe('fail');
  });
});
```

Create `apps/web-client/src/components/StatusPanel.unit.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InstallationStatus } from '../api/client.ts';
import { messages } from '../i18n/en.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import type { LoadedSection } from '../workspace/useLoad.ts';
import { StatusPanel } from './StatusPanel.tsx';

const READY: InstallationStatus = {
  deployment: {
    application: {
      version: '1.0.0',
      modules: ['core-security'],
      adapters: { storage: 's3-compatible', mail: 'smtp', identity: 'oidc' },
    },
    oidc: { discoveryConformedAt: '2026-09-21T08:00:00.000Z' },
    migrations: { state: 'current', appliedCount: 1, expectedCount: 1, latestApplied: '001_a' },
    queue: { due: 0, running: 0, failedRecently: 0, oldestDueSeconds: null },
    mail: { lastDeliveredAt: null, failedRecently: 0 },
    checks: [
      {
        check: 'storage-privacy',
        observation: {
          result: 'fail',
          code: 'ANONYMOUS_LIST_ALLOWED',
          evidenceAt: null,
          evidenceVersion: null,
          observedAt: '2026-09-21T09:00:00.000Z',
          stale: false,
        },
      },
      { check: 'storage-versioning', observation: null },
      { check: 'scanner', observation: null },
      { check: 'updates', observation: null },
    ],
  },
  content: {
    processing: { failedCount: 0 },
    recovery: {
      backupStatus: 'undetermined',
      backupRetention: null,
      recoveryExpectation: null,
      acknowledgedAt: null,
      restoreDrillStatus: 'not-tested',
      restoreDrillAt: null,
    },
  },
};

const section = (
  load: LoadedSection<InstallationStatus>['load'],
  failure: PresentedFailure | null = null,
): LoadedSection<InstallationStatus> => ({ load, failure, reload: () => undefined });

describe('StatusPanel', () => {
  it('says it is loading', () => {
    expect(renderToStaticMarkup(<StatusPanel section={section({ kind: 'loading' })} />)).toContain(
      messages['status.loading'],
    );
  });

  it('renders a denial without describing what it withholds', () => {
    const markup = renderToStaticMarkup(
      <StatusPanel
        section={section(
          { kind: 'failed', failure: 'denied' },
          { kind: 'denied', title: null, body: 'denied', offerReload: false },
        )}
      />,
    );
    expect(markup).toContain(messages['status.denied']);
    expect(markup).not.toContain('<table');
  });

  it('renders every check as a labelled row, its state in words, and times as time elements', () => {
    const markup = renderToStaticMarkup(<StatusPanel section={section({ kind: 'ready', value: READY })} />);
    expect([...markup.matchAll(/<th scope="row"/gu)]).toHaveLength(12);
    expect(markup).toContain(messages['status.state.fail']);
    expect(markup).toContain(messages['status.state.unchecked']);
    expect(markup).toMatch(/<time datetime="2026-09-21T09:00:00.000Z"/iu);
    expect(markup).toContain(`data-label="${messages['status.column.state']}"`);
    expect(markup).toContain(messages['status.intro']);
  });

  it('leads with how many checks are failing', () => {
    const markup = renderToStaticMarkup(<StatusPanel section={section({ kind: 'ready', value: READY })} />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(messages['status.summary.failing'].replace('{count}', '1'));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run --project unit --maxWorkers=2 status test/unit/status-codes.test.ts
```

Expected: FAIL — `status-codes.ts`, `status.ts`, `status-rows.ts` and `StatusPanel.tsx` do not exist.

- [ ] **Step 3: Give the shared parsers one home**

Move `oneOf`, `instantOrNull`, `requireRecord` and `requireBoolean` from `apps/web-client/src/api/room-settings.ts` into `apps/web-client/src/api/transport.ts` unchanged, and add beside them:

```ts
/** A non-empty string, or null. */
export function textOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value === '') throw new ApiError('unavailable');
  return value;
}
```

`room-settings.ts` and `participants.ts` import the four from `./transport.ts`. `administration.ts` deletes its private `oneOf` and imports the shared one. `git grep -n "function oneOf\|function instantOrNull" apps/web-client/src` must list only `transport.ts` afterwards.

- [ ] **Step 4: Write the status client**

Create `apps/web-client/src/api/status-codes.ts`:

```ts
/**
 * Every code each status check may answer, as `modules/core-security/src/status-observations.ts`
 * defines it; `test/unit/status-codes.test.ts` holds the two equal. Import-free, so that test
 * can load it outside the browser.
 */
export type StatusCheck = 'storage-privacy' | 'storage-versioning' | 'scanner' | 'updates';

export const STATUS_CHECKS: readonly StatusCheck[] = [
  'storage-privacy',
  'storage-versioning',
  'scanner',
  'updates',
];

export const CHECK_CODES = {
  'storage-privacy': [
    'ANONYMOUS_ACCESS_REFUSED',
    'ANONYMOUS_READ_ALLOWED',
    'ANONYMOUS_LIST_ALLOWED',
    'STORAGE_PROBE_INCONCLUSIVE',
    'STORAGE_UNREACHABLE',
  ],
  'storage-versioning': [
    'VERSIONING_ENABLED',
    'VERSIONING_SUSPENDED',
    'VERSIONING_NEVER_ENABLED',
    'VERSIONING_NOT_DETECTABLE',
    'STORAGE_UNREACHABLE',
  ],
  scanner: ['SIGNATURES_CURRENT', 'SIGNATURES_STALE', 'SCANNER_UNAVAILABLE'],
  updates: [
    'UPDATE_CURRENT',
    'UPDATE_AVAILABLE',
    'SECURITY_ADVISORY',
    'UPDATE_MANIFEST_UNVERIFIED',
    'UPDATE_VERSION_UNRECOGNIZED',
  ],
} as const satisfies Readonly<Record<StatusCheck, readonly string[]>>;

export type ObservationCode = (typeof CHECK_CODES)[StatusCheck][number];
```

Create `apps/web-client/src/api/status.ts`:

```ts
/**
 * The Owner/Admin status surface: `GET /api/status` and `GET /api/status/content`, read as one
 * answer and parsed field by field. A check, code, order or state this client does not know
 * fails the read rather than being shown as something else.
 */
import { CHECK_CODES, STATUS_CHECKS, type ObservationCode, type StatusCheck } from './status-codes.ts';
import {
  ApiError,
  instantOrNull,
  isRecord,
  json,
  oneOf,
  requireArray,
  requireBoolean,
  requireInteger,
  requireRecord,
  requireString,
  textOrNull,
} from './transport.ts';

export type { ObservationCode, StatusCheck } from './status-codes.ts';
export type ObservationResult = 'pass' | 'attention' | 'fail';
export type MigrationState = 'current' | 'pending' | 'unrecognized';
export type BackupStatus = 'undetermined' | 'operator-acknowledged';
export type RestoreDrillStatus = 'not-tested' | 'passed' | 'failed';

export interface CheckObservation {
  readonly result: ObservationResult;
  readonly code: ObservationCode;
  readonly evidenceAt: string | null;
  readonly evidenceVersion: string | null;
  readonly observedAt: string;
  readonly stale: boolean;
}

export interface StatusCheckRow {
  readonly check: StatusCheck;
  readonly observation: CheckObservation | null;
}

export interface DeploymentStatus {
  readonly application: {
    readonly version: string;
    readonly modules: readonly string[];
    readonly adapters: { readonly storage: string; readonly mail: string; readonly identity: string };
  };
  readonly oidc: { readonly discoveryConformedAt: string };
  readonly migrations: {
    readonly state: MigrationState;
    readonly appliedCount: number;
    readonly expectedCount: number;
    readonly latestApplied: string | null;
  };
  readonly queue: {
    readonly due: number;
    readonly running: number;
    readonly failedRecently: number;
    readonly oldestDueSeconds: number | null;
  };
  readonly mail: { readonly lastDeliveredAt: string | null; readonly failedRecently: number };
  readonly checks: readonly StatusCheckRow[];
}

export interface ContentStatus {
  readonly processing: { readonly failedCount: number };
  readonly recovery: {
    readonly backupStatus: BackupStatus;
    readonly backupRetention: string | null;
    readonly recoveryExpectation: string | null;
    readonly acknowledgedAt: string | null;
    readonly restoreDrillStatus: RestoreDrillStatus;
    readonly restoreDrillAt: string | null;
  };
}

export interface InstallationStatus {
  readonly deployment: DeploymentStatus;
  readonly content: ContentStatus;
}

const RESULTS: readonly ObservationResult[] = ['pass', 'attention', 'fail'];
const MIGRATION_STATES: readonly MigrationState[] = ['current', 'pending', 'unrecognized'];
const BACKUP_STATES: readonly BackupStatus[] = ['undetermined', 'operator-acknowledged'];
const RESTORE_STATES: readonly RestoreDrillStatus[] = ['not-tested', 'passed', 'failed'];

function requireInstant(value: unknown): string {
  const instant = instantOrNull(value);
  if (instant === null) throw new ApiError('unavailable');
  return instant;
}

function integerOrNull(value: Readonly<Record<string, unknown>>, key: string): number | null {
  return value[key] === null ? null : requireInteger(value, key);
}

function parseCheck(value: unknown, expected: StatusCheck | undefined): StatusCheckRow {
  if (!isRecord(value) || expected === undefined || value['check'] !== expected)
    throw new ApiError('unavailable');
  const observation = value['observation'];
  if (observation === null) return { check: expected, observation: null };
  if (!isRecord(observation)) throw new ApiError('unavailable');
  return {
    check: expected,
    observation: {
      result: oneOf(RESULTS, observation['result']),
      code: oneOf<ObservationCode>(CHECK_CODES[expected], observation['code']),
      evidenceAt: instantOrNull(observation['evidenceAt']),
      evidenceVersion: textOrNull(observation['evidenceVersion']),
      observedAt: requireInstant(observation['observedAt']),
      stale: requireBoolean(observation, 'stale'),
    },
  };
}

function parseDeployment(value: unknown): DeploymentStatus {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const application = requireRecord(value, 'application');
  const adapters = requireRecord(application, 'adapters');
  const migrations = requireRecord(value, 'migrations');
  const queue = requireRecord(value, 'queue');
  const mail = requireRecord(value, 'mail');
  const checks = requireArray(value, 'checks');
  /* The server answers every check, in one order; anything else is not its answer. */
  if (checks.length !== STATUS_CHECKS.length) throw new ApiError('unavailable');
  return {
    application: {
      version: requireString(application, 'version'),
      modules: requireArray(application, 'modules').map((module) => {
        if (typeof module !== 'string' || module === '') throw new ApiError('unavailable');
        return module;
      }),
      adapters: {
        storage: requireString(adapters, 'storage'),
        mail: requireString(adapters, 'mail'),
        identity: requireString(adapters, 'identity'),
      },
    },
    oidc: {
      discoveryConformedAt: requireInstant(requireRecord(value, 'oidc')['discoveryConformedAt']),
    },
    migrations: {
      state: oneOf(MIGRATION_STATES, migrations['state']),
      appliedCount: requireInteger(migrations, 'appliedCount'),
      expectedCount: requireInteger(migrations, 'expectedCount'),
      latestApplied: textOrNull(migrations['latestApplied']),
    },
    queue: {
      due: requireInteger(queue, 'due'),
      running: requireInteger(queue, 'running'),
      failedRecently: requireInteger(queue, 'failedRecently'),
      oldestDueSeconds: integerOrNull(queue, 'oldestDueSeconds'),
    },
    mail: {
      lastDeliveredAt: instantOrNull(mail['lastDeliveredAt']),
      failedRecently: requireInteger(mail, 'failedRecently'),
    },
    checks: checks.map((check, index) => parseCheck(check, STATUS_CHECKS[index])),
  };
}

function parseContent(value: unknown): ContentStatus {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const recovery = requireRecord(value, 'recovery');
  return {
    processing: { failedCount: requireInteger(requireRecord(value, 'processing'), 'failedCount') },
    recovery: {
      backupStatus: oneOf(BACKUP_STATES, recovery['backupStatus']),
      backupRetention: textOrNull(recovery['backupRetention']),
      recoveryExpectation: textOrNull(recovery['recoveryExpectation']),
      acknowledgedAt: instantOrNull(recovery['acknowledgedAt']),
      restoreDrillStatus: oneOf(RESTORE_STATES, recovery['restoreDrillStatus']),
      restoreDrillAt: instantOrNull(recovery['restoreDrillAt']),
    },
  };
}

export async function loadInstallationStatus(signal?: AbortSignal): Promise<InstallationStatus> {
  const options = signal === undefined ? {} : { signal };
  const [deployment, content] = await Promise.all([
    json({ method: 'GET', path: '/api/status', ...options }),
    json({ method: 'GET', path: '/api/status/content', ...options }),
  ]);
  return { deployment: parseDeployment(deployment), content: parseContent(content) };
}
```

In `apps/web-client/src/api/client.ts`, add:

```ts
export {
  loadInstallationStatus,
  type CheckObservation,
  type ContentStatus,
  type DeploymentStatus,
  type InstallationStatus,
  type ObservationCode,
  type StatusCheck,
  type StatusCheckRow,
} from './status.ts';
```

- [ ] **Step 5: Write the section's read and its rows**

Create `apps/web-client/src/workspace/useLoad.ts`:

```ts
/**
 * One read a section owns: loading until it answers, then the value or its presented
 * failure. Reloading drops the answer on screen before asking again, so nothing built from a
 * superseded answer stays pressable. `loader` must be stable — a module-level function.
 */
import { useCallback, useEffect, useState } from 'react';
import { presentFailure, type PresentedFailure } from './failures.ts';
import type { Load } from './state.ts';

export interface LoadedSection<T> {
  readonly load: Load<T>;
  /** The presented cause of a failed load, for choosing its recovery. */
  readonly failure: PresentedFailure | null;
  readonly reload: () => void;
}

export function useLoad<T>(loader: (signal: AbortSignal) => Promise<T>): LoadedSection<T> {
  const [token, setToken] = useState(0);
  const [load, setLoad] = useState<Load<T>>({ kind: 'loading' });
  const [failure, setFailure] = useState<PresentedFailure | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loader(controller.signal).then(
      (value) => {
        setLoad({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const presented = presentFailure(error);
        setLoad({ kind: 'failed', failure: presented.body });
        setFailure(presented);
      },
    );
    return () => {
      controller.abort();
    };
  }, [loader, token]);

  const reload = useCallback(() => {
    setLoad({ kind: 'loading' });
    setFailure(null);
    setToken((current) => current + 1);
  }, []);

  return { load, failure, reload };
}
```

Create `apps/web-client/src/workspace/status-rows.ts`:

```ts
/**
 * The Status section's rows, in §20.2's order, from what the server returned. Pure, so every
 * wording and state decision is tested without a browser.
 */
import type {
  CheckObservation,
  InstallationStatus,
  ObservationCode,
  StatusCheck,
} from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';

export type RowState = 'pass' | 'attention' | 'fail' | 'unchecked' | 'stale';

/** What instant a row speaks for: read just now, recorded at an instant, or never recorded. */
export type RowTime =
  | { readonly kind: 'now' }
  | { readonly kind: 'at'; readonly iso: string }
  | { readonly kind: 'never' };

export interface StatusRow {
  readonly id: string;
  readonly label: MessageKey;
  readonly state: RowState;
  readonly details: readonly string[];
  readonly time: RowTime;
}

export const STATE_LABEL: Readonly<Record<RowState, MessageKey>> = {
  pass: 'status.state.pass',
  attention: 'status.state.attention',
  fail: 'status.state.fail',
  unchecked: 'status.state.unchecked',
  stale: 'status.state.stale',
};

const CHECK_LABEL: Readonly<Record<StatusCheck, MessageKey>> = {
  'storage-privacy': 'status.row.storagePrivacy',
  'storage-versioning': 'status.row.storageVersioning',
  scanner: 'status.row.scanner',
  updates: 'status.row.updates',
};

const CODE_COPY: Readonly<Record<ObservationCode, MessageKey>> = {
  ANONYMOUS_ACCESS_REFUSED: 'status.code.ANONYMOUS_ACCESS_REFUSED',
  ANONYMOUS_READ_ALLOWED: 'status.code.ANONYMOUS_READ_ALLOWED',
  ANONYMOUS_LIST_ALLOWED: 'status.code.ANONYMOUS_LIST_ALLOWED',
  STORAGE_PROBE_INCONCLUSIVE: 'status.code.STORAGE_PROBE_INCONCLUSIVE',
  STORAGE_UNREACHABLE: 'status.code.STORAGE_UNREACHABLE',
  VERSIONING_ENABLED: 'status.code.VERSIONING_ENABLED',
  VERSIONING_SUSPENDED: 'status.code.VERSIONING_SUSPENDED',
  VERSIONING_NEVER_ENABLED: 'status.code.VERSIONING_NEVER_ENABLED',
  VERSIONING_NOT_DETECTABLE: 'status.code.VERSIONING_NOT_DETECTABLE',
  SIGNATURES_CURRENT: 'status.code.SIGNATURES_CURRENT',
  SIGNATURES_STALE: 'status.code.SIGNATURES_STALE',
  SCANNER_UNAVAILABLE: 'status.code.SCANNER_UNAVAILABLE',
  UPDATE_CURRENT: 'status.code.UPDATE_CURRENT',
  UPDATE_AVAILABLE: 'status.code.UPDATE_AVAILABLE',
  SECURITY_ADVISORY: 'status.code.SECURITY_ADVISORY',
  UPDATE_MANIFEST_UNVERIFIED: 'status.code.UPDATE_MANIFEST_UNVERIFIED',
  UPDATE_VERSION_UNRECOGNIZED: 'status.code.UPDATE_VERSION_UNRECOGNIZED',
};

const MIGRATION_COPY: Readonly<
  Record<InstallationStatus['deployment']['migrations']['state'], MessageKey>
> = {
  current: 'status.migrations.current',
  pending: 'status.migrations.pending',
  unrecognized: 'status.migrations.unrecognized',
};

const RESTORE: Readonly<
  Record<
    InstallationStatus['content']['recovery']['restoreDrillStatus'],
    { readonly state: RowState; readonly copy: MessageKey }
  >
> = {
  'not-tested': { state: 'attention', copy: 'status.restore.untested' },
  passed: { state: 'pass', copy: 'status.restore.passed' },
  failed: { state: 'fail', copy: 'status.restore.failed' },
};

/** How long due work may wait before the queue reads as backed up. */
const BACKLOG_SECONDS = 15 * 60;
const NOW: RowTime = { kind: 'now' };
const recorded = (iso: string | null): RowTime => (iso === null ? { kind: 'never' } : { kind: 'at', iso });

/** A server instant in the reader's locale; the ISO value stays available beside it. */
export function formatInstant(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Whole days between two server instants, never the browser's clock. */
function wholeDays(later: string, earlier: string): number {
  return Math.max(0, Math.floor((Date.parse(later) - Date.parse(earlier)) / 86_400_000));
}

function observationRow(check: StatusCheck, observation: CheckObservation | null): StatusRow {
  if (observation === null)
    return {
      id: check,
      label: CHECK_LABEL[check],
      state: 'unchecked',
      details: [
        translate(check === 'updates' ? 'status.unchecked.updates' : 'status.unchecked.worker'),
      ],
      time: { kind: 'never' },
    };
  const details = [translate(CODE_COPY[observation.code])];
  if (observation.evidenceAt !== null)
    details.push(
      translate('status.scanner.builtAt', {
        date: formatInstant(observation.evidenceAt),
        days: wholeDays(observation.observedAt, observation.evidenceAt),
      }),
    );
  if (observation.evidenceVersion !== null)
    details.push(translate('status.updates.offered', { version: observation.evidenceVersion }));
  /* The last known answer to a failing check is still failing, however old it is. */
  const state: RowState =
    observation.result === 'fail' ? 'fail' : observation.stale ? 'stale' : observation.result;
  return { id: check, label: CHECK_LABEL[check], state, details, time: recorded(observation.observedAt) };
}

function queueRow({ queue }: InstallationStatus['deployment']): StatusRow {
  const backlogged = queue.oldestDueSeconds !== null && queue.oldestDueSeconds > BACKLOG_SECONDS;
  return {
    id: 'queue',
    label: 'status.row.queue',
    state: backlogged || queue.failedRecently > 0 ? 'attention' : 'pass',
    details: [
      translate('status.queue.counts', { due: queue.due, running: queue.running }),
      ...(queue.failedRecently > 0
        ? [translate('status.queue.failed', { count: queue.failedRecently })]
        : []),
      ...(backlogged && queue.oldestDueSeconds !== null
        ? [translate('status.queue.backlog', { minutes: Math.floor(queue.oldestDueSeconds / 60) })]
        : []),
    ],
    time: NOW,
  };
}

function mailRow({ mail }: InstallationStatus['deployment']): StatusRow {
  if (mail.failedRecently > 0)
    return {
      id: 'mail',
      label: 'status.row.mail',
      state: 'fail',
      details: [translate('status.mail.failing', { count: mail.failedRecently })],
      time: recorded(mail.lastDeliveredAt),
    };
  return mail.lastDeliveredAt === null
    ? {
        id: 'mail',
        label: 'status.row.mail',
        state: 'unchecked',
        details: [translate('status.mail.untested')],
        time: { kind: 'never' },
      }
    : {
        id: 'mail',
        label: 'status.row.mail',
        state: 'pass',
        details: [translate('status.mail.delivering')],
        time: recorded(mail.lastDeliveredAt),
      };
}

function backupsRow({ recovery }: InstallationStatus['content']): StatusRow {
  if (recovery.backupStatus === 'undetermined')
    return {
      id: 'backups',
      label: 'status.row.backups',
      state: 'attention',
      details: [translate('status.backups.undetermined')],
      time: { kind: 'never' },
    };
  return {
    id: 'backups',
    label: 'status.row.backups',
    state: 'pass',
    details: [
      translate('status.backups.acknowledged'),
      ...(recovery.backupRetention === null
        ? []
        : [translate('status.backups.retention', { retention: recovery.backupRetention })]),
      ...(recovery.recoveryExpectation === null
        ? []
        : [translate('status.backups.expectation', { expectation: recovery.recoveryExpectation })]),
    ],
    time: recorded(recovery.acknowledgedAt),
  };
}

export function statusRows(status: InstallationStatus): readonly StatusRow[] {
  const { deployment, content } = status;
  const check = (name: StatusCheck): StatusRow =>
    observationRow(
      name,
      deployment.checks.find((row) => row.check === name)?.observation ?? null,
    );
  const { application, migrations } = deployment;
  return [
    {
      id: 'application',
      label: 'status.row.application',
      state: 'pass',
      details: [
        translate('status.application.version', { version: application.version }),
        translate('status.application.modules', { modules: application.modules.join(', ') }),
        translate('status.application.adapters', { ...application.adapters }),
      ],
      time: NOW,
    },
    {
      id: 'migrations',
      label: 'status.row.migrations',
      state: migrations.state === 'current' ? 'pass' : 'fail',
      details: [
        translate(MIGRATION_COPY[migrations.state], {
          applied: migrations.appliedCount,
          expected: migrations.expectedCount,
        }),
        ...(migrations.latestApplied === null
          ? []
          : [translate('status.migrations.latest', { id: migrations.latestApplied })]),
      ],
      time: NOW,
    },
    check('storage-privacy'),
    check('storage-versioning'),
    check('scanner'),
    queueRow(deployment),
    {
      id: 'processing',
      label: 'status.row.processing',
      state: content.processing.failedCount > 0 ? 'attention' : 'pass',
      details: [
        content.processing.failedCount > 0
          ? translate('status.processing.failed', { count: content.processing.failedCount })
          : translate('status.processing.none'),
      ],
      time: NOW,
    },
    {
      id: 'oidc',
      label: 'status.row.oidc',
      state: 'pass',
      details: [translate('status.oidc.conformed')],
      time: recorded(deployment.oidc.discoveryConformedAt),
    },
    mailRow(deployment),
    backupsRow(content),
    {
      id: 'restore',
      label: 'status.row.restore',
      state: RESTORE[content.recovery.restoreDrillStatus].state,
      details: [translate(RESTORE[content.recovery.restoreDrillStatus].copy)],
      time: recorded(content.recovery.restoreDrillAt),
    },
    check('updates'),
  ];
}
```

- [ ] **Step 6: Write the panel and offer the section**

Create `apps/web-client/src/components/StatusPanel.tsx`:

```tsx
/**
 * The Status section: §20.2's read-only facts as one table, each state in words and each time
 * as a `<time>` carrying its UTC value. It owns no state.
 */
import { useId } from 'react';
import type { InstallationStatus } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import { formatInstant, STATE_LABEL, statusRows, type RowTime } from '../workspace/status-rows.ts';
import type { LoadedSection } from '../workspace/useLoad.ts';
import { classifyLoad } from '../workspace/views/load-state.ts';
import { FailureNotice } from './FailureNotice.tsx';
import { Notice } from './Notice.tsx';

function When({ time }: { readonly time: RowTime }): React.ReactElement {
  if (time.kind === 'now') return <>{translate('status.now')}</>;
  if (time.kind === 'never') return <>{translate('status.never')}</>;
  return (
    <time dateTime={time.iso} title={time.iso}>
      {formatInstant(time.iso)}
    </time>
  );
}

export function StatusPanel({
  section,
}: {
  readonly section: LoadedSection<InstallationStatus>;
}): React.ReactElement {
  const headingId = useId();
  const heading = (
    <h2 id={headingId} className="df-section__heading">
      {translate('status.heading')}
    </h2>
  );
  const { load } = section;

  if (load.kind === 'loading')
    return (
      <section aria-labelledby={headingId}>
        {heading}
        <p className="df-field__help">{translate('status.loading')}</p>
      </section>
    );

  if (load.kind === 'failed') {
    const state = classifyLoad({ failed: true, failure: section.failure });
    return (
      <section aria-labelledby={headingId}>
        {heading}
        {state.denied ? (
          <Notice tone="caution" role="status">
            {translate('status.denied')}
          </Notice>
        ) : section.failure === null ? null : (
          <FailureNotice failure={section.failure} onReload={section.reload} />
        )}
        {state.recovery === 'retry' && section.failure?.offerReload !== true ? (
          <button type="button" className="df-button" onClick={section.reload}>
            {translate('app.retry')}
          </button>
        ) : null}
      </section>
    );
  }

  const rows = statusRows(load.value);
  const failing = rows.filter((row) => row.state === 'fail').length;
  const columns = {
    state: translate('status.column.state'),
    details: translate('status.column.details'),
    time: translate('status.column.time'),
  };
  return (
    <section aria-labelledby={headingId}>
      {heading}
      <p className="df-field__help">{translate('status.intro')}</p>
      {failing === 0 ? null : (
        <Notice tone="problem" role="alert">
          {translate('status.summary.failing', { count: failing })}
        </Notice>
      )}
      <table className="df-register">
        <caption className="df-visually-hidden">{translate('status.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{translate('status.column.check')}</th>
            <th scope="col">{columns.state}</th>
            <th scope="col">{columns.details}</th>
            <th scope="col">{columns.time}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-status={row.state}>
              <th scope="row" className="df-register__name">
                {translate(row.label)}
              </th>
              <td data-label={columns.state}>
                <span className="df-state" data-live={row.state === 'pass' ? 'true' : 'false'}>
                  {translate(STATE_LABEL[row.state])}
                </span>
              </td>
              <td data-label={columns.details}>
                {row.details.map((detail) => (
                  <span key={detail} className="df-register__meta">
                    {detail}
                  </span>
                ))}
              </td>
              <td data-label={columns.time}>
                <When time={row.time} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="df-panel__actions">
        <button type="button" className="df-button" onClick={section.reload}>
          {translate('status.refresh')}
        </button>
      </div>
    </section>
  );
}
```

Create `apps/web-client/src/workspace/views/InstallationSections.tsx`:

```tsx
/**
 * The Administration view's own sections. Each owns its state through its hook, so the view
 * only chooses which one is showing.
 */
import { loadInstallationStatus } from '../../api/client.ts';
import { StatusPanel } from '../../components/StatusPanel.tsx';
import { useLoad } from '../useLoad.ts';

export function StatusSection(): React.ReactElement {
  const section = useLoad(loadInstallationStatus);
  return <StatusPanel section={section} />;
}
```

In `apps/web-client/src/workspace/views/AdministrationView.tsx`, lift the section list to module level with Status beside Members, compose from it, label the inner strip, and render the section:

```ts
const ADMINISTRATION_SECTIONS = [
  { id: 'members', scope: 'top', label: () => translate('workspace.tab.members'), order: 10 },
  { id: 'status', scope: 'top', label: () => translate('workspace.tab.status'), order: 30 },
] as const satisfies readonly SectionTab[];
```

```ts
  const sections = composeSections(ADMINISTRATION_SECTIONS, contributedSections('top'));
```

```tsx
      <SectionNav
        label={translate('administration.sections.label')}
```

```tsx
      {currentId === 'status' ? <StatusSection /> : null}
```

In `apps/web-client/src/routes/Workspace.tsx`, change `ADMINISTRATION_VIEW`'s label to `translate('workspace.tab.administration')`. Nothing else in that file changes.

In `apps/web-client/src/workspace/views/views.unit.test.tsx`, use `messages['workspace.tab.administration']` for the `administration` entry of `VIEWS` and in the assertions that read it, and delete the case "offers the administration view to every member, because visibility is not authorization": since milestone 1 the frame offers it only on `mayAdministerOrganization`, and the case asserts the opposite rule.

In `test/browser/members.spec.ts`, `openMembers` clicks `{ name: 'Administration', exact: true }` instead of `'Members'` (the Members section is the default), and the plain-member case asserts no `'Administration'` button.

- [ ] **Step 7: Add the copy**

In `apps/web-client/src/i18n/en.ts`:

```ts
  'workspace.tab.administration': 'Administration',
  'workspace.tab.status': 'Status',
  'administration.sections.label': 'Administration sections',
  'status.heading': 'Security and deployment status',
  'status.intro':
    'Read-only. Status reports what this installation can observe; it does not configure infrastructure, modules, providers or secrets.',
  'status.loading': 'Loading status',
  'status.denied': 'Status is not available to your role.',
  'status.refresh': 'Check again',
  'status.caption': 'Security and deployment checks',
  'status.column.check': 'Check',
  'status.column.state': 'State',
  'status.column.details': 'Details',
  'status.column.time': 'As of',
  'status.now': 'Now',
  'status.never': 'Never recorded',
  'status.summary.failing': 'Checks failing: {count}.',
  'status.state.pass': 'Passing',
  'status.state.attention': 'Needs attention',
  'status.state.fail': 'Failing',
  'status.state.unchecked': 'Not yet checked',
  'status.state.stale': 'Out of date',
  'status.row.application': 'Application',
  'status.row.migrations': 'Database migrations',
  'status.row.storagePrivacy': 'Storage privacy',
  'status.row.storageVersioning': 'Storage versioning',
  'status.row.scanner': 'Malware signatures',
  'status.row.queue': 'Worker queue',
  'status.row.processing': 'Document processing',
  'status.row.oidc': 'Member sign-in (OIDC)',
  'status.row.mail': 'Required mail',
  'status.row.backups': 'Backups',
  'status.row.restore': 'Restore drill',
  'status.row.updates': 'Updates and advisories',
  'status.application.version': 'Version {version}',
  'status.application.modules': 'Modules: {modules}',
  'status.application.adapters': 'Storage {storage}, mail {mail}, identity {identity}',
  'status.migrations.current': 'All {expected} migrations applied.',
  'status.migrations.pending': '{applied} of {expected} migrations applied. Run db migrate.',
  'status.migrations.unrecognized':
    'The database records {applied} migrations this release did not produce; it expects {expected}.',
  'status.migrations.latest': 'Latest: {id}',
  'status.unchecked.worker': 'The worker checks this every hour.',
  'status.unchecked.updates': 'Run updates check-file with the latest release manifest.',
  'status.code.ANONYMOUS_ACCESS_REFUSED':
    'The storage API refuses unauthenticated requests. A public address the provider serves outside that API is not visible to this check.',
  'status.code.ANONYMOUS_READ_ALLOWED':
    'The storage API answers unauthenticated requests about objects. Turn public access off.',
  'status.code.ANONYMOUS_LIST_ALLOWED':
    'The storage API lists the bucket to unauthenticated requests. Turn public access off.',
  'status.code.STORAGE_PROBE_INCONCLUSIVE': 'The storage API gave an answer this check cannot read.',
  'status.code.STORAGE_UNREACHABLE': 'The worker could not reach object storage.',
  'status.code.VERSIONING_ENABLED': 'Object versioning is enabled.',
  'status.code.VERSIONING_SUSPENDED':
    'Object versioning is suspended, so deleted or overwritten objects cannot be restored.',
  'status.code.VERSIONING_NEVER_ENABLED': 'Object versioning has never been enabled.',
  'status.code.VERSIONING_NOT_DETECTABLE':
    'Versioning cannot be read with the worker credential or this provider. Confirm it with your provider.',
  'status.code.SIGNATURES_CURRENT': 'Signatures are less than a day old.',
  'status.code.SIGNATURES_STALE':
    'Signatures are more than a day old. New uploads cannot be scanned until they update.',
  'status.code.SCANNER_UNAVAILABLE':
    'The worker could not reach the scanner. New uploads cannot be scanned until it answers.',
  'status.code.UPDATE_CURRENT': 'No newer release is known.',
  'status.code.UPDATE_AVAILABLE': 'A newer release is available.',
  'status.code.SECURITY_ADVISORY': 'A newer release fixes a security advisory. Upgrade.',
  'status.code.UPDATE_MANIFEST_UNVERIFIED':
    'The last release manifest checked did not verify. Do not use it.',
  'status.code.UPDATE_VERSION_UNRECOGNIZED':
    'The last release manifest named a version this release cannot compare.',
  'status.scanner.builtAt': 'Built {date}, {days} days before this check.',
  'status.updates.offered': 'Offered release: {version}',
  'status.queue.counts': '{due} jobs waiting, {running} running.',
  'status.queue.failed': '{count} jobs failed after every retry in the last seven days.',
  'status.queue.backlog': 'The oldest waiting job has waited {minutes} minutes.',
  'status.processing.none': 'No document versions have failed processing.',
  'status.processing.failed':
    '{count} document versions failed processing. Members can retry them from Processing.',
  'status.oidc.conformed':
    'Discovery and client authentication conformed when this web process started.',
  'status.mail.delivering': 'Sign-in and invitation mail is being delivered.',
  'status.mail.failing':
    '{count} sign-in or invitation messages could not be delivered after every retry in the last seven days.',
  'status.mail.untested': 'No sign-in or invitation mail has been sent yet.',
  'status.backups.acknowledged': 'Backups are acknowledged by the operator.',
  'status.backups.retention': 'Retention: {retention}',
  'status.backups.expectation': 'Recovery expectation: {expectation}',
  'status.backups.undetermined':
    'Backup status has not been recorded. Run backup-status acknowledge after checking with your provider.',
  'status.restore.untested': 'No restore drill has been recorded.',
  'status.restore.passed': 'The last restore drill passed.',
  'status.restore.failed': 'The last restore drill did not pass.',
```

- [ ] **Step 8: Point the maps at the browser side**

In the `CODEBASE_MAP.md` installation row, replace the browser cell with `[status API](apps/web-client/src/api/status.ts), [status rows](apps/web-client/src/workspace/status-rows.ts), [status panel](apps/web-client/src/components/StatusPanel.tsx), [installation status HTTP contract](docs/installation-status-http-contract.md)`. In `modules/core-security/README.md`'s Installation status list, add `- [Browser status API](../../apps/web-client/src/api/status.ts) and [status panel](../../apps/web-client/src/components/StatusPanel.tsx)`.

- [ ] **Step 9: Run the tests to verify they pass**

```bash
npx vitest run --project unit --maxWorkers=2
npm run typecheck && npm run lint
npm run build
node --env-file=.env ./node_modules/@playwright/test/cli.js test test/browser/members.spec.ts --project=chromium
wc -l apps/web-client/src/workspace/views/AdministrationView.tsx apps/web-client/src/routes/Workspace.tsx apps/web-client/src/i18n/en.ts
```

Browser suites serve the built client (`test/support/browser-server.ts` loads `apps/web-client/dist`), so rebuild before any browser run.

Expected: PASS; `AdministrationView.tsx` at most 200 lines, `Workspace.tsx` 535, `en.ts` under 1000.

- [ ] **Step 10: Commit**

```bash
git add apps/web-client/src modules/core-security/README.md test/unit/status-codes.test.ts test/browser/members.spec.ts CODEBASE_MAP.md
git commit -m "Show installation status to Owners and Admins"
```

---

### Task 8: The Installation section

**Files:**
- Create: `apps/web-client/src/api/installation.ts`, `apps/web-client/src/api/installation.unit.test.ts`
- Modify: `apps/web-client/src/api/client.ts` (re-export)
- Create: `apps/web-client/src/workspace/useInstallationSettings.ts`
- Create: `apps/web-client/src/components/InstallationPanel.tsx`, `apps/web-client/src/components/InstallationDownloadControls.tsx`, `apps/web-client/src/components/InstallationDownloadControls.unit.test.tsx`
- Modify: `apps/web-client/src/workspace/views/InstallationSections.tsx` (append `InstallationSection`)
- Modify: `apps/web-client/src/workspace/views/AdministrationView.tsx` (Installation entry and render)
- Modify: `apps/web-client/src/i18n/en.ts`
- Modify: `CODEBASE_MAP.md`, `modules/participants-access/README.md`

**Interfaces:**
- Consumes: `GET /api/installation`, `POST /api/installation/download-policy` (Task 6); `useLoad`, `LoadedSection` (Task 7); `settle`, `committed` (`outcome.ts`); `ConfirmationDialog`, `Confirmation`, `ConfirmationContent`.
- Produces:
  - `loadInstallationSettings(signal?)`, `reviewInstallationDownload(policy)`, `applyInstallationDownload(change)`; types `InstallationSettings`, `InstallationDownloadImpact` (a union discriminated by `proposedPolicy`), `InstallationDownloadChange`.
  - `useInstallationSettings(): InstallationSettingsSection` — `LoadedSection<InstallationSettings>` plus `reviewDownload(policy): Promise<Outcome<InstallationDownloadImpact>>` and `applyDownload(change): Promise<PresentedFailure | null>`.
  - `InstallationPanel`, `InstallationDownloadControls`, `confirmationFor(impact, finish): Confirmation`; `InstallationSection({onStatus})`.

The review's type carries the asymmetry: an allowing review holds its phrase and needs a fresh sign-in, a denying one holds neither, and the parser refuses any other pairing. `confirmationFor` therefore cannot turn a review of one direction into a change of the other.

- [ ] **Step 1: Write the failing tests**

Create `apps/web-client/src/api/installation.unit.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadInstallationSettings, reviewInstallationDownload } from './installation.ts';

function stub(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
});

const ALLOW = {
  currentPolicy: 'deny',
  proposedPolicy: 'allow',
  inheritingRoomCount: 4,
  affectedDocumentCount: 12,
  requiresFreshAuthentication: true,
  expectedRevision: 3,
  confirmation: 'ALLOW ORIGINAL DOWNLOADS',
};

describe('the installation client', () => {
  it('reads the settings', async () => {
    stub({ settings: { downloadPolicy: 'deny', revision: 3, inheritingRoomCount: 4 } });
    expect(await loadInstallationSettings()).toStrictEqual({
      downloadPolicy: 'deny',
      revision: 3,
      inheritingRoomCount: 4,
    });
  });

  it('reads an allowing review with its phrase, and a denying one without', async () => {
    stub({ impact: ALLOW });
    expect(await reviewInstallationDownload('allow')).toStrictEqual(ALLOW);
    stub({
      impact: {
        ...ALLOW,
        currentPolicy: 'allow',
        proposedPolicy: 'deny',
        requiresFreshAuthentication: false,
        confirmation: null,
      },
    });
    expect((await reviewInstallationDownload('deny')).confirmation).toBeNull();
  });

  it.each([
    ['an allowing review with no phrase', { ...ALLOW, confirmation: null }],
    ['an allowing review that needs no sign-in', { ...ALLOW, requiresFreshAuthentication: false }],
    ['a denying review with a phrase', { ...ALLOW, proposedPolicy: 'deny', requiresFreshAuthentication: false }],
    ['a policy it does not know', { ...ALLOW, proposedPolicy: 'sometimes' }],
  ])('fails closed on %s', async (_label, impact) => {
    stub({ impact });
    await expect(reviewInstallationDownload('allow')).rejects.toMatchObject({
      failure: 'unavailable',
    });
  });
});
```

Create `apps/web-client/src/components/InstallationDownloadControls.unit.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { InstallationDownloadImpact } from '../api/client.ts';
import { messages } from '../i18n/en.ts';
import type { InstallationSettingsSection } from '../workspace/useInstallationSettings.ts';
import { confirmationFor, InstallationDownloadControls } from './InstallationDownloadControls.tsx';

const COUNTS = { inheritingRoomCount: 4, affectedDocumentCount: 12, expectedRevision: 3 };
const ALLOW: InstallationDownloadImpact = {
  ...COUNTS,
  currentPolicy: 'deny',
  proposedPolicy: 'allow',
  requiresFreshAuthentication: true,
  confirmation: 'ALLOW ORIGINAL DOWNLOADS',
};
const DENY: InstallationDownloadImpact = {
  ...COUNTS,
  currentPolicy: 'allow',
  proposedPolicy: 'deny',
  requiresFreshAuthentication: false,
  confirmation: null,
};

describe('confirmationFor', () => {
  it('asks for the server’s phrase before allowing, and sends what was typed', async () => {
    const finish = vi.fn().mockResolvedValue(null);
    const confirmation = confirmationFor(ALLOW, finish);
    expect(confirmation.phrase).toBe('ALLOW ORIGINAL DOWNLOADS');
    if (confirmation.phrase === null) throw new Error('phrase expected');
    await confirmation.confirm('ALLOW ORIGINAL DOWNLOADS');
    expect(finish).toHaveBeenCalledWith({
      policy: 'allow',
      expectedRevision: 3,
      confirmation: 'ALLOW ORIGINAL DOWNLOADS',
    });
  });

  it('denies on one press, with no phrase', async () => {
    const finish = vi.fn().mockResolvedValue(null);
    const confirmation = confirmationFor(DENY, finish);
    expect(confirmation.phrase).toBeNull();
    if (confirmation.phrase !== null) throw new Error('no phrase expected');
    await confirmation.confirm();
    expect(finish).toHaveBeenCalledWith({ policy: 'deny', expectedRevision: 3 });
  });
});

describe('InstallationDownloadControls', () => {
  const section = {} as InstallationSettingsSection;

  it('names the current default in words and offers only the opposite change', () => {
    const markup = renderToStaticMarkup(
      <InstallationDownloadControls
        settings={{ downloadPolicy: 'deny', revision: 3, inheritingRoomCount: 4 }}
        section={section}
        onStatus={() => undefined}
      />,
    );
    expect(markup).toContain(messages['installation.download.denied']);
    expect(markup).toContain(messages['installation.download.allow']);
    expect(markup).not.toContain(messages['installation.download.deny']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run --project unit --maxWorkers=2 installation InstallationDownloadControls
```

Expected: FAIL — `installation.ts` and `InstallationDownloadControls.tsx` do not exist.

- [ ] **Step 3: Write the client and the section state**

Create `apps/web-client/src/api/installation.ts`:

```ts
/**
 * The installation-wide download default: its read, its review, and its change.
 */
import type { DownloadPolicy } from './room-settings.ts';
import {
  ApiError,
  isRecord,
  json,
  oneOf,
  requireBoolean,
  requireInteger,
  requireRecord,
  textOrNull,
} from './transport.ts';

export interface InstallationSettings {
  readonly downloadPolicy: DownloadPolicy;
  readonly revision: number;
  readonly inheritingRoomCount: number;
}

interface ImpactCounts {
  readonly currentPolicy: DownloadPolicy;
  readonly inheritingRoomCount: number;
  readonly affectedDocumentCount: number;
  readonly expectedRevision: number;
}

/** Allowing carries its phrase and needs a fresh sign-in; denying carries neither. */
export type InstallationDownloadImpact =
  | (ImpactCounts & {
      readonly proposedPolicy: 'allow';
      readonly confirmation: string;
      readonly requiresFreshAuthentication: true;
    })
  | (ImpactCounts & {
      readonly proposedPolicy: 'deny';
      readonly confirmation: null;
      readonly requiresFreshAuthentication: false;
    });

export type InstallationDownloadChange =
  | { readonly policy: 'allow'; readonly expectedRevision: number; readonly confirmation: string }
  | { readonly policy: 'deny'; readonly expectedRevision: number };

const POLICIES: readonly DownloadPolicy[] = ['allow', 'deny'];
const PATH = '/api/installation/download-policy';

export async function loadInstallationSettings(
  signal?: AbortSignal,
): Promise<InstallationSettings> {
  const payload = await json({
    method: 'GET',
    path: '/api/installation',
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const settings = requireRecord(payload, 'settings');
  return {
    downloadPolicy: oneOf(POLICIES, settings['downloadPolicy']),
    revision: requireInteger(settings, 'revision'),
    inheritingRoomCount: requireInteger(settings, 'inheritingRoomCount'),
  };
}

export async function reviewInstallationDownload(
  policy: DownloadPolicy,
): Promise<InstallationDownloadImpact> {
  const payload = await json({ method: 'POST', path: PATH, body: { action: 'dry-run', policy } });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const impact = requireRecord(payload, 'impact');
  const counts: ImpactCounts = {
    currentPolicy: oneOf(POLICIES, impact['currentPolicy']),
    inheritingRoomCount: requireInteger(impact, 'inheritingRoomCount'),
    affectedDocumentCount: requireInteger(impact, 'affectedDocumentCount'),
    expectedRevision: requireInteger(impact, 'expectedRevision'),
  };
  const fresh = requireBoolean(impact, 'requiresFreshAuthentication');
  const confirmation = textOrNull(impact['confirmation']);
  if (oneOf(POLICIES, impact['proposedPolicy']) === 'allow') {
    if (!fresh || confirmation === null) throw new ApiError('unavailable');
    return { ...counts, proposedPolicy: 'allow', confirmation, requiresFreshAuthentication: true };
  }
  if (fresh || confirmation !== null) throw new ApiError('unavailable');
  return { ...counts, proposedPolicy: 'deny', confirmation: null, requiresFreshAuthentication: false };
}

export async function applyInstallationDownload(change: InstallationDownloadChange): Promise<void> {
  const payload = await json({ method: 'POST', path: PATH, body: { action: 'apply', ...change } });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  requireInteger(payload, 'revision');
}
```

Re-export from `apps/web-client/src/api/client.ts`:

```ts
export {
  applyInstallationDownload,
  loadInstallationSettings,
  reviewInstallationDownload,
  type InstallationDownloadChange,
  type InstallationDownloadImpact,
  type InstallationSettings,
} from './installation.ts';
```

Create `apps/web-client/src/workspace/useInstallationSettings.ts`:

```ts
/**
 * The Installation section's read and its one change. A committed change re-reads the
 * settings, because the revision the next change must send has moved.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  applyInstallationDownload,
  loadInstallationSettings,
  reviewInstallationDownload,
  type DownloadPolicy,
  type InstallationDownloadChange,
  type InstallationDownloadImpact,
  type InstallationSettings,
} from '../api/client.ts';
import type { PresentedFailure } from './failures.ts';
import { committed, settle, type Outcome } from './outcome.ts';
import { useLoad, type LoadedSection } from './useLoad.ts';

export interface InstallationSettingsSection extends LoadedSection<InstallationSettings> {
  readonly reviewDownload: (
    policy: DownloadPolicy,
  ) => Promise<Outcome<InstallationDownloadImpact>>;
  readonly applyDownload: (change: InstallationDownloadChange) => Promise<PresentedFailure | null>;
}

export function useInstallationSettings(): InstallationSettingsSection {
  const loaded = useLoad(loadInstallationSettings);
  const { reload } = loaded;
  /* Alive across the await, so a change that resolves after the section was left does not
     re-read a section nobody is looking at. */
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const applyDownload = useCallback(
    async (change: InstallationDownloadChange): Promise<PresentedFailure | null> => {
      const failure = await committed(applyInstallationDownload(change));
      if (failure === null && mounted.current) reload();
      return failure;
    },
    [reload],
  );
  return {
    ...loaded,
    reviewDownload: (policy) => settle(reviewInstallationDownload(policy)),
    applyDownload,
  };
}
```

`DownloadPolicy` must be re-exported from `api/client.ts`; it already is, with the room settings types.

- [ ] **Step 4: Write the controls and the panel**

Create `apps/web-client/src/components/InstallationDownloadControls.tsx`:

```tsx
/**
 * The installation-wide original-download default: stated in words, with the one change
 * that differs from it. Both directions open on the server's review of what the change
 * reaches; allowing then takes the server's phrase and a fresh sign-in, denying one press.
 */
import { useRef, useState } from 'react';
import type {
  DownloadPolicy,
  InstallationDownloadChange,
  InstallationDownloadImpact,
  InstallationSettings,
} from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import type { InstallationSettingsSection } from '../workspace/useInstallationSettings.ts';
import {
  ConfirmationDialog,
  type Confirmation,
  type ConfirmationContent,
} from './ConfirmationDialog.tsx';

const COPY: Readonly<
  Record<
    DownloadPolicy,
    {
      readonly name: MessageKey;
      readonly change: MessageKey;
      readonly title: MessageKey;
      readonly consequence: MessageKey;
      readonly done: MessageKey;
    }
  >
> = {
  allow: {
    name: 'installation.download.allowed',
    change: 'installation.download.allow',
    title: 'installation.download.allow.title',
    consequence: 'installation.download.allow.consequence',
    done: 'installation.download.done.allow',
  },
  deny: {
    name: 'installation.download.denied',
    change: 'installation.download.deny',
    title: 'installation.download.deny.title',
    consequence: 'installation.download.deny.consequence',
    done: 'installation.download.done.deny',
  },
};

const OPPOSITE: Readonly<Record<DownloadPolicy, DownloadPolicy>> = { allow: 'deny', deny: 'allow' };

/** The phrase is the server's and belongs to allowing; denying takes one press. */
export function confirmationFor(
  impact: InstallationDownloadImpact,
  finish: (change: InstallationDownloadChange) => Promise<PresentedFailure | null>,
): Confirmation {
  if (impact.proposedPolicy === 'allow')
    return {
      phrase: impact.confirmation,
      confirm: (typed) =>
        finish({ policy: 'allow', expectedRevision: impact.expectedRevision, confirmation: typed }),
    };
  return {
    phrase: null,
    confirm: () => finish({ policy: 'deny', expectedRevision: impact.expectedRevision }),
  };
}

function Consequence({ impact }: { readonly impact: InstallationDownloadImpact }): React.ReactElement {
  return (
    <>
      <p>
        {translate(COPY[impact.proposedPolicy].consequence, {
          rooms: impact.inheritingRoomCount,
          documents: impact.affectedDocumentCount,
        })}
      </p>
      {impact.requiresFreshAuthentication ? (
        <p className="df-field__help">{translate('installation.download.freshSignIn')}</p>
      ) : null}
    </>
  );
}

export interface InstallationDownloadControlsProps {
  readonly settings: InstallationSettings;
  readonly section: InstallationSettingsSection;
  readonly onStatus: (message: string) => void;
}

export function InstallationDownloadControls({
  settings,
  section,
  onStatus,
}: InstallationDownloadControlsProps): React.ReactElement {
  const [dialogue, setDialogue] = useState<{
    readonly review: number;
    readonly content: ConfirmationContent;
  } | null>(null);
  /* Every opening is its own review, so a slow answer cannot replace a newer one. */
  const reviews = useRef(0);
  const proposed = OPPOSITE[settings.downloadPolicy];

  const finish = async (change: InstallationDownloadChange): Promise<PresentedFailure | null> => {
    const failure = await section.applyDownload(change);
    if (failure === null) onStatus(translate(COPY[change.policy].done));
    return failure;
  };

  const begin = (): void => {
    reviews.current += 1;
    const review = reviews.current;
    setDialogue({ review, content: { kind: 'loading' } });
    void section.reviewDownload(proposed).then((outcome) => {
      setDialogue((current) =>
        current?.review !== review
          ? current
          : {
              review,
              content: outcome.ok
                ? {
                    kind: 'ready',
                    consequence: <Consequence impact={outcome.value} />,
                    confirmation: confirmationFor(outcome.value, finish),
                  }
                : { kind: 'failed', failure: outcome.failure },
            },
      );
    });
  };

  return (
    <div className="df-panel__block">
      <h3 className="df-panel__subheading">{translate('installation.download.heading')}</h3>
      <p>
        <strong>{translate(COPY[settings.downloadPolicy].name)}</strong> —{' '}
        {translate('installation.download.explain', { rooms: settings.inheritingRoomCount })}
      </p>
      <div className="df-panel__actions">
        <button
          type="button"
          className={proposed === 'allow' ? 'df-button df-button--primary' : 'df-button'}
          onClick={begin}
        >
          {translate(COPY[proposed].change)}
        </button>
      </div>
      <ConfirmationDialog
        open={dialogue !== null}
        title={translate(COPY[proposed].title)}
        submitLabel={translate(COPY[proposed].change)}
        pendingLabel={translate('settings.pending')}
        content={dialogue?.content ?? { kind: 'loading' }}
        onClose={() => {
          setDialogue(null);
        }}
        onReload={section.reload}
      />
    </div>
  );
}
```

Create `apps/web-client/src/components/InstallationPanel.tsx`:

```tsx
/**
 * The Installation section: settings that apply to every room at once. It owns no state;
 * `useInstallationSettings` does.
 */
import { useId } from 'react';
import { translate } from '../i18n/translate.ts';
import type { InstallationSettingsSection } from '../workspace/useInstallationSettings.ts';
import { classifyLoad } from '../workspace/views/load-state.ts';
import { FailureNotice } from './FailureNotice.tsx';
import { InstallationDownloadControls } from './InstallationDownloadControls.tsx';
import { Notice } from './Notice.tsx';

export function InstallationPanel({
  section,
  onStatus,
}: {
  readonly section: InstallationSettingsSection;
  readonly onStatus: (message: string) => void;
}): React.ReactElement {
  const headingId = useId();
  const heading = (
    <h2 id={headingId} className="df-section__heading">
      {translate('installation.heading')}
    </h2>
  );
  const { load } = section;

  if (load.kind === 'loading')
    return (
      <section aria-labelledby={headingId}>
        {heading}
        <p className="df-field__help">{translate('installation.loading')}</p>
      </section>
    );

  if (load.kind === 'failed') {
    const state = classifyLoad({ failed: true, failure: section.failure });
    return (
      <section aria-labelledby={headingId}>
        {heading}
        {state.denied ? (
          <Notice tone="caution" role="status">
            {translate('installation.denied')}
          </Notice>
        ) : section.failure === null ? null : (
          <FailureNotice failure={section.failure} onReload={section.reload} />
        )}
        {state.recovery === 'retry' && section.failure?.offerReload !== true ? (
          <button type="button" className="df-button" onClick={section.reload}>
            {translate('app.retry')}
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId}>
      {heading}
      <InstallationDownloadControls
        key={load.value.revision}
        settings={load.value}
        section={section}
        onStatus={onStatus}
      />
    </section>
  );
}
```

Append to `apps/web-client/src/workspace/views/InstallationSections.tsx` (and import `InstallationPanel` and `useInstallationSettings`):

```tsx
export function InstallationSection({
  onStatus,
}: {
  readonly onStatus: (message: string) => void;
}): React.ReactElement {
  const section = useInstallationSettings();
  return <InstallationPanel section={section} onStatus={onStatus} />;
}
```

In `AdministrationView.tsx`, add the Installation entry between Members and Status and render it:

```ts
  {
    id: 'installation',
    scope: 'top',
    label: () => translate('workspace.tab.installation'),
    order: 20,
  },
```

```tsx
      {currentId === 'installation' ? <InstallationSection onStatus={onStatus} /> : null}
```

- [ ] **Step 5: Add the copy**

In `apps/web-client/src/i18n/en.ts`:

```ts
  'workspace.tab.installation': 'Installation',
  'installation.heading': 'Installation settings',
  'installation.loading': 'Loading installation settings',
  'installation.denied': 'Installation settings are not available to your role.',
  'installation.download.heading': 'Original downloads',
  'installation.download.allowed': 'Allowed by default',
  'installation.download.denied': 'Denied by default',
  'installation.download.explain':
    'Every room and document without its own policy inherits this. {rooms} rooms inherit it now.',
  'installation.download.allow': 'Allow original downloads',
  'installation.download.deny': 'Deny original downloads',
  'installation.download.allow.title': 'Allow original downloads installation-wide',
  'installation.download.deny.title': 'Deny original downloads installation-wide',
  'installation.download.allow.consequence':
    'Viewers will be able to download originals in the {rooms} rooms that inherit this default, including {documents} published documents they can open now.',
  'installation.download.deny.consequence':
    'Original downloads stop in the {rooms} rooms that inherit this default, including {documents} published documents viewers can open now. Rooms and documents with their own policy keep it.',
  'installation.download.freshSignIn': 'This change needs a sign-in within the last 15 minutes.',
  'installation.download.done.allow': 'Original downloads are now allowed by default.',
  'installation.download.done.deny': 'Original downloads are now denied by default.',
```

- [ ] **Step 6: Point the maps at the browser side**

In the `CODEBASE_MAP.md` installation row, add `[installation API](apps/web-client/src/api/installation.ts)` and `[installation panel](apps/web-client/src/components/InstallationPanel.tsx)` to the browser cell. In `modules/participants-access/README.md`, add `- [Browser installation API](../../apps/web-client/src/api/installation.ts), [state](../../apps/web-client/src/workspace/useInstallationSettings.ts) and [panel](../../apps/web-client/src/components/InstallationPanel.tsx)` to `## Start here`.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npx vitest run --project unit --maxWorkers=2
npm run typecheck && npm run lint
wc -l apps/web-client/src/workspace/views/AdministrationView.tsx apps/web-client/src/i18n/en.ts
```

Expected: PASS; `AdministrationView.tsx` at most 200 lines; `en.ts` under 1000.

- [ ] **Step 8: Commit**

```bash
git add apps/web-client/src CODEBASE_MAP.md modules/participants-access/README.md
git commit -m "Set the installation download default from the Installation section"
```

---

### Task 9: Browser journeys, accessibility, and the record

**Files:**
- Create: `test/support/status-seeding.ts`
- Create: `test/browser/installation-status.spec.ts`
- Modify: `DESIGN.md` (Components; Security-bearing UI decisions)
- Modify: `docs/security/threat-model.md`, `docs/self-hosting.md` (a Status section), `docs/release-evidence.md`
- Modify: `CODEBASE_MAP.md` (the installation row's browser test)

**Interfaces:**
- Consumes: everything above; `startTestServer`, `TestServer.migrationPool`, `signInMember({globalRole, roomTitle, roomRole})` (`test/support/browser-server.ts`); `makeSessionStale` (`test/support/room-seeding.ts`); `settleTheme` (`test/browser/theme.ts`).
- Produces: no application code.

Each journey starts from seeded facts and makes every change it asserts through the product. The installation default is one value shared by every test in the file, so each journey that changes it leaves it as it found it.

- [ ] **Step 1: Write the seeding helper**

Create `test/support/status-seeding.ts`:

```ts
/**
 * Status facts a browser journey starts from, written as the migration role the way the
 * worker and the CLI record them.
 */
import type { Pool } from 'pg';

export async function seedStatusObservation(
  pool: Pool,
  observation: {
    readonly check: 'storage-privacy' | 'storage-versioning' | 'scanner' | 'updates';
    readonly result: 'pass' | 'attention' | 'fail';
    readonly code: string;
    readonly evidenceAt?: Date;
    readonly evidenceVersion?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO deployment_status_observation
       (check_name,result,code,evidence_at,evidence_version,observed_at)
     VALUES($1,$2,$3,$4,$5,statement_timestamp())
     ON CONFLICT (check_name) DO UPDATE
       SET result=EXCLUDED.result,code=EXCLUDED.code,evidence_at=EXCLUDED.evidence_at,
           evidence_version=EXCLUDED.evidence_version,observed_at=EXCLUDED.observed_at`,
    [
      observation.check,
      observation.result,
      observation.code,
      observation.evidenceAt ?? null,
      observation.evidenceVersion ?? null,
    ],
  );
}
```

- [ ] **Step 2: Write the journeys**

Create `test/browser/installation-status.spec.ts`:

```ts
/**
 * Installation status and the installation download default, as the Owner and an Admin who
 * may use them and the members who may not, in both themes, by keyboard and at 320 CSS pixels.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { startTestServer, type TestServer } from '../support/browser-server.ts';
import { makeSessionStale } from '../support/room-seeding.ts';
import { seedStatusObservation } from '../support/status-seeding.ts';
import { settleTheme } from './theme.ts';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  await server.close();
});

async function signIn(
  page: Page,
  options: Parameters<TestServer['signInMember']>[0],
): Promise<Awaited<ReturnType<TestServer['signInMember']>>> {
  const seeded = await server.signInMember(options);
  await page
    .context()
    .addCookies(seeded.cookies.map(({ name, value, url }) => ({ name, value, url })));
  await page.goto(server.baseUrl);
  return seeded;
}

const sections = (page: Page) =>
  page.getByRole('navigation', { name: 'Administration sections' });

async function openAdministration(page: Page, section: 'Status' | 'Installation'): Promise<void> {
  await page.getByRole('button', { name: 'Administration', exact: true }).click();
  await sections(page).getByRole('button', { name: section, exact: true }).click();
}

test.describe('the status section', () => {
  test('the Owner reads every check in words, including the one that fails', async ({ page }) => {
    await seedStatusObservation(server.migrationPool, {
      check: 'storage-privacy',
      result: 'pass',
      code: 'ANONYMOUS_ACCESS_REFUSED',
    });
    await seedStatusObservation(server.migrationPool, {
      check: 'storage-versioning',
      result: 'attention',
      code: 'VERSIONING_NOT_DETECTABLE',
    });
    await seedStatusObservation(server.migrationPool, {
      check: 'scanner',
      result: 'fail',
      code: 'SIGNATURES_STALE',
      evidenceAt: new Date(Date.now() - 3 * 86_400_000),
    });
    await signIn(page, { globalRole: 'owner' });
    await openAdministration(page, 'Status');
    await expect(
      page.getByRole('heading', { level: 2, name: 'Security and deployment status' }),
    ).toBeVisible();
    await expect(page.getByRole('row', { name: /^Storage privacy/u })).toContainText('Passing');
    await expect(page.getByRole('row', { name: /^Storage versioning/u })).toContainText(
      'Needs attention',
    );
    await expect(page.getByRole('row', { name: /^Malware signatures/u })).toContainText('Failing');
    await expect(page.getByRole('row', { name: /^Updates and advisories/u })).toContainText(
      'Not yet checked',
    );
    await expect(page.getByRole('row', { name: /^Database migrations/u })).toContainText(
      'Passing',
    );
    await expect(page.getByRole('alert')).toContainText('Checks failing: 1.');
  });

  test('a plain Member and a Room Manager are offered no Administration at all', async ({
    page,
  }) => {
    await signIn(page, { globalRole: 'member' });
    await expect(page.getByRole('button', { name: 'Administration', exact: true })).toHaveCount(0);
    await signIn(page, { globalRole: 'member', roomTitle: 'Managed room', roomRole: 'manager' });
    await expect(page.getByRole('button', { name: 'Administration', exact: true })).toHaveCount(0);
  });
});

test.describe('the installation download default', () => {
  test('an Admin allows original downloads after review, phrase and a fresh sign-in, then denies them in one press', async ({
    page,
  }) => {
    await signIn(page, { globalRole: 'admin', roomTitle: 'Inheriting room' });
    await openAdministration(page, 'Installation');
    await expect(page.getByText('Denied by default', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Allow original downloads' }).click();
    const allow = page.getByRole('dialog', { name: 'Allow original downloads installation-wide' });
    await expect(allow).toContainText('rooms that inherit this default');
    await expect(allow).toContainText('ALLOW ORIGINAL DOWNLOADS');
    await allow.getByRole('textbox').fill('ALLOW ORIGINAL DOWNLOADS');
    await allow.getByRole('button', { name: 'Allow original downloads' }).click();
    await expect(allow).toBeHidden();
    await expect(page.getByText('Allowed by default', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Deny original downloads' }).click();
    const deny = page.getByRole('dialog', { name: 'Deny original downloads installation-wide' });
    await expect(deny).toContainText('Rooms and documents with their own policy keep it');
    await expect(deny.getByRole('textbox')).toHaveCount(0);
    await deny.getByRole('button', { name: 'Deny original downloads' }).click();
    await expect(deny).toBeHidden();
    await expect(page.getByText('Denied by default', { exact: true })).toBeVisible();
  });

  test('a stale sign-in is sent to sign in again before allowing, and nothing changes', async ({
    page,
  }) => {
    const seeded = await signIn(page, { globalRole: 'owner' });
    await makeSessionStale(server.migrationPool, seeded.memberId);
    await openAdministration(page, 'Installation');
    await page.getByRole('button', { name: 'Allow original downloads' }).click();
    const allow = page.getByRole('dialog', { name: 'Allow original downloads installation-wide' });
    await allow.getByRole('textbox').fill('ALLOW ORIGINAL DOWNLOADS');
    await allow.getByRole('button', { name: 'Allow original downloads' }).click();
    await expect(allow.getByRole('link', { name: 'Sign in again' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Denied by default', { exact: true })).toBeVisible();
  });
});

test.describe('accessibility', () => {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`Status and the Installation review have no violations (${colorScheme})`, async ({
      page,
    }) => {
      await signIn(page, { globalRole: 'owner' });
      await settleTheme(page, colorScheme);
      await openAdministration(page, 'Status');
      await expect(page.getByRole('table')).toBeVisible();
      expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);

      await sections(page).getByRole('button', { name: 'Installation', exact: true }).click();
      await page.getByRole('button', { name: 'Allow original downloads' }).click();
      await expect(
        page.getByRole('dialog', { name: 'Allow original downloads installation-wide' }),
      ).toContainText('ALLOW ORIGINAL DOWNLOADS');
      expect((await new AxeBuilder({ page }).withTags(WCAG).analyze()).violations).toEqual([]);
    });
  }

  test('the review is reached, read and dismissed with the keyboard alone', async ({ page }) => {
    await signIn(page, { globalRole: 'admin' });
    await page.getByRole('button', { name: 'Administration', exact: true }).focus();
    await page.keyboard.press('Enter');
    await sections(page).getByRole('button', { name: 'Installation', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Allow original downloads' }).focus();
    await page.keyboard.press('Enter');
    const review = page.getByRole('dialog', { name: 'Allow original downloads installation-wide' });
    await expect(review.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(review).toContainText('ALLOW ORIGINAL DOWNLOADS');
    await page.keyboard.press('Escape');
    await expect(review).toBeHidden();
    await expect(page.getByRole('button', { name: 'Allow original downloads' })).toBeFocused();
  });

  test('Status does not overflow at 320 CSS pixels', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await signIn(page, { globalRole: 'owner' });
    await openAdministration(page, 'Status');
    await expect(page.getByRole('table')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
```

- [ ] **Step 3: Run the journeys**

```bash
npm run build
node --env-file=.env ./node_modules/@playwright/test/cli.js test test/browser/installation-status.spec.ts --project=chromium --project=firefox --project=mobile-chromium
node --env-file=.env ./node_modules/@playwright/test/cli.js test test/browser/members.spec.ts test/browser/room-administration.spec.ts --project=chromium
```

Expected: PASS. A failure here is a defect in Tasks 7–8, not in the spec: fix it there.

- [ ] **Step 4: Record the system decisions**

In `DESIGN.md` under `## Components`, after the accessible-primitives paragraph, add:

```markdown
- **Status table:** the Status section is one `df-register` table, twelve rows in
  §20.2's order. Every state is a word — Passing, Needs attention, Failing, Not yet
  checked, Out of date — and only Passing carries the accent. Every recorded instant is a
  `<time>` whose `dateTime` and title hold the UTC value; rows read live say "Now". A failing
  check stays Failing when its answer is also old, because the last known answer to it is a
  failure. When any row fails, a problem notice leads with the count.
- **Installation review:** the installation download default reuses `ConfirmationDialog`.
  Both directions open on the server's review of the rooms and published documents the
  change reaches; allowing adds the server's phrase and a fresh sign-in, denying is one
  press, as returning a room to draft is.
```

and under `## Security-bearing UI decisions` add:

```markdown
- **Status never shows configuration.** The Status section renders codes the server
  records, translated to copy; it has no field that could show an issuer, endpoint,
  bucket, host, credential or address, and the server has none to send. What a check could
  not see is said in its copy — the storage privacy check names the public URLs it cannot
  reach.
```

- [ ] **Step 5: Record the operator facts and the threat rows**

In `docs/self-hosting.md`, after the command table, add:

```markdown
### Status

Owners and Admins see **Administration → Status**: version and modules, migrations, storage
privacy and versioning, malware signatures, the worker queue, failed processing, OIDC
discovery, required mail, backups, the restore drill, and updates. The worker checks storage
and signatures every hour, starting an hour after the first migration; `backup-status
acknowledge`, `restore drill` and `updates check-file` record the rest. Storage privacy is
tested against the S3 API only: a public address your provider serves outside it (for
example R2's `r2.dev` domain) must be turned off at the provider, and Status cannot see it.
```

In `docs/security/threat-model.md`, add to the risk table the three rows from spec §7 ("Secret leakage through status", "Forged status", "Installation-wide download exposure"), with the same controls.

In `docs/release-evidence.md`, add a `### Installation status screen-reader review` entry with the date, the screen reader and browser used, and the result of: reading the Status table by row and column header; hearing each state word and each time's UTC value; opening the allowing review and hearing its consequence before the phrase field; and dismissing it back to its trigger. This is a manual step; the evidence is the entry.

In `CODEBASE_MAP.md`'s installation row, add `[installation status journeys](test/browser/installation-status.spec.ts)` to Primary tests.

- [ ] **Step 6: Verify the whole milestone**

Run each on its own, checking `free -h` between them:

```bash
npx prettier --check .
npm run lint
npm run typecheck
npm run compose:verify && npm run compose:verify:minimal && npm run compose
npx vitest run --project unit --maxWorkers=2
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project authz --maxWorkers=2
node --env-file=.env ./node_modules/vitest/vitest.mjs run --project integration --maxWorkers=2
node --env-file=.env ./node_modules/@playwright/test/cli.js test --project=chromium --project=firefox --project=mobile-chromium
wc -l apps/web-client/src/routes/Workspace.tsx apps/web-client/src/workspace/views/AdministrationView.tsx test/support/browser-server.ts apps/worker/src/runner.ts apps/web-client/src/styles/components.css apps/web-client/src/i18n/en.ts
```

Expected: every step passes; `Workspace.tsx` 535, `AdministrationView.tsx` ≤ 200, `browser-server.ts` 1057, `runner.ts` ≤ 260, `components.css` 1020, `en.ts` < 1000.

- [ ] **Step 7: Commit**

```bash
git add test/support/status-seeding.ts test/browser/installation-status.spec.ts DESIGN.md docs CODEBASE_MAP.md
git commit -m "Cover installation status in the browser and record its decisions"
```

---

## Done when

- An Owner or Admin reads every §20.2 fact in **Administration → Status**, each state in words, with its time; a plain Member and a Room Manager are offered no Administration view and are refused `403` by every status and installation route.
- No status response contains a configured value, and no observation can store one.
- The worker records storage privacy, storage versioning and scanner signatures hourly, from a job the migration seeds; `updates check-file` records the update check; an offer that is now installed reads as current.
- The installation download default changes only through a review; allowing needs the phrase and a fresh sign-in, denying needs neither; `duefold_runtime` cannot call `set_installation_download_policy`.
- Axe passes in light and dark on Status and on the allowing review; the review is operable by keyboard alone; Status does not overflow at 320px; the manual screen-reader review is recorded.
- Every map links only to existing paths, and the milestone's size limits hold.

## Open questions for the product owner

1. **Allowing downloads installation-wide needs a phrase and a fresh sign-in.** This plan treats it as a broad grant (§9.4), because it widens every inheriting room at once. A room's own download policy (milestone 2) is a plain change. If the installation default should match it, Task 6 loses the phrase and freshness and Task 8 loses the review.
2. **OIDC is reported from the web process's startup check, not observed repeatedly.** Drift after startup — a provider changing its metadata — shows as failed sign-ins until the next restart. Observing it hourly would mean giving the worker the OIDC issuer and client id, a configuration change for every deployment.
3. **Storage privacy is tested at the S3 API.** A provider's separate public URL (R2's `r2.dev`) is invisible to it; the copy says so. An operator acknowledgement, like `backup-status acknowledge`, would cover it if wanted.
4. **The top-level tab becomes "Administration".** It holds Members, Installation and Status; "Members" would misname two of them.
5. **The worker's first observation arrives an hour after the first migration**, so a new installation's storage and signature rows read "Not yet checked" until then.
