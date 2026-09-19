import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { MAX_MULTIPART_PARTS } from '../resource-policy.ts';
import { finalizeUpload } from '../uploads.ts';

export const schema = {
  body: Type.Object(
    {
      intentId: Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' }),
      uploadId: Type.String({ minLength: 1, maxLength: 1024 }),
      parts: Type.Array(
        Type.Object(
          {
            partNumber: Type.Integer({ minimum: 1, maximum: MAX_MULTIPART_PARTS }),
            etag: Type.String({ minLength: 32, maxLength: 66 }),
            checksumSha256: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9+/]{43}=$' })),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: MAX_MULTIPART_PARTS },
      ),
    },
    { additionalProperties: false },
  ),
  response: {
    201: Type.Object(
      { documentId: Type.String(), versionId: Type.String() },
      { additionalProperties: false },
    ),
  },
};
interface Body {
  readonly intentId: string;
  readonly uploadId: string;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly etag: string;
    readonly checksumSha256?: string;
  }[];
}
function body(value: unknown): Body {
  return value as Body;
}
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const finalized = await finalizeUpload({
      pool: runtime.pool,
      storage: runtime.storage,
      identity,
      input: body(request.body),
      now: runtime.clock.now(),
    });
    reply.code(201);
    return finalized;
  };
}
export function handler(): never {
  throw new Error('upload finalize route runtime not initialized');
}
