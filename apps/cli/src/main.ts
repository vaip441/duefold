import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stdin, stdout } from 'node:process';
import { Pool } from 'pg';
import { generatedMigrations } from '../../../.duefold/generated/migrations.ts';
import { generatedConfigSchema } from '../../../.duefold/generated/config-schema.ts';
import { loadConfig, type RuntimeConfig } from '../../../modules/core-security/src/config.ts';
import { installProcessFailureHandlers } from '@duefold/shared/process-errors';
import { recoverOwner } from '../../../modules/core-security/src/recovery.ts';
import { migrate } from '../../../modules/core-security/src/db/migrate.ts';
import {
  acknowledgeBackupStatus,
  assertExternalEnablementAllowed,
  backupStatus,
  createSupportBundle,
  deploymentPlan,
  reconcileDeletionMarker,
  restoreDrill,
  updateObservation,
} from './lifecycle.ts';
import { applicationVersion } from '../../../modules/core-security/src/release.ts';
import {
  observationResult,
  recordUpdateObservation,
} from '../../../modules/core-security/src/status-observations.ts';
import {
  createWorkerStorage,
  workerStorageConfig,
} from '../../../modules/rooms-documents/src/storage/s3-compatible.ts';
import {
  formatSandboxPreflight,
  sandboxPreflight,
} from '../../../modules/rooms-documents/src/processing/preflight.ts';

let activePool: Pool | undefined;
const terminate = installProcessFailureHandlers('cli', {
  close: async () => {
    if (activePool !== undefined) await activePool.end();
  },
});

const MIGRATION_URL = 'DUEFOLD_MIGRATION_DATABASE_URL';
const STORAGE_KEYS = [
  'DUEFOLD_STORAGE_ENDPOINT',
  'DUEFOLD_STORAGE_REGION',
  'DUEFOLD_STORAGE_BUCKET',
  'DUEFOLD_STORAGE_WORKER_ACCESS_KEY_ID',
  'DUEFOLD_STORAGE_WORKER_SECRET_ACCESS_KEY',
  'DUEFOLD_STORAGE_PATH_STYLE',
  'DUEFOLD_STORAGE_CHECKSUM_SUPPORT',
] as const;
const USAGE =
  'usage: db migrate | db reset | bootstrap <organization-name> | recover-owner <exact-email> | support-bundle | preflight sandbox | updates check-file <manifest> | upgrade <sha256:digest> | rollback <sha256:digest> | backup-status [acknowledge <retention> <expectation>] | restore drill | restore reconcile-marker <purge-id> | restore enable-external';

function requiredString(config: RuntimeConfig, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || value === '') throw new Error(`invalid ${key}`);
  return value;
}

async function guardedRecovery(pool: Pool, email: string): Promise<void> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    console.log(
      'IMPACT: disables every current member Owner and assigns Owner to the exact invited member email shown below.',
    );
    console.log(`TARGET: ${email}`);
    if (
      (await prompt.question('Type BACKUP VERIFIED to acknowledge current backup status: ')) !==
      'BACKUP VERIFIED'
    )
      throw new Error('backup acknowledgement rejected');
    if (
      (await prompt.question(`Type TRANSFER OWNER TO ${email} to continue: `)) !==
      `TRANSFER OWNER TO ${email}`
    )
      throw new Error('typed confirmation rejected');
    await recoverOwner(pool, email);
  } finally {
    prompt.close();
  }
}

interface CommandContext {
  readonly args: readonly string[];
  readonly config: RuntimeConfig;
  readonly pool?: Pool;
}
interface CommandDefinition {
  readonly matches: (args: readonly string[]) => boolean;
  readonly configKeys: readonly string[];
  readonly database: boolean;
  readonly run: (context: CommandContext) => void | Promise<void>;
}
function argument(context: CommandContext, index: number): string {
  const value = context.args[index];
  if (value === undefined) throw new Error(USAGE);
  return value;
}
const database = (context: CommandContext): Pool => {
  if (context.pool === undefined) throw new Error('database connection required');
  return context.pool;
};

