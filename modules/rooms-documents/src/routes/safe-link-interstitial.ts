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
    const encoded = normalized.interstitialPath.split('target=')[1];
    if (encoded === undefined) throw new Error('EXTERNAL_LINK_UNSAFE');
    return {
      normalizedDomain: normalized.normalizedDomain,
      destination: decodeURIComponent(encoded),
      warning: 'You are leaving Duefold. The destination is outside this data room.' as const,
      rel: 'noopener noreferrer' as const,
    };
  };
}
export function handler(): never {
  throw new Error('safe link interstitial route runtime not initialized');
}
