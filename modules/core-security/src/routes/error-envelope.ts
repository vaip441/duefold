import { Type, type TSchema } from '@sinclair/typebox';

/**
 * The shared client-facing error envelope.
 *
 * Declaring only success responses left every designed 400/401/403/409/500 reply
 * outside Fastify's response-schema validation, which §7's "validate request and
 * response schemas" requires. That mattered beyond tidiness: the uniform,
 * non-enumerating 403 body is a privacy control, and an unvalidated shape can
 * drift into leaking which room, member, or invitation a denial concerned.
 *
 * The envelope is closed and the message is a bounded string, so a database wording
 * or a stack fragment cannot be serialized into it even by accident.
 */
export const ERROR_ENVELOPE = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,63}$' }),
        message: Type.String({ minLength: 1, maxLength: 400 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/**
 * The statuses every cookie-authenticated protected route can emit:
 * 400 from schema rejection or a SQLSTATE 22023/23514 refusal, 401 from the
 * audience guard, 403 from CSRF or a 42501 refusal, 409 from 40001/55000, and 500
 * from a genuine fault. A route adds its own success entries alongside these.
 */
export function protectedErrorResponses(): Record<number, TSchema> {
  return {
    400: ERROR_ENVELOPE,
    401: ERROR_ENVELOPE,
    403: ERROR_ENVELOPE,
    409: ERROR_ENVELOPE,
    500: ERROR_ENVELOPE,
  };
}
