import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import {
  ERROR_ENVELOPE,
  protectedErrorResponses,
} from '../../../core-security/src/routes/error-envelope.ts';
import {
  readPreviewDocument,
  readPreviewPageImage,
  readPreviewRoom,
  readPreviewTextLayer,
} from '../member-preview.ts';
import { PAGE_NUMBER, textSchema } from './protected-page.ts';
import { schema as viewerDocumentSchema } from './viewer-document.ts';
import { schema as viewerStructureSchema } from './viewer-structure.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const closed = { additionalProperties: false } as const;
const pageQuery = Type.Object({ roomId: ID, documentId: ID, pageNumber: PAGE_NUMBER }, closed);
/* A missing room, page, or derivative answers the same non-enumerating 404 as the
   viewer's protected pages. */
const errors = { ...protectedErrorResponses(), 404: ERROR_ENVELOPE };

export const roomSchema = {
  querystring: Type.Object({ roomId: ID }, closed),
  response: {
    200: Type.Object(
      {
        title: Type.String({ minLength: 1, maxLength: 200 }),
        state: Type.Union([
          Type.Literal('draft'),
          Type.Literal('published'),
          Type.Literal('archived'),
        ]),
        entries: viewerStructureSchema.response[200].properties.entries,
      },
      closed,
    ),
    ...errors,
  },
};
export const documentSchema = {
  querystring: Type.Object({ roomId: ID, documentId: ID }, closed),
  response: { 200: viewerDocumentSchema.response[200], ...errors },
};
export const imageSchema = {
  querystring: pageQuery,
  response: { 200: Type.Any(), ...errors },
};
/* The preview text layer never carries a link, so its schema is the viewer's with
   `link` removed: a regression that let one through fails response validation. */
const { text, x, y, width, height } =
  textSchema.response[200].properties.items.items.properties;
const previewItem = { text, x, y, width, height };
export const textPreviewSchema = {
  querystring: pageQuery,
  response: {
    200: Type.Object(
      {
        versionId: ID,
        accessibleLabel: textSchema.response[200].properties.accessibleLabel,
        items: Type.Array(Type.Object(previewItem, closed), { maxItems: 100000 }),
      },
      closed,
    ),
    ...errors,
  },
};

interface PageQuery {
  readonly roomId: string;
  readonly documentId: string;
  readonly pageNumber: string;
}

export function createRoomHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return (request: FastifyRequest) => {
    const query = request.query as { readonly roomId: string };
    return readPreviewRoom({ pool: runtime.pool, identity, roomId: query.roomId });
  };
}
export function createDocumentHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const query = request.query as { readonly roomId: string; readonly documentId: string };
    return {
      document: await readPreviewDocument({
        pool: runtime.pool,
        identity,
        roomId: query.roomId,
        documentId: query.documentId,
      }),
    };
  };
}
export function createImageHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as PageQuery;
    const page = await readPreviewPageImage({
      pool: runtime.pool,
      storage: runtime.deliveryStorage,
      identity,
      roomId: query.roomId,
      documentId: query.documentId,
      pageNumber: Number(query.pageNumber),
    });
    return reply.header('Content-Type', page.mediaType).send(Buffer.from(page.bytes));
  };
}
export function createTextHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return (request: FastifyRequest) => {
    const query = request.query as PageQuery;
    return readPreviewTextLayer({
      pool: runtime.pool,
      identity,
      roomId: query.roomId,
      documentId: query.documentId,
      pageNumber: Number(query.pageNumber),
    });
  };
}
