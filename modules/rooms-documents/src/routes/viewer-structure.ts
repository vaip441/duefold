import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { readViewerStructure } from '../viewer-discovery.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
export const schema = {
  querystring: Type.Object({ roomId: ID }, { additionalProperties: false }),
  response: {
    200: Type.Object(
      {
        entries: Type.Array(
          Type.Object(
            {
              entryId: ID,
              resourceKind: Type.Union([Type.Literal('folder'), Type.Literal('document')]),
              resourceId: ID,
              parentFolderId: Type.Union([ID, Type.Null()]),
              displayName: Type.String({ minLength: 1, maxLength: 200 }),
              description: Type.String({ maxLength: 2000 }),
              publishedVersionId: Type.Union([ID, Type.Null()]),
              siblingPosition: Type.Integer({ minimum: 1 }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
};

export function createHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return async (request: FastifyRequest) => {
    const query = request.query as { readonly roomId: string };
    return {
      entries: await readViewerStructure({
        pool: runtime.pool,
        identity,
        roomId: query.roomId,
      }),
    };
  };
}
export function handler(): never {
  throw new Error('viewer structure route runtime not initialized');
}
