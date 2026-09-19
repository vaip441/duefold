/**
 * Shapes of the generated registry entries in `.duefold/generated/`.
 *
 * These are the only types the applications use to consume composition output.
 * Handler value types stay opaque here so this package does not depend on the
 * HTTP or job runtime; the web and worker composition roots narrow them.
 */

import type { ConfigServiceTarget, HttpMethod, ModuleId, RouteAudience } from './contract.ts';

export interface GeneratedRoute<
  Id extends string = string,
  Audience extends RouteAudience = RouteAudience,
> {
  readonly id: Id;
  readonly module: ModuleId;
  readonly method: HttpMethod;
  readonly path: string;
  readonly audience: Audience;
  readonly csrf: boolean;
  readonly handler: unknown;
  readonly handlerFactory?: unknown;
  readonly schema: unknown;
}

export interface GeneratedMigration {
  readonly id: string;
  readonly module: ModuleId;
  readonly path: string;
}

export interface GeneratedJob {
  readonly id: string;
  readonly module: ModuleId;
  readonly handlerFactory: unknown;
}

export interface GeneratedConfigField {
  readonly key: string;
  readonly module: ModuleId;
  readonly service: ConfigServiceTarget;
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'url' | 'secret';
  readonly required: boolean;
  readonly description: string;
  readonly values?: readonly string[];
  readonly default?: string | number | boolean;
}

export interface GeneratedBrowserEntry {
  readonly id: string;
  readonly module: ModuleId;
  readonly source: string;
}
