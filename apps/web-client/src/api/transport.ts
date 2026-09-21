/**
 * The only place the browser talks to the Duefold API.
 *
 * CSRF is wired here once rather than per form: every mutation reads the
 * `__Host-duefold_csrf` cookie the server set at session issuance and echoes it
 * in the `x-duefold-csrf` header, which the server compares against the stored
 * digest.
 *
 * Nothing here persists anything. No token, session value, or protected content
 * is written to localStorage, sessionStorage, IndexedDB, a service worker, or a
 * cache. The CSRF token lives only in the cookie the server
 * controls, and responses are held in component state for the lifetime of the
 * view.
 *
 * The browser is never the authorization boundary: these helpers report what the
 * server decided, and no client-side check substitutes for it.
 */

const CSRF_COOKIE = '__Host-duefold_csrf';
const CSRF_HEADER = 'x-duefold-csrf';

/**
 * Failure classes the UI can present. Never carries server detail.
 *
 * `conflict` and `invalid` exist because the server distinguishes them:
 * 409 means someone else changed the room, and the only correct
 * response is to reload and re-read — a silent retry would reapply a stale
 * revision over a colleague's change. Folding either into `unavailable` would
 * present a refusal as a fault and invite exactly that retry.
 */
export type ApiFailure =
  | 'offline'
  | 'unauthenticated'
  | 'denied'
  | 'not-found'
  | 'rate-limited'
  | 'conflict'
  | 'invalid'
  /* A 403 the SERVER identified as a stale-OIDC refusal. The cause of a denial is
     never inferred from which operation was attempted: doing so labelled every
     ordinary refusal on grant and export calls as "sign in again", which is a
     false recovery instruction. Only the server's own code sets this. */
  | 'fresh-authentication-required'
  | 'unavailable';

export class ApiError extends Error {
  public readonly failure: ApiFailure;
  public constructor(failure: ApiFailure) {
    super(failure);
    this.name = 'ApiError';
    this.failure = failure;
  }
}

function readCsrfToken(): string | null {
  for (const part of document.cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== CSRF_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}

export function failureForStatus(status: number, serverCode?: string): ApiFailure {
  if (status === 403 && serverCode === 'FRESH_AUTHENTICATION_REQUIRED')
    return 'fresh-authentication-required';
  if (status === 400) return 'invalid';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'denied';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate-limited';
  return 'unavailable';
}

/** Reads the server's error code without forwarding any server message. */
export async function serverErrorCode(response: Response): Promise<string | undefined> {
  try {
    const parsed = (await response.clone().json()) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === 'string' ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
}

export interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export async function request(options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.method !== 'GET') {
    const token = readCsrfToken();
    // A missing token still sends the request: the server is the authority on
    // whether the mutation is permitted, and a client-side veto here would
    // silently diverge from it.
    if (token !== null) headers[CSRF_HEADER] = token;
  }
  let response: Response;
  try {
    response = await fetch(options.path, {
      method: options.method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'follow',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError('offline');
  }
  return response;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiError('unavailable');
  }
}

/** A JSON request whose non-ok status becomes a classified ApiError. */
export async function json(options: RequestOptions): Promise<unknown> {
  const response = await request(options);
  if (!response.ok)
    throw new ApiError(failureForStatus(response.status, await serverErrorCode(response)));
  return readJson(response);
}

export function requireArray(value: unknown, key: string): readonly unknown[] {
  if (!isRecord(value)) throw new ApiError('unavailable');
  const list = value[key];
  if (!Array.isArray(list)) throw new ApiError('unavailable');
  return list;
}

export function requireString(value: Readonly<Record<string, unknown>>, key: string): string {
  const found = value[key];
  if (typeof found !== 'string' || found === '') throw new ApiError('unavailable');
  return found;
}

export function requireNumber(value: Readonly<Record<string, unknown>>, key: string): number {
  const found = value[key];
  if (typeof found !== 'number' || !Number.isFinite(found)) throw new ApiError('unavailable');
  return found;
}

/**
 * For a field the server declares as an integer: a revision, a count, a position.
 *
 * Separate from `requireNumber` because a fractional revision is a malformed response, not a
 * stale one, and sending it back as an expected revision would compare against something no
 * writer can hold.
 */
export function requireInteger(value: Readonly<Record<string, unknown>>, key: string): number {
  const found = value[key];
  if (typeof found !== 'number' || !Number.isInteger(found)) throw new ApiError('unavailable');
  return found;
}

export function nonNegative(value: Readonly<Record<string, unknown>>, key: string): number {
  const found = requireInteger(value, key);
  if (found < 0) throw new ApiError('unavailable');
  return found;
}

export function positive(value: Readonly<Record<string, unknown>>, key: string): number {
  const found = requireInteger(value, key);
  if (found < 1) throw new ApiError('unavailable');
  return found;
}

export function oneOf<T>(values: readonly T[], value: unknown): T {
  if (!(values as readonly unknown[]).includes(value)) throw new ApiError('unavailable');
  return value as T;
}

export function instantOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    throw new ApiError('unavailable');
  return value;
}

export function requireRecord(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const nested = value[key];
  if (!isRecord(nested)) throw new ApiError('unavailable');
  return nested;
}

export function requireBoolean(value: Readonly<Record<string, unknown>>, key: string): boolean {
  const flag = value[key];
  if (typeof flag !== 'boolean') throw new ApiError('unavailable');
  return flag;
}

/** A non-empty string, or null. */
export function textOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value === '') throw new ApiError('unavailable');
  return value;
}
