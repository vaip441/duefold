import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { readProcessingState } from '../member-state-readers.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
export const schema = {
  querystring: Type.Object(
    {
      roomId: ID,
      limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
      afterCreatedAt: Type.Optional(Type.String({ format: 'date-time' })),
      afterVersionId: Type.Optional(ID),
    },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object(
      {
        versions: Type.Array(
          Type.Object(
            {
              documentId: ID,
              versionId: ID,
              displayTitle: Type.String(),
              state: Type.String(),
              failureKind: Type.Union([Type.String(), Type.Null()]),
              failureCode: Type.Union([Type.String(), Type.Null()]),
              manualRetryCount: Type.Integer(),
              retainedUntil: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
              createdAt: Type.String({ format: 'date-time' }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
};
interface Query {
  readonly roomId: string;
  readonly limit?: string;
  readonly afterCreatedAt?: string;
  readonly afterVersionId?: string;
}
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const query = request.query as Query;
    if ((query.afterCreatedAt === undefined) !== (query.afterVersionId === undefined))
      throw new Error('PROCESSING_CURSOR_INVALID');
    return {
      versions: await readProcessingState({
        pool: runtime.pool,
        identity,
        roomId: query.roomId,
        afterCreatedAt: query.afterCreatedAt ?? null,
        afterVersionId: query.afterVersionId ?? null,
        limit: Number(query.limit ?? '50'),
      }),
    };
  };
}
export function handler(): never {
  throw new Error('processing state route runtime not initialized');
}
