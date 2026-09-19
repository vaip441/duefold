/**
 * Public delivery route for sanitized, processed brand derivatives.
 *
 * Serves only processed derivatives (never quarantined or original uploads).
 * Sets strict content security, MIME type, and caching headers.
 */

import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';

export const schema = {
  params: Type.Object(
    {
      kind: Type.Union([Type.Literal('logo'), Type.Literal('square-mark')]),
    },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Any(),
  },
};

interface Row {
  readonly object_key: string;
  readonly media_type: string;
  readonly size_bytes: number;
}

export function createHandler(runtime: WebRuntime) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { readonly kind?: string };
    const kind = params.kind;
    if (kind !== 'logo' && kind !== 'square-mark') {
      reply.code(400);
      return { code: 'INVALID_ASSET_KIND' };
    }
    const row = (
      await runtime.pool.query<Row>('SELECT * FROM read_public_branding_asset($1)', [kind])
    ).rows[0];
    if (row === undefined) {
      reply.code(404);
      return { code: 'BRANDING_ASSET_NOT_FOUND' };
    }
    const bytes = await runtime.deliveryStorage.getObjectBytes(row.object_key);
    return reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400')
      .header('Content-Security-Policy', "default-src 'none'")
      .header('X-Content-Type-Options', 'nosniff')
      .send(Buffer.from(bytes));
  };
}

export function handler(): never {
  throw new Error('branding route runtime not initialized');
}
