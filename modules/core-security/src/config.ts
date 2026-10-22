import type { GeneratedConfigField } from '@duefold/composition/registry-types';
import { SESSION_BOUNDS } from './sessions.ts';

export type RuntimeConfig = Readonly<Record<string, string | number | boolean>>;
const MIN_SECRET_BYTES = 32;
function secretHasMinimumEntropy(value: string): boolean {
  try {
    return Buffer.from(value, 'base64url').length >= MIN_SECRET_BYTES;
  } catch {
    return false;
  }
}
function validateCrossField(config: RuntimeConfig): RuntimeConfig {
  for (const [key, bounds] of [
    ['DUEFOLD_SESSION_IDLE_MINUTES', SESSION_BOUNDS.idleMinutes],
    ['DUEFOLD_SESSION_ABSOLUTE_HOURS', SESSION_BOUNDS.absoluteHours],
  ] as const) {
    const value = config[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < bounds.min ||
        value > bounds.max)
    )
      throw new Error(`invalid bounded configuration: ${key}`);
  }
  const otp = config['DUEFOLD_OTP_DIGEST_KEY'];
  const network = config['DUEFOLD_NETWORK_HMAC_KEY'];
  const pii = config['DUEFOLD_PII_HMAC_KEY'];
  if (otp !== undefined && (typeof otp !== 'string' || !secretHasMinimumEntropy(otp)))
    throw new Error('weak secret configuration: DUEFOLD_OTP_DIGEST_KEY');
  if (
    network !== undefined &&
    (typeof network !== 'string' || !secretHasMinimumEntropy(network))
  )
    throw new Error('weak secret configuration: DUEFOLD_NETWORK_HMAC_KEY');
  if (
    pii !== undefined &&
    pii !== '' &&
    (typeof pii !== 'string' || !secretHasMinimumEntropy(pii))
  )
    throw new Error('weak secret configuration: DUEFOLD_PII_HMAC_KEY');
  const configuredKeys = [otp, network, pii].filter(
    (k): k is string => typeof k === 'string' && k !== '',
  );
  if (configuredKeys.length > 1 && new Set(configuredKeys).size !== configuredKeys.length)
    throw new Error('security keys must be independently generated');
  return config;
}
function parseField(
  field: GeneratedConfigField,
  raw: string | undefined,
): string | number | boolean {
  const value = raw ?? (field.default === undefined ? undefined : String(field.default));
  if (value === undefined || value === '') {
    if (field.required) throw new Error(`missing configuration: ${field.key}`);
    return '';
  }
  switch (field.kind) {
    case 'number': {
      const parsed = Number(value);
      if (!Number.isFinite(parsed))
        throw new Error(`invalid number configuration: ${field.key}`);
      return parsed;
    }
    case 'boolean':
      if (value === 'true') return true;
      else if (value === 'false') return false;
      else throw new Error(`invalid boolean configuration: ${field.key}`);
    case 'url':
      try {
        return new URL(value).toString();
      } catch {
        throw new Error(`invalid URL configuration: ${field.key}`);
      }
    case 'enum':
      if (field.values?.includes(value) !== true)
        throw new Error(`invalid enum configuration: ${field.key}`);
      return value;
    case 'string':
    case 'secret':
      return value;
  }
}
/** Validates only DUEFOLD_* process keys; unknown owned keys fail startup. */
export function loadConfig(
  schema: readonly GeneratedConfigField[],
  environment: NodeJS.ProcessEnv,
  options?: { readonly allowOtherDuefoldKeys?: boolean },
): RuntimeConfig {
  const known = new Set(schema.map(({ key }) => key));
  for (const key of Object.keys(environment))
    if (
      key.startsWith('DUEFOLD_') &&
      !known.has(key) &&
      options?.allowOtherDuefoldKeys !== true &&
      ![
        'DUEFOLD_TEST_DATABASE_URL',
        'DUEFOLD_TEST_AUTH_DATABASE_URL',
        'DUEFOLD_TEST_WORKER_DATABASE_URL',
        'DUEFOLD_TEST_MIGRATION_DATABASE_URL',
      ].includes(key)
    )
      throw new Error(`unknown configuration key: ${key}`);
  return validateCrossField(
    Object.fromEntries(
      schema.map((field) => [field.key, parseField(field, environment[field.key])]),
    ),
  );
}
