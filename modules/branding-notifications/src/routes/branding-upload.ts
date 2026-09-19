import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  MAX_SOURCE_BYTES,
  validateDeclaredSourceSize,
  validateMultipartPlan,
} from '../../../rooms-documents/src/resource-policy.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const part = Type.Object(
  { partNumber: Type.Integer({ minimum: 1 }), size: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
const completed = Type.Object(
  {
    partNumber: Type.Integer({ minimum: 1 }),
    etag: Type.String({ minLength: 1, maxLength: 200 }),
    checksumSha256: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9+/]{43}=$' })),
  },
  { additionalProperties: false },
);
export const schema = {
  body: Type.Union([
    Type.Object(
      {
        action: Type.Literal('create'),
        assetKind: Type.Union([Type.Literal('logo'), Type.Literal('square-mark')]),
        mediaType: Type.Union([
          Type.Literal('image/png'),
          Type.Literal('image/jpeg'),
          Type.Literal('image/webp'),
        ]),
        size: Type.Integer({ minimum: 1, maximum: MAX_SOURCE_BYTES }),
        parts: Type.Array(part, { minItems: 1, maxItems: 50 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('finalize'),
        intentId: ID,
        uploadId: Type.String({ minLength: 1, maxLength: 1024 }),
        parts: Type.Array(completed, { minItems: 1, maxItems: 50 }),
      },
      { additionalProperties: false },
    ),
  ]),
  response: {
    200: Type.Object(
      {
        intentId: ID,
        uploadId: Type.Optional(Type.String()),
        parts: Type.Optional(
          Type.Array(Type.Object({ partNumber: Type.Integer(), url: Type.String() })),
        ),
      },
      { additionalProperties: false },
    ),
  },
};
type Body =
  | {
      readonly action: 'create';
      readonly assetKind: 'logo' | 'square-mark';
      readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
      readonly size: number;
      readonly parts: readonly { readonly partNumber: number; readonly size: number }[];
    }
  | {
      readonly action: 'finalize';
      readonly intentId: string;
      readonly uploadId: string;
      readonly parts: readonly {
        readonly partNumber: number;
        readonly etag: string;
        readonly checksumSha256?: string;
      }[];
    };
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Body;
    if (body.action === 'finalize') {
      const selected = (
        await runtime.pool.query<{ object_key: string; declared_size: string }>(
          'SELECT * FROM read_branding_upload_completion($1,$2,$3)',
          [body.intentId, identity.id, body.uploadId],
        )
      ).rows[0];
      if (selected === undefined) throw new Error('BRANDING_UPLOAD_FORBIDDEN');
      await runtime.storage.completeMultipart({
        key: selected.object_key,
        uploadId: body.uploadId,
        parts: body.parts,
      });
      const metadata = await runtime.storage.headObject(selected.object_key);
      if (metadata.size !== Number(selected.declared_size))
        throw new Error('BRANDING_UPLOAD_SIZE_MISMATCH');
      await runtime.pool.query('SELECT finalize_branding_upload($1,$2,$3,$4,$5,$6)', [
        body.intentId,
        identity.id,
        metadata.size,
        createOpaqueId(),
        createOpaqueId(),
        createCorrelationId(),
      ]);
      return { intentId: body.intentId };
    }
    validateDeclaredSourceSize(body.size);
    validateMultipartPlan(body.size, body.parts, false);
    const intentId = createOpaqueId();
    const key = `quarantine/${createOpaqueId()}/${createOpaqueId()}`;
    const multipart = await runtime.storage.createMultipart({
      key,
      contentType: body.mediaType,
      metadata: { 'duefold-quarantine': 'branding' },
    });
    await runtime.pool.query(
      'SELECT create_branding_upload_intent($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        intentId,
        identity.id,
        body.assetKind,
        body.mediaType,
        body.size,
        key,
        multipart.uploadId,
        createOpaqueId(),
        createCorrelationId(),
      ],
    );
    const urls = await Promise.all(
      body.parts.map(async (item) => ({
        partNumber: item.partNumber,
        url: await runtime.storage.presignPart({
          key,
          uploadId: multipart.uploadId,
          partNumber: item.partNumber,
          expiresInSeconds: 900,
        }),
      })),
    );
    reply.code(200);
    return { intentId, uploadId: multipart.uploadId, parts: urls };
  };
}
export function handler(): never {
  throw new Error('branding upload runtime not initialized');
}
