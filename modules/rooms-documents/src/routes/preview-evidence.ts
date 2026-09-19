import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { beginPreview, closePreview, heartbeatPreview } from '../protected-delivery.ts';
const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const response = Type.Object(
  { activityId: ID, correlationId: Type.String({ pattern: '^corr_[A-Za-z0-9_-]{32}$' }) },
  { additionalProperties: false },
);
export const beginSchema = {
  body: Type.Object(
    { roomId: ID, documentId: ID, versionId: ID },
    { additionalProperties: false },
  ),
  response: { 201: response },
};
export const heartbeatSchema = {
  body: Type.Object({ activityId: ID }, { additionalProperties: false }),
  response: { 200: Type.Object({ accepted: Type.Boolean() }, { additionalProperties: false }) },
};
export const closeSchema = {
  body: Type.Object(
    { activityId: ID, status: Type.Union([Type.Literal('closed'), Type.Literal('inactive')]) },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object({ summarized: Type.Boolean() }, { additionalProperties: false }),
  },
};
function body(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('REQUEST_INVALID');
  return value as Readonly<Record<string, unknown>>;
}
export function createBeginHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return async (request: FastifyRequest) => {
    const value = body(request.body);
    return beginPreview({
      pool: runtime.pool,
      identity,
      roomId: String(value['roomId']),
      documentId: String(value['documentId']),
      versionId: String(value['versionId']),
      normalizedIp: request.ip,
      now: runtime.clock.now(),
      networkKey: runtime.networkHmacKey,
      client: runtime.classifyClient(request),
    });
  };
}
export function createHeartbeatHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return async (request: FastifyRequest) => ({
    accepted: await heartbeatPreview({
      pool: runtime.pool,
      identity,
      activityId: String(body(request.body)['activityId']),
    }),
  });
}
export function createCloseHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return async (request: FastifyRequest) => {
    const value = body(request.body);
    const status = value['status'];
    if (status !== 'closed' && status !== 'inactive') throw new Error('REQUEST_INVALID');
    return {
      summarized: await closePreview({
        pool: runtime.pool,
        identity,
        activityId: String(value['activityId']),
        status,
      }),
    };
  };
}
export function handler(): never {
  throw new Error('preview evidence route runtime not initialized');
}
