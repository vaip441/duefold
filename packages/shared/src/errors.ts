export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL';

/** The only user-facing wording for each error class; never per-call detail. */
export const SAFE_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  BAD_REQUEST: 'The request is invalid.',
  UNAUTHENTICATED: 'Authentication is required.',
  FORBIDDEN: 'The request is not permitted.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'The request conflicts with current state.',
  RATE_LIMITED: 'Please wait before trying again.',
  DEPENDENCY_UNAVAILABLE: 'A required service is unavailable.',
  INTERNAL: 'The request could not be completed.',
};

export interface ExternalError {
  readonly error: { readonly code: ErrorCode; readonly message: string };
}

export class DuefoldError extends Error {
  public readonly code: ErrorCode;
  public readonly internalDetail: Readonly<Record<string, unknown>>;

  public constructor(
    code: ErrorCode,
    internalMessage: string,
    internalDetail: Readonly<Record<string, unknown>> = {},
  ) {
    super(internalMessage);
    this.name = 'DuefoldError';
    this.code = code;
    this.internalDetail = internalDetail;
  }

  public external(): ExternalError {
    return { error: { code: this.code, message: SAFE_MESSAGES[this.code] } };
  }
}

/** Deliberately identical whether or not an account or invitation exists. */
export const NEUTRAL_AUTH_RESPONSE = {
  accepted: true,
  message: 'If the request is eligible, an email will be sent.',
} as const;
