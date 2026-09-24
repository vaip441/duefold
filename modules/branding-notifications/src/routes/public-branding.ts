/**
 * Public branding projection from the single persisted branding configuration.
 *
 * Exposes organization name, accent, asset presence, whether the logo already
 * carries the name, and support contact. Leaks
 * no internal object keys, digest values, room ids, room content, or member
 * identities.
 */

import { Type } from '@sinclair/typebox';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { SupportContact } from '@duefold/shared/support-contact';

export const schema = {
  response: {
    200: Type.Object(
      {
        organizationName: Type.String({ minLength: 1, maxLength: 200 }),
        accentColor: Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' }),
        hasLogo: Type.Boolean(),
        hasSquareMark: Type.Boolean(),
        logoIncludesName: Type.Boolean(),
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

export interface PublicBrandingResponse {
  readonly organizationName: string;
  readonly accentColor: string;
  readonly hasLogo: boolean;
  readonly hasSquareMark: boolean;
  readonly logoIncludesName: boolean;
  readonly supportContact: SupportContact | null;
}

interface Row {
  readonly organization_name: string;
  readonly accent_color: string;
  readonly has_logo: boolean;
  readonly has_square_mark: boolean;
  readonly logo_includes_name: boolean;
  readonly support_contact_kind: 'email' | 'url' | null;
  readonly support_contact: string | null;
}

export function createHandler(runtime: WebRuntime): () => Promise<PublicBrandingResponse> {
  return async () => {
    const row = (await runtime.pool.query<Row>('SELECT * FROM read_public_branding()')).rows[0];
    if (row === undefined) {
      return {
        organizationName: 'Duefold',
        accentColor: '#006b5e',
        hasLogo: false,
        hasSquareMark: false,
        logoIncludesName: false,
        supportContact: null,
      };
    }
    return {
      organizationName: row.organization_name,
      accentColor: row.accent_color,
      hasLogo: row.has_logo,
      hasSquareMark: row.has_square_mark,
      logoIncludesName: row.logo_includes_name,
      supportContact:
        row.support_contact_kind !== null && row.support_contact !== null
          ? { kind: row.support_contact_kind, value: row.support_contact }
          : null,
    };
  };
}

export function handler(): never {
  throw new Error('branding route runtime not initialized');
}
