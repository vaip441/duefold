import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { requestManualProcessingRetry } from '../processing-retry.ts';

export const schema = {
  body: Type.Object(
    { versionId: Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' }) },
    { additionalProperties: false },
  ),
  response: { 204: Type.Null() },
};
function body(value: unknown): { readonly versionId: string } {
  return value as { readonly versionId: string };
}
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await requestManualProcessingRetry({
      pool: runtime.pool,
      identity,
      versionId: body(request.body).versionId,
    });
    reply.code(204);
    return null;
  };
}
export function handler(): never {
  throw new Error('processing retry route runtime not initialized');
}