const COMMANDS: readonly CommandDefinition[] = [
  {
    matches: ([group, command]) => group === 'db' && command === 'migrate',
    configKeys: [MIGRATION_URL],
    database: true,
    run: async (context) => migrate(database(context), generatedMigrations),
  },
  {
    matches: ([group, command]) => group === 'db' && command === 'reset',
    configKeys: [MIGRATION_URL, 'DUEFOLD_ALLOW_DB_RESET'],
    database: true,
    run: async (context) => {
      if (context.config['DUEFOLD_ALLOW_DB_RESET'] !== true)
        throw new Error('db reset requires DUEFOLD_ALLOW_DB_RESET=true');
      await database(context).query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
      await migrate(database(context), generatedMigrations);
    },
  },
  {
    matches: ([group, name, extra]) =>
      group === 'bootstrap' && name !== undefined && extra === undefined,
    configKeys: [],
    database: false,
    run: () => {
      console.log(
        'Bootstrap organization metadata is claimed by the first allowlisted verified OIDC identity; use the OIDC callback flow, not an unauthenticated CLI owner creation.',
      );
      throw new Error('bootstrap requires verified OIDC identity');
    },
  },
  {
    matches: ([group, email, extra]) =>
      group === 'recover-owner' && email !== undefined && extra === undefined,
    configKeys: [MIGRATION_URL],
    database: true,
    run: async (context) => guardedRecovery(database(context), argument(context, 1)),
  },
  {
    matches: ([group, extra]) => group === 'support-bundle' && extra === undefined,
    configKeys: [MIGRATION_URL],
    database: true,
    run: async (context) => {
      console.log(JSON.stringify(await createSupportBundle(database(context))));
    },
  },
  {
    /**
     * Reports the real isolation boundary of the environment this process runs
     * in, so a candidate host can be evaluated before any document or credential
     * reaches it. It takes no configuration and no database, because the answer
     * must be obtainable on a platform where nothing else is configured yet.
     *
     * An absent feature is a true answer, not a command fault: the report is
     * printed and the exit code set directly, rather than throwing, so the
     * operator sees which features are missing instead of only
     * `PROCESS_FAILED`. The non-zero exit still lets a deployment gate fail on
     * it.
     *
     * Run this inside the web or worker service, never a helper container that
     * intentionally lacks the sandbox grants; the reference `migrate` service
     * has no added capability, seccomp profile, or bounded tmpfs and would
     * report an unsupported sandbox on a perfectly good host.
     */
    matches: ([group, command, extra]) =>
      group === 'preflight' && command === 'sandbox' && extra === undefined,
    configKeys: [],
    database: false,
    run: async () => {
      const report = await sandboxPreflight();
      console.log(formatSandboxPreflight(report));
      console.log(`supported=${String(report.supported)}`);
      if (!report.supported) process.exitCode = 1;
    },
  },
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
        await readFile(
          requiredString(context.config, 'DUEFOLD_UPDATE_PUBLIC_KEY_PATH'),
          'utf8',
        ),
        applicationVersion(),
      );
      await recordUpdateObservation(database(context), observation);
      console.log(JSON.stringify({ check: 'updates', ...observation }));
      if (observationResult(observation.code) === 'fail') process.exitCode = 1;
    },
  },
  ...(['upgrade', 'rollback'] as const).map((kind): CommandDefinition => ({
    matches: ([group, digest, extra]) =>
      group === kind && digest !== undefined && extra === undefined,
    configKeys: [],
    database: false,
    run: (context) => {
      console.log(JSON.stringify(deploymentPlan(kind, argument(context, 1))));
    },
  })),
  {
    matches: ([group, command]) => group === 'backup-status' && command === undefined,
    configKeys: [MIGRATION_URL],
    database: true,
    run: async (context) => {
      console.log(JSON.stringify(await backupStatus(database(context))));
    },
  },
  {
    matches: ([group, command, retention, expectation, extra]) =>
      group === 'backup-status' &&
      command === 'acknowledge' &&
      retention !== undefined &&
      expectation !== undefined &&
      extra === undefined,
    configKeys: [MIGRATION_URL],
    database: true,
    run: async (context) => {
      await acknowledgeBackupStatus(database(context), {
        retention: argument(context, 2),
        expectation: argument(context, 3),
      });
      console.log(JSON.stringify(await backupStatus(database(context))));
    },
  },
  {
    matches: ([group, command, extra]) =>
      group === 'restore' && command === 'drill' && extra === undefined,
    configKeys: [MIGRATION_URL],
    database: true,
    run: async (context) => {
      console.log(JSON.stringify(await restoreDrill(database(context))));
    },
  },
  {
    matches: ([group, command, purgeId, extra]) =>
      group === 'restore' &&
      command === 'reconcile-marker' &&
      purgeId !== undefined &&
      extra === undefined,
    configKeys: [MIGRATION_URL, ...STORAGE_KEYS],
    database: true,
    run: async (context) => {
      const storage = createWorkerStorage(
        workerStorageConfig({
          endpoint: requiredString(context.config, 'DUEFOLD_STORAGE_ENDPOINT'),
          region: requiredString(context.config, 'DUEFOLD_STORAGE_REGION'),
          bucket: requiredString(context.config, 'DUEFOLD_STORAGE_BUCKET'),
          credentials: {
            accessKeyId: requiredString(context.config, 'DUEFOLD_STORAGE_WORKER_ACCESS_KEY_ID'),
            secretAccessKey: requiredString(
              context.config,
              'DUEFOLD_STORAGE_WORKER_SECRET_ACCESS_KEY',
            ),
          },
          pathStyle: context.config['DUEFOLD_STORAGE_PATH_STYLE'] === true,
          checksumSupport: context.config['DUEFOLD_STORAGE_CHECKSUM_SUPPORT'] === true,
        }),
      );
      const purgeId = argument(context, 2);
      await reconcileDeletionMarker(database(context), storage, purgeId);
      console.log(JSON.stringify({ purgeId, deletionMarker: 'reconciled' }));
    },
  },
  {
    matches: ([group, command, extra]) =>
      group === 'restore' && command === 'enable-external' && extra === undefined,
    configKeys: [MIGRATION_URL],
    database: true,
    run: async (context) => {
      await assertExternalEnablementAllowed(database(context));
      console.log(
        JSON.stringify({ externalEnablement: 'allowed', deletionMarkers: 'reconciled' }),
      );
    },
  },
];

export async function runCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const command = COMMANDS.find((candidate) => candidate.matches(arguments_));
  if (command === undefined) throw new Error(USAGE);
  const keys = new Set(command.configKeys);
  const schema = generatedConfigSchema.filter((field) => keys.has(field.key));
  const config = loadConfig(schema, environment, { allowOtherDuefoldKeys: true });
  let pool: Pool | undefined;
  if (command.database) {
    pool = new Pool({
      connectionString: requiredString(config, MIGRATION_URL),
      application_name: 'duefold-cli',
    });
    activePool = pool;
  }
  try {
    await command.run({ args: arguments_, config, ...(pool === undefined ? {} : { pool }) });
  } finally {
    activePool = undefined;
    if (pool !== undefined) await pool.end();
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  try {
    await runCli(process.argv.slice(2));
  } catch {
    terminate();
  }
