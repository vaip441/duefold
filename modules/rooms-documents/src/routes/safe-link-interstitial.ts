import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import { resolveInterstitialTarget } from '../protected-delivery.ts';
export const schema = {
  querystring: Type.Object(
    { target: Type.String({ minLength: 1, maxLength: 2048 }) },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object(
      {
        normalizedDomain: Type.String({ minLength: 1, maxLength: 253 }),
        destination: Type.String({ format: 'uri' }),
        warning: Type.Literal(
          'You are leaving Duefold. The destination is outside this data room.',
        ),
        rel: Type.Literal('noopener noreferrer'),
      },
      { additionalProperties: false },
    ),
  },
};
export function createHandler() {
  return (request: FastifyRequest) => {
    const query = request.query as { readonly target: string };
    const normalized = resolveInterstitialTarget(query.target);
    return {
      normalizedDomain: normalized.normalizedDomain,
      destination: normalized.href,
      warning: 'You are leaving Duefold. The destination is outside this data room.' as const,
      rel: 'noopener noreferrer' as const,
    };
  };
}
