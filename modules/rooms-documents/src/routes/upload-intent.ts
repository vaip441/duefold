import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { MAX_MULTIPART_PARTS, MAX_SOURCE_BYTES } from '../resource-policy.ts';
import { createUploadIntent } from '../uploads.ts';

const partSchema = Type.Object(
  {
    partNumber: Type.Integer({ minimum: 1, maximum: MAX_MULTIPART_PARTS }),
    size: Type.Integer({ minimum: 1, maximum: MAX_SOURCE_BYTES }),
    checksumSha256: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9+/]{43}=$' })),
  },
  { additionalProperties: false },
);
export const schema = {
  body: Type.Object(
    {
      roomId: Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' }),
      documentId: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' })),
      displayTitle: Type.String({ minLength: 1, maxLength: 200 }),
      originalFilename: Type.String({ minLength: 1, maxLength: 255 }),
      declaredMediaType: Type.String({ minLength: 1, maxLength: 100 }),
      declaredSize: Type.Integer({ minimum: 1, maximum: MAX_SOURCE_BYTES }),
      parts: Type.Array(partSchema, { minItems: 1, maxItems: MAX_MULTIPART_PARTS }),
    },
    { additionalProperties: false },
  ),
  response: {
    201: Type.Object(
      {
        intentId: Type.String(),
        uploadId: Type.String(),
        expiresAt: Type.String(),
        parts: Type.Array(
          Type.Object(
            { partNumber: Type.Integer(), url: Type.String() },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
};
interface Body {
  readonly roomId: string;
  readonly documentId?: string;
  readonly displayTitle: string;
  readonly originalFilename: string;
  readonly declaredMediaType: string;
  readonly declaredSize: number;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly size: number;
    readonly checksumSha256?: string;
  }[];
}
function body(value: unknown): Body {
  return value as Body;
}
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const created = await createUploadIntent({
      pool: runtime.pool,
      storage: runtime.storage,
      identity,
      input: body(request.body),
      now: runtime.clock.now(),
    });
    reply.code(201);
    return { ...created, expiresAt: created.expiresAt.toISOString() };
  };
}
export function handler(): never {
  throw new Error('upload intent route runtime not initialized');
}
