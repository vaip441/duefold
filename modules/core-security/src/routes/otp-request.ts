import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import { NEUTRAL_AUTH_RESPONSE, SAFE_MESSAGES } from '@duefold/shared/errors';
import { createOtpChallenge } from '../auth/otp.ts';

export const schema = {
  body: Type.Object(
    { email: Type.String({ minLength: 3, maxLength: 320, format: 'email' }) },
    { additionalProperties: false },
  ),
  response: {
    202: Type.Object(
      {
        accepted: Type.Literal(true),
        message: Type.String(),
        challengeId: Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' }),
      },
      { additionalProperties: false },
    ),
    429: Type.Object(
      { error: Type.Object({ code: Type.Literal('RATE_LIMITED'), message: Type.String() }) },
      { additionalProperties: false },
    ),
  },
};

/**
 * Resend cooldown and the PostgreSQL abuse limits collapse into one byte-
 * identical response. Left separable, a recently-requested address answered
 * differently from a fresh one, which let an attacker harvest "a code was
 * requested for this address recently" and tell cooldown apart from the hourly
 * limit. The 202 neutral path is untouched for every address that is not
 * currently limited.
 */
const RATE_LIMITED_MESSAGES = new Set(['OTP_RESEND_COOLDOWN', 'OTP_RATE_LIMITED']);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function emailBody(value: unknown): string {
  if (!isRecord(value)) throw new Error('invalid OTP request');
  const email = value['email'];
  if (typeof email !== 'string') throw new Error('invalid OTP request');
  return email;
}
export function createHandler(runtime: WebRuntime) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<
    | (typeof NEUTRAL_AUTH_RESPONSE & { readonly challengeId: string })
    | { readonly error: { readonly code: 'RATE_LIMITED'; readonly message: string } }
  > => {
    let challenge: { readonly id: string };
    try {
      challenge = await createOtpChallenge({
        pool: runtime.authPool,
        email: emailBody(request.body),
        normalizedIp: request.ip,
        digestKey: runtime.otpDigestKey,
        networkKey: runtime.networkHmacKey,
        client: runtime.classifyClient(request),
        clock: runtime.clock,
      });
    } catch (error) {
      if (!(error instanceof Error) || !RATE_LIMITED_MESSAGES.has(error.message)) throw error;
      reply.code(429);
      return { error: { code: 'RATE_LIMITED', message: SAFE_MESSAGES.RATE_LIMITED } };
    }
    reply.code(202);
    return { ...NEUTRAL_AUTH_RESPONSE, challengeId: challenge.id };
  };
}
export function handler(): never {
  throw new Error('OTP route runtime not initialized');
}
