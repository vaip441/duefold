import { Readable } from 'node:stream';
import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { downloadExportOnce, type ExportStorage } from '../exports.ts';
const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
export const schema = {
  body: Type.Object({ exportId: ID }, { additionalProperties: false }),
  response: { 200: Type.Any() },
};
function storage(runtime: WebRuntime): ExportStorage {
  return {
    putStream: () => Promise.reject(new Error('EXPORT_WEB_WRITE_FORBIDDEN')),
    streamSource: () => Promise.reject(new Error('EXPORT_WEB_SOURCE_READ_FORBIDDEN')),
    streamExport: (key, size) =>
      runtime.deliveryStorage.streamObjectRange(key, {
        start: 0,
        endInclusive: size - 1,
      }),
    delete: (key) => runtime.deliveryStorage.deleteObject(key),
  };
}
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { readonly exportId: string };
    const downloaded = await downloadExportOnce({
      pool: runtime.pool,
      storage: storage(runtime),
      identity,
      exportId: body.exportId,
    });
    return reply
      .header('cache-control', 'private, no-store')
      .header('content-type', downloaded.contentType)
      .header('content-length', String(downloaded.size))
      .header('content-disposition', 'attachment; filename="duefold-export"')
      .send(Readable.from(downloaded.stream));
  };
}
export function handler(): never {
  throw new Error('export download route runtime not initialized');
}
