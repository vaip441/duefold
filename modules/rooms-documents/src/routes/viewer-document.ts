import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { readViewerDocumentMetadata } from '../viewer-discovery.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
export const schema = {
  querystring: Type.Object({ roomId: ID, documentId: ID }, { additionalProperties: false }),
  response: {
    200: Type.Object(
      {
        document: Type.Union([
          Type.Object(
            {
              documentId: ID,
              displayTitle: Type.String({ minLength: 1, maxLength: 200 }),
              publishedVersionId: ID,
              pageCount: Type.Integer({ minimum: 1, maximum: 10000 }),
              downloadPolicy: Type.Union([Type.Literal('allow'), Type.Literal('deny')]),
            },
            { additionalProperties: false },
          ),
          Type.Null(),
        ]),
      },
      { additionalProperties: false },
    ),
  },
};

export function createHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return async (request: FastifyRequest) => {
    const query = request.query as { readonly roomId: string; readonly documentId: string };
    return {
      document: await readViewerDocumentMetadata({
        pool: runtime.pool,
        identity,
        roomId: query.roomId,
        documentId: query.documentId,
      }),
    };
  };
}
export function handler(): never {
  throw new Error('viewer document metadata route runtime not initialized');
}
