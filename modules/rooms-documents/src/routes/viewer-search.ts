import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { searchViewerStructure } from '../viewer-discovery.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
export const schema = {
  querystring: Type.Object(
    {
      roomId: ID,
      query: Type.String({ minLength: 1, maxLength: 200 }),
      /*
       * A numeric STRING, because querystring values arrive as strings and this
       * application runs AJV with `coerceTypes: false` on purpose. Declared as
       * `Type.Integer()` this member could never validate, so any request
       * supplying a limit was rejected.
       */
      limit: Type.Optional(Type.String({ pattern: '^(100|[1-9][0-9]?)$' })),
    },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object(
      {
        results: Type.Array(
          Type.Object(
            {
              resourceKind: Type.Union([Type.Literal('folder'), Type.Literal('document')]),
              resourceId: ID,
              displayName: Type.String({ minLength: 1, maxLength: 200 }),
              description: Type.String({ maxLength: 2000 }),
              path: Type.String({ minLength: 1, maxLength: 4000 }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 100 },
        ),
      },
      { additionalProperties: false },
    ),
  },
};

export function createHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return async (request: FastifyRequest) => {
    const query = request.query as {
      readonly roomId: string;
      readonly query: string;
      readonly limit?: string;
    };
    return {
      results: await searchViewerStructure({
        pool: runtime.pool,
        identity,
        roomId: query.roomId,
        query: query.query,
        limit: query.limit === undefined ? 25 : Number(query.limit),
      }),
    };
  };
}
export function handler(): never {
  throw new Error('viewer search route runtime not initialized');
}
