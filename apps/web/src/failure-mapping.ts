/**
 * Turns a thrown failure into an HTTP status and a client-facing body.
 *
 * This lived inside the Fastify error handler, where the only way to exercise it
 * was to provoke each database refusal through a real route. That left the most
 * security-relevant branch -- naming a stale-OIDC refusal -- untested, because no
 * reachable route could raise it on demand. It is exported so the mapping can be
 * driven directly with the exact errors PostgreSQL raises.
 *
 * Two properties matter here:
 *
 * 1. A refusal is not a fault. Everything used to become HTTP 500, so a denied
 *    request was indistinguishable from a crashed one: clients could not build a
 *    denied state, and real faults hid among expected refusals.
 * 2. The SERVER names the cause of a 403. A client that guesses from which
 *    operation it called will label an ordinary denial "sign in again", which is a
 *    false recovery instruction. Only the database knows whether the broad-change
 *    predicate fired.
 *
 * The database's own wording is never forwarded, and 403 copy is uniform so a
 * denial cannot be used to discover whether a room, folder, or document exists.
 */

export interface ClassifiedFailure {
  readonly status: number;
  readonly body: { readonly code: string; readonly message: string };
}

const SQLSTATE_STATUS = new Map<string, { readonly status: number; readonly code: string }>([
  ['42501', { status: 403, code: 'FORBIDDEN' }],
  ['22023', { status: 400, code: 'REQUEST_INVALID' }],
  ['23514', { status: 400, code: 'REQUEST_INVALID' }],
  ['40001', { status: 409, code: 'CONFLICT' }],
  /*
   * A UNIQUENESS REFUSAL IS A CONFLICT, NOT A FAULT.
   *
   * Without this, inviting an address that is already invited or already a member
   * reached the Admin as HTTP 500: `invite_member` raises 23505 deliberately, and an
   * unmapped SQLSTATE is treated as a crash. The Admin was shown a fault for doing
   * something entirely reasonable, and a real fault was indistinguishable from it.
   *
   * 409 with the uniform conflict copy, like 40001: both mean "the state you assumed is
   * not the state that exists, look again". The database's own wording never reaches the
   * client, so a duplicate cannot be used to probe which addresses are already known.
   */
  ['23505', { status: 409, code: 'CONFLICT' }],
  ['55000', { status: 409, code: 'CONFLICT' }],
]);

const UNIFORM_MESSAGE = new Map<number, string>([
  [403, 'This action is not available to you.'],
  [400, 'The request could not be accepted.'],
  [409, 'The resource changed before this request completed. Reload and try again.'],
]);

/**
 * The marker the SECURITY DEFINER functions raise for a broad change attempted on
 * a stale OIDC session. Matching the message is deliberate: PostgreSQL gives every
 * authorization refusal SQLSTATE 42501, so the message is the only signal that
 * distinguishes "re-authenticate" from "you may not do this at all".
 */
const FRESH_OIDC_MARKER = 'fresh OIDC required';

function messageOf(error: unknown): string {
  return typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : '';
}

/** Returns `null` when the failure is not a recognized refusal, i.e. a real fault. */
export function classifyFailure(error: unknown): ClassifiedFailure | null {
  const sqlState =
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : undefined;
  const mapped = sqlState === undefined ? undefined : SQLSTATE_STATUS.get(sqlState);
  if (mapped !== undefined) {
    if (mapped.status === 403 && messageOf(error).includes(FRESH_OIDC_MARKER))
      return {
        status: 403,
        body: {
          code: 'FRESH_AUTHENTICATION_REQUIRED',
          message: 'This change needs a fresh sign-in.',
        },
      };
    return {
      status: mapped.status,
      body: {
        code: mapped.code,
        message: UNIFORM_MESSAGE.get(mapped.status) ?? 'The request could not be completed.',
      },
    };
  }
  const fastifyError = error as { validation?: unknown; statusCode?: unknown };
  if (fastifyError.validation !== undefined || fastifyError.statusCode === 400)
    return {
      status: 400,
      body: {
        code: 'REQUEST_INVALID',
        message: UNIFORM_MESSAGE.get(400) ?? 'The request could not be accepted.',
      },
    };
  return null;
}
