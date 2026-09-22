const TELEMETRY_EVENTS = [
  'request.failed',
  'process.failure',
  'auth.oidc.refused',
  'database.connection.lost',
] as const;
const TELEMETRY_CODES = [
  'REQUEST_FAILED',
  'PROCESS_FAILED',
  /*
   * Closed set of sign-in refusal reasons. These are the server's own constants,
   * never provider or database text, and they name a cause without identifying a
   * person: no email, subject, issuer, state, or token material.
   *
   * Without these, a failed member sign-in produced a redacted REQUEST_FAILED and
   * no audit row, so the failure surface told the operator to "ask your Duefold
   * administrator to check your access" while giving that administrator nothing to
   * check. Diagnosing a real outage required reading the source and guessing.
   */
  'OIDC_TRANSACTION_INVALID',
  'OIDC_REQUIRED_CLAIMS_MISSING',
  'OIDC_TOKEN_EXPIRED',
  'OIDC_AUTH_TIME_REQUIRED',
  'OIDC_AUTH_TIME_STALE',
  'OIDC_VERIFIED_EMAIL_REQUIRED',
  'OIDC_CLIENT_REJECTED',
  'OIDC_GRANT_REJECTED',
  'OIDC_TOKEN_ENDPOINT_REJECTED',
  'OIDC_AUTHORIZATION_RESPONSE_REJECTED',
  'OIDC_TOKEN_CLAIMS_REJECTED',
  'OIDC_TOKEN_TIME_REJECTED',
  'OIDC_PROVIDER_RESPONSE_INVALID',
  'OIDC_EXCHANGE_FAILED',
  'MEMBER_INVITATION_REQUIRED',
  'BOOTSTRAP_IDENTITY_NOT_ALLOWED',
  'OWNER_ALREADY_EXISTS',
  /*
   * A lost database connection reports the SQLSTATE the driver gave and nothing else. The
   * class is what an operator acts on — an administrator command, a crash, an idle timeout —
   * and a `pg` error object carries the connection parameters, so it is never emitted.
   */
  '57P01',
  '57P02',
  '57P03',
  '08006',
  '08003',
  'UNKNOWN',
] as const;
const TELEMETRY_LEVELS = ['info', 'warn', 'error'] as const;
const TELEMETRY_SERVICES = ['web', 'worker', 'cli'] as const;
/** Which credential a pool holds. Not free text: an operator matches it to a role grant. */
const TELEMETRY_ROLES = [
  'runtime',
  'authenticator',
  'worker',
  'migration',
  'probe',
  'failure-injection',
] as const;
const TELEMETRY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
const TELEMETRY_STAGES = ['config', 'oidc', 'database', 'application', 'listen'] as const;

import { isCorrelationId } from './ids.ts';

export type TelemetryValue = number | string;
export type TelemetryRecord = Readonly<Record<string, TelemetryValue>>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}
function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

/**
 * Telemetry fields have closed value contracts. Unknown fields and invalid
 * values are dropped, including sensitive free text placed under a known key.
 */
export function allowlistedTelemetry(value: unknown): TelemetryRecord {
  if (!isRecord(value)) return {};
  const output: Record<string, TelemetryValue> = {};
  if (isOneOf(value['event'], TELEMETRY_EVENTS)) output['event'] = value['event'];
  if (isOneOf(value['level'], TELEMETRY_LEVELS)) output['level'] = value['level'];
  if (isOneOf(value['code'], TELEMETRY_CODES)) output['code'] = value['code'];
  if (boundedInteger(value['status'], 100, 599)) output['status'] = value['status'];
  if (boundedInteger(value['durationMs'], 0, 86_400_000))
    output['durationMs'] = value['durationMs'];
  if (isOneOf(value['method'], TELEMETRY_METHODS)) output['method'] = value['method'];
  if (isOneOf(value['service'], TELEMETRY_SERVICES)) output['service'] = value['service'];
  if (isOneOf(value['stage'], TELEMETRY_STAGES)) output['stage'] = value['stage'];
  if (isOneOf(value['role'], TELEMETRY_ROLES)) output['role'] = value['role'];
  if (
    typeof value['version'] === 'string' &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(value['version'])
  )
    output['version'] = value['version'];
  if (isCorrelationId(value['correlation'])) output['correlation'] = value['correlation'];
  return output;
}
