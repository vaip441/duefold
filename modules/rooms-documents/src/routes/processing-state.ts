import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { CURSOR_CREATED_AT, readProcessingState } from '../member-state-readers.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
export const schema = {
  querystring: Type.Object(
    {
      roomId: ID,
      limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
      afterCreatedAt: Type.Optional(CURSOR_CREATED_AT),
      afterVersionId: Type.Optional(ID),
    },
    {
      additionalProperties: false,
      dependencies: { afterCreatedAt: ['afterVersionId'], afterVersionId: ['afterCreatedAt'] },
    },
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
        nextCursor: Type.Optional(
          Type.Object(
            { createdAt: CURSOR_CREATED_AT, versionId: ID },
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
    return readProcessingState({
      pool: runtime.pool,
      identity,
      roomId: query.roomId,
      afterCreatedAt: query.afterCreatedAt ?? null,
      afterVersionId: query.afterVersionId ?? null,
      limit: Number(query.limit ?? '50'),
    });
  };
}
