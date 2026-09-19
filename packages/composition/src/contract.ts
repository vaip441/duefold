/**
 * Build-time module composition contract.
 *
 * A module is a first-party workspace package that
 * declares routes, migrations, jobs, configuration, and browser entries. A
 * reviewed static manifest selects modules before build; the generator emits
 * explicit registries from that selection.
 *
 * There is no runtime module discovery, dynamic import of module code, feature
 * flag, or dependency solver. An omitted module is absent from
 * production artifacts, not hidden behind a flag.
 */

/** The four first-party modules. */
export const MODULE_IDS = [
  'core-security',
  'rooms-documents',
  'participants-access',
  'branding-notifications',
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

/**
 * Modules that form secure core. These cannot be omitted: authentication mail
 * lives in `core-security`, so omitting branding must never break login.
 */
export const REQUIRED_MODULE_IDS: readonly ModuleId[] = [
  'core-security',
  'rooms-documents',
  'participants-access',
];

export const OPTIONAL_MODULE_IDS: readonly ModuleId[] = ['branding-notifications'];

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as readonly string[]).includes(value);
}

export function isRequiredModule(id: ModuleId): boolean {
  return REQUIRED_MODULE_IDS.includes(id);
}

/** Which service a registry entry belongs to. */
export type ServiceTarget = 'web' | 'worker' | 'cli';
export type ConfigServiceTarget = ServiceTarget | 'shared';

/** HTTP methods used by generated route registries. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

/**
 * Audience determines which authentication and authorization guard wraps a
 * route. `public` is reserved for unauthenticated surfaces such as the OTP
 * challenge and health endpoints; it never implies unauthorized data access.
 */
export type RouteAudience = 'public' | 'member' | 'viewer' | 'system';

export interface RouteDeclaration {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly audience: RouteAudience;
  /** Module-relative import specifier of the handler module. */
  readonly handler: string;
  /** Optional runtime factory export for dependency-injected handlers. */
  readonly handlerFactoryExport?: string;
  /** Named export of the handler module. Defaults to `handler`. */
  readonly handlerExport?: string;
  /**
   * When true, a cookie-authenticated mutation requires CSRF verification.
   * Defaults to true for mutating methods in the generator.
   */
  readonly csrf?: boolean;
}

export interface MigrationDeclaration {
  readonly id: string;
  readonly file: string;
}

export interface JobDeclaration {
  readonly id: string;
  readonly handler: string;
  readonly handlerFactoryExport: 'createHandler';
  readonly service: Extract<ServiceTarget, 'worker'>;
}

export interface ConfigFieldDeclaration {
  readonly key: string;
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'url' | 'secret';
  readonly required: boolean;
  readonly service: ConfigServiceTarget;
  readonly description: string;
  readonly values?: readonly string[];
  readonly default?: string | number | boolean;
}

export interface BrowserEntryDeclaration {
  readonly id: string;
  readonly source: string;
}

/**
 * A module's static declaration. Modules export this as `moduleDeclaration`
 * from their package entry point. The generator reads declarations at build
 * time only.
 */
export interface ModuleDeclaration {
  readonly id: ModuleId;
  readonly packageName: string;
  readonly routes: readonly RouteDeclaration[];
  readonly migrations: readonly MigrationDeclaration[];
  readonly jobs: readonly JobDeclaration[];
  readonly config: readonly ConfigFieldDeclaration[];
  readonly browserEntries: readonly BrowserEntryDeclaration[];
  /** Other modules that must be present for this module to function. */
  readonly requires: readonly ModuleId[];
}

/** The reviewed static selection of modules and adapters for a build. */
export interface CompositionManifest {
  readonly version: 1;
  readonly modules: readonly ModuleId[];
  readonly adapters: {
    readonly storage: 's3-compatible';
    readonly mail: 'smtp' | 'resend';
    readonly identity: 'oidc';
  };
}
