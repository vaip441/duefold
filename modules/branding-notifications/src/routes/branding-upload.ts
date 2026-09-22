import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  MAX_SOURCE_BYTES,
  validateDeclaredSourceSize,
  validateMultipartPlan,
  type MultipartPartPlan,
} from '../../../rooms-documents/src/resource-policy.ts';
import type { CompletedUploadPart } from '../../../rooms-documents/src/storage/s3-compatible.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const CHECKSUM = Type.String({ pattern: '^[A-Za-z0-9+/]{43}=$' });
const part = Type.Object(
  {
    partNumber: Type.Integer({ minimum: 1 }),
    size: Type.Integer({ minimum: 1 }),
    checksumSha256: CHECKSUM,
  },
  { additionalProperties: false },
);
const completed = Type.Object(
  {
    partNumber: Type.Integer({ minimum: 1 }),
    etag: Type.String({ minLength: 1, maxLength: 200 }),
    checksumSha256: CHECKSUM,
  },
  { additionalProperties: false },
);
const uploadState = Type.Union([
  Type.Literal('processing'),
  Type.Literal('ready'),
  Type.Literal('failed'),
]);
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
      { action: Type.Literal('status'), intentId: ID },
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
        state: Type.Optional(uploadState),
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
      readonly parts: readonly MultipartPartPlan[];
    }
  | { readonly action: 'status'; readonly intentId: string }
  | {
      readonly action: 'finalize';
      readonly intentId: string;
      readonly uploadId: string;
      readonly parts: readonly CompletedUploadPart[];
    };

function completionPartsValid(
  planned: readonly MultipartPartPlan[],
  completedParts: readonly CompletedUploadPart[],
): boolean {
  return (
    completedParts.length === planned.length &&
    completedParts.every((part, index) => {
      const plan = planned[index];
      return (
        plan?.partNumber === part.partNumber &&
        plan.checksumSha256 === part.checksumSha256 &&
        /^"?[A-Fa-f0-9]{32,64}"?$/u.test(part.etag)
      );
    })
  );
}

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Body;
    if (body.action === 'status') {
      const state = (
        await runtime.pool.query<{ state: 'processing' | 'ready' | 'failed' }>(
          'SELECT state FROM read_branding_upload_state($1,$2)',
          [body.intentId, identity.id],
        )
      ).rows[0]?.state;
      if (state === undefined) throw new Error('BRANDING_UPLOAD_FORBIDDEN');
      return { intentId: body.intentId, state };
    }
    if (body.action === 'finalize') {
      const selected = (
        await runtime.pool.query<{
          object_key: string;
          declared_size: string;
          declared_media_type: string;
          part_plan: readonly MultipartPartPlan[] | null;
        }>('SELECT * FROM read_branding_upload_completion($1,$2,$3)', [
          body.intentId,
          identity.id,
          body.uploadId,
        ])
      ).rows[0];
      if (selected === undefined) throw new Error('BRANDING_UPLOAD_FORBIDDEN');
      if (
        !Array.isArray(selected.part_plan) ||
        !completionPartsValid(selected.part_plan, body.parts)
      )
        throw new Error('BRANDING_UPLOAD_PARTS_MISMATCH');
      await runtime.storage.completeMultipart({
        key: selected.object_key,
        uploadId: body.uploadId,
        parts: body.parts,
      });
      const metadata = await runtime.storage.headObject(selected.object_key);
      if (
        metadata.size !== Number(selected.declared_size) ||
        metadata.contentType !== selected.declared_media_type ||
        metadata.metadata['duefold-quarantine'] !== 'branding'
      )
        throw new Error('BRANDING_UPLOAD_METADATA_MISMATCH');
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
    validateMultipartPlan(body.size, body.parts, runtime.storage.checksumSupport);
    const intentId = createOpaqueId();
    const key = `quarantine/${createOpaqueId()}/${createOpaqueId()}`;
    const multipart = await runtime.storage.createMultipart({
      key,
      contentType: body.mediaType,
      metadata: { 'duefold-quarantine': 'branding' },
    });
    try {
      await runtime.pool.query(
        'SELECT create_branding_upload_intent($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',
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
          JSON.stringify(body.parts),
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
            ...(item.checksumSha256 === undefined
              ? {}
              : { checksumSha256: item.checksumSha256 }),
          }),
        })),
      );
      reply.code(200);
      return { intentId, uploadId: multipart.uploadId, parts: urls };
    } catch (error) {
      await runtime.storage.abortMultipart(multipart);
      throw error;
    }
  };
}
export function handler(): never {
  throw new Error('branding upload runtime not initialized');
}
