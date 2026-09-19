import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import {
  createWatermarkedPage,
  deliverWatermarkedPage,
  readProtectedTextLayer,
} from '../protected-delivery.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
/*
 * A querystring value is always a string on the wire, and this application
 * deliberately runs AJV with `coerceTypes: false` so a body cannot smuggle a
 * type change past validation. An `Type.Integer()` querystring member therefore
 * can never validate. The page number is accepted as a bounded NUMERIC STRING
 * and converted by the handler, which keeps the strict no-coercion posture while
 * still rejecting anything that is not a plain 1-4 digit number.
 */
const PAGE_NUMBER = Type.String({ pattern: '^[1-9][0-9]{0,3}$' });
export const createSchema = {
  body: Type.Object(
    { roomId: ID, documentId: ID, pageNumber: Type.Integer({ minimum: 1, maximum: 10000 }) },
    { additionalProperties: false },
  ),
  response: {
    201: Type.Object(
      { cacheId: ID, expiresAt: Type.String({ format: 'date-time' }) },
      { additionalProperties: false },
    ),
  },
};
export const deliverySchema = {
  querystring: Type.Object({ cacheId: ID, activityId: ID }, { additionalProperties: false }),
  response: { 200: Type.Any() },
};
export const textSchema = {
  querystring: Type.Object(
    { roomId: ID, documentId: ID, pageNumber: PAGE_NUMBER },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object(
      {
        versionId: ID,
        accessibleLabel: Type.String({ minLength: 1, maxLength: 500 }),
        items: Type.Array(
          Type.Object(
            {
              text: Type.String({ minLength: 1, maxLength: 10000 }),
              x: Type.Number(),
              y: Type.Number(),
              width: Type.Number(),
              height: Type.Number(),
              link: Type.Optional(
                Type.Object(
                  {
                    interstitialPath: Type.String({
                      pattern: '^/api/viewer/links/interstitial\\?target=',
                      maxLength: 4096,
                    }),
                    normalizedDomain: Type.String({ minLength: 1, maxLength: 253 }),
                  },
                  { additionalProperties: false },
                ),
              ),
            },
            { additionalProperties: false },
          ),
          { maxItems: 100000 },
        ),
      },
      { additionalProperties: false },
    ),
  },
};
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('REQUEST_INVALID');
  return value as Readonly<Record<string, unknown>>;
}
export function createWatermarkHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body = record(request.body);
    if (runtime.watermarkProgram === undefined)
      throw new Error('WATERMARK_ADAPTER_UNAVAILABLE');
    const result = await createWatermarkedPage({
      pool: runtime.pool,
      storage: runtime.deliveryStorage,
      watermarkProgram: runtime.watermarkProgram,
      identity,
      roomId: String(body['roomId']),
      documentId: String(body['documentId']),
      pageNumber: Number(body['pageNumber']),
    });
    reply.code(201);
    return { cacheId: result.cacheId, expiresAt: result.expiresAt.toISOString() };
  };
}
export function createDeliveryHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const query = record(request.query);
    const result = await deliverWatermarkedPage({
      pool: runtime.pool,
      storage: runtime.deliveryStorage,
      identity,
      cacheId: String(query['cacheId']),
      activityId: String(query['activityId']),
    });
    return reply.header('Content-Type', result.mediaType).send(Buffer.from(result.bytes));
  };
}
export function createTextHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return async (request: FastifyRequest) => {
    const query = record(request.query);
    return readProtectedTextLayer({
      pool: runtime.pool,
      identity,
      roomId: String(query['roomId']),
      documentId: String(query['documentId']),
      pageNumber: Number(query['pageNumber']),
    });
  };
}
export function handler(): never {
  throw new Error('protected page route runtime not initialized');
}
