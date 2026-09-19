import { Readable } from 'node:stream';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { createDownloadLease, streamDownloadRange } from '../downloads.ts';
const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
export const leaseSchema = {
  body: Type.Object({ roomId: ID, documentId: ID }, { additionalProperties: false }),
  response: {
    201: Type.Object(
      {
        leaseId: ID,
        versionId: ID,
        sizeBytes: Type.Integer({ minimum: 1 }),
        expiresAt: Type.String({ format: 'date-time' }),
        filename: Type.String({ minLength: 1, maxLength: 255 }),
        correlationId: Type.String({ pattern: '^corr_[A-Za-z0-9_-]{32}$' }),
      },
      { additionalProperties: false },
    ),
  },
};
export const rangeSchema = {
  querystring: Type.Object({ leaseId: ID }, { additionalProperties: false }),
  headers: Type.Object(
    { range: Type.String({ pattern: '^bytes=[0-9]+-[0-9]+$', maxLength: 80 }) },
    { additionalProperties: true },
  ),
  response: { 206: Type.Any() },
};
function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('REQUEST_INVALID');
  return value as Readonly<Record<string, unknown>>;
}
export function createLeaseHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const value = record(request.body);
    const result = await createDownloadLease({
      pool: runtime.pool,
      identity,
      roomId: String(value['roomId']),
      documentId: String(value['documentId']),
    });
    reply.code(201);
    return { ...result, expiresAt: result.expiresAt.toISOString() };
  };
}
export function createRangeHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const query = record(request.query);
    const rangeHeader = request.headers.range;
    if (typeof rangeHeader !== 'string') throw new Error('RANGE_REQUIRED');
    const result = await streamDownloadRange({
      pool: runtime.pool,
      storage: runtime.deliveryStorage,
      identity,
      leaseId: String(query['leaseId']),
      rangeHeader,
    });
    const rangeMatch = /^bytes=([0-9]+)-([0-9]+)$/u.exec(rangeHeader);
    if (rangeMatch === null) throw new Error('RANGE_INVALID');
    return reply
      .code(206)
      .header('Accept-Ranges', 'bytes')
      .header(
        'Content-Range',
        `bytes ${rangeMatch[1]}-${rangeMatch[2]}/${String(result.sizeBytes)}`,
      )
      .header('Content-Length', String(result.contentLength))
      .header('X-Correlation-ID', result.correlationId)
      .send(Readable.from(result.stream));
  };
}
export function handler(): never {
  throw new Error('download route runtime not initialized');
}
