/**
 * Public support contact from the single persisted branding configuration.
 * Nothing else from branding, organization, rooms, or member identity crosses
 * this unauthenticated projection.
 */
import { Type } from '@sinclair/typebox';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { SupportContact } from '@duefold/shared/support-contact';

export const schema = {
  response: {
    200: Type.Object(
      {
        supportContact: Type.Union([
          Type.Null(),
          Type.Object(
            {
              kind: Type.Union([Type.Literal('email'), Type.Literal('url')]),
              value: Type.String({ minLength: 1, maxLength: 2048 }),
            },
            { additionalProperties: false },
          ),
        ]),
      },
      { additionalProperties: false },
    ),
  },
};
export interface SupportContactResponse {
  readonly supportContact: SupportContact | null;
}
interface Row {
  readonly kind: 'email' | 'url';
  readonly value: string;
}
export function createHandler(runtime: WebRuntime): () => Promise<SupportContactResponse> {
  return async () => {
    const row = (await runtime.pool.query<Row>('SELECT * FROM read_public_support_contact()'))
      .rows[0];
    return { supportContact: row ?? null };
  };
}
export function handler(): never {
  throw new Error('branding route runtime not initialized');
}
