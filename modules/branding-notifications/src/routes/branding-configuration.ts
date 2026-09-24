import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { parseSupportContact } from '@duefold/shared/support-contact';
import { validateBranding } from '../branding.ts';

const CONFIG = Type.Object(
  {
    organizationName: Type.String({ minLength: 1, maxLength: 200 }),
    accentColor: Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' }),
    senderDisplayName: Type.String({ minLength: 1, maxLength: 200 }),
    roomIntroduction: Type.String({ maxLength: 2000 }),
    supportContact: Type.Union([Type.String({ minLength: 3, maxLength: 2048 }), Type.Null()]),
    revision: Type.Integer({ minimum: 1 }),
    hasLogo: Type.Optional(Type.Boolean()),
    hasSquareMark: Type.Optional(Type.Boolean()),
    logoIncludesName: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const schema = {
  body: Type.Union([
    Type.Object({ action: Type.Literal('read') }, { additionalProperties: false }),
    Type.Object(
      {
        action: Type.Literal('update'),
        organizationName: Type.String({ minLength: 1, maxLength: 200 }),
        accentColor: Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' }),
        senderDisplayName: Type.String({ minLength: 1, maxLength: 200 }),
        roomIntroduction: Type.String({ maxLength: 2000 }),
        supportContact: Type.Union([
          Type.String({ minLength: 3, maxLength: 2048 }),
          Type.Null(),
        ]),
        logoIncludesName: Type.Boolean(),
        expectedRevision: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  ]),
  response: { 200: CONFIG },
};
type Body =
  | { readonly action: 'read' }
  | {
      readonly action: 'update';
      readonly organizationName: string;
      readonly accentColor: string;
      readonly senderDisplayName: string;
      readonly roomIntroduction: string;
      readonly supportContact: string | null;
      readonly logoIncludesName: boolean;
      readonly expectedRevision: number;
    };
interface Row {
  readonly organization_name: string;
  readonly accent_color: string;
  readonly sender_display_name: string;
  readonly room_introduction: string;
  readonly support_contact: string | null;
  readonly revision: number;
  readonly has_logo?: boolean;
  readonly has_square_mark?: boolean;
  readonly logo_includes_name: boolean;
}
async function read(runtime: WebRuntime, identity: MemberIdentity) {
  const row = (
    await runtime.pool.query<Row>('SELECT * FROM read_branding_configuration($1)', [
      identity.id,
    ])
  ).rows[0];
  if (row === undefined) throw new Error('BRANDING_CONFIGURATION_UNAVAILABLE');
  return {
    organizationName: row.organization_name,
    accentColor: row.accent_color,
    senderDisplayName: row.sender_display_name,
    roomIntroduction: row.room_introduction,
    supportContact: row.support_contact,
    revision: row.revision,
    hasLogo: row.has_logo ?? false,
    hasSquareMark: row.has_square_mark ?? false,
    logoIncludesName: row.logo_includes_name,
  };
}
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const body = request.body as Body;
    if (body.action === 'read') return read(runtime, identity);
    const fields = validateBranding({
      organizationName: body.organizationName,
      accentColor: body.accentColor,
      senderDisplayName: body.senderDisplayName,
      roomIntroduction: body.roomIntroduction,
      ...(body.supportContact === null ? {} : { supportContact: body.supportContact }),
    });
    const parsedContact = parseSupportContact(body.supportContact ?? undefined);
    await runtime.pool.query(
      'SELECT update_branding_configuration($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        identity.id,
        fields['organizationName'],
        fields['accentColor'],
        fields['senderDisplayName'],
        fields['roomIntroduction'],
        parsedContact?.value ?? null,
        parsedContact?.kind ?? null,
        body.logoIncludesName,
        body.expectedRevision,
        createOpaqueId(),
        createCorrelationId(),
      ],
    );
    return read(runtime, identity);
  };
}
export function handler(): never {
  throw new Error('branding configuration route runtime not initialized');
}
