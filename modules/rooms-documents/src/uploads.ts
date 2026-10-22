import type { Pool, PoolClient } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { TelemetryRecord } from '@duefold/shared/redact';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';
import { SOURCE_MEDIA_TYPES, type SourceMediaType } from './source-validation.ts';
import { mediaTypeForFilename } from './preflight.ts';
import { assertFormatEnabled } from './release-policy.ts';
import {
  validateDeclaredSourceSize,
  validateMultipartPlan,
  type MultipartPartPlan,
} from './resource-policy.ts';
import type { CompletedUploadPart, WebStorage } from './storage/s3-compatible.ts';
import { validateStructureName } from './structure.ts';

const INTENT_LIFETIME_MILLISECONDS = 24 * 60 * 60 * 1_000;
const PRESIGN_LIFETIME_SECONDS = 15 * 60;
export const VALIDATE_SOURCE_JOB = 'document.source.validate';
export const REAP_UPLOAD_JOB = 'upload.multipart.reap';
export interface CreateUploadIntentInput {
  readonly roomId: string;
  readonly documentId?: string;
  /** The working folder a new document is attached in; absent attaches at the room root. */
  readonly parentFolderId?: string;
  readonly displayTitle: string;
  readonly originalFilename: string;
  readonly declaredMediaType: string;
  readonly declaredSize: number;
  readonly parts: readonly MultipartPartPlan[];
}
export interface CreatedUploadIntent {
  readonly intentId: string;
  readonly uploadId: string;
  readonly expiresAt: Date;
  readonly parts: readonly { readonly partNumber: number; readonly url: string }[];
}
export interface FinalizeUploadInput {
  readonly intentId: string;
  readonly uploadId: string;
  readonly parts: readonly CompletedUploadPart[];
}
interface UploadIntentRow {
  readonly id: string;
  readonly room_id: string;
  readonly member_id: string;
  readonly document_id: string | null;
  readonly parent_folder_id: string | null;
  readonly display_title: string;
  readonly original_filename: string;
  readonly declared_media_type: SourceMediaType;
  readonly declared_size: string;
  readonly object_key: string;
  readonly upload_id: string;
  readonly part_plan: readonly MultipartPartPlan[];
  readonly state: string;
  readonly expires_at: Date;
}
function sourceMediaType(value: string): SourceMediaType {
  if (!(SOURCE_MEDIA_TYPES as readonly string[]).includes(value))
    throw new Error('SOURCE_TYPE_REJECTED');
  return value as SourceMediaType;
}
function safeName(value: string, maximum: number, code: string): void {
  if (
    value.length < 1 ||
    value.length > maximum ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 || character === '/' || character === '\\';
    }) ||
    value !== value.normalize('NFC')
  )
    throw new Error(code);
}
function validateSourceName(filename: string, mediaType: SourceMediaType): void {
  safeName(filename, 255, 'SOURCE_NAME_REJECTED');
  if (mediaTypeForFilename(filename) !== mediaType) throw new Error('SOURCE_NAME_REJECTED');
}
async function roomAuthorized(
  client: Pick<PoolClient, 'query'>,
  identity: MemberIdentity,
  roomId: string,
  _now: Date,
  displayTitle: string,
  documentId: string | null,
  parentFolderId: string | null,
): Promise<boolean> {
  const result = await client.query<{ authorize_upload_destination: boolean }>(
    'SELECT authorize_upload_destination($1,$2,$3,$4,$5)',
    [identity.id, roomId, documentId, displayTitle, parentFolderId],
  );
  return result.rows[0]?.authorize_upload_destination === true;
}
async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK');
}

export async function createUploadIntent(dependencies: {
  readonly pool: Pool;
  readonly storage: WebStorage;
  readonly identity: MemberIdentity;
  readonly input: CreateUploadIntentInput;
  readonly now: Date;
}): Promise<CreatedUploadIntent> {
  const { input } = dependencies;
  validateDeclaredSourceSize(input.declaredSize);
  validateMultipartPlan(input.declaredSize, input.parts, dependencies.storage.checksumSupport);
  const mediaType = sourceMediaType(input.declaredMediaType);
  assertFormatEnabled(mediaType);
  validateSourceName(input.originalFilename, mediaType);
  safeName(input.displayTitle, 200, 'DISPLAY_TITLE_REJECTED');
  // A new document's title becomes its structure name at finalize; refuse it before the transfer.
  if (input.documentId === undefined) validateStructureName(input.displayTitle);
  const authorization = await dependencies.pool.connect();
  try {
    if (
      !(await roomAuthorized(
        authorization,
        dependencies.identity,
        input.roomId,
        dependencies.now,
        input.displayTitle,
        input.documentId ?? null,
        input.parentFolderId ?? null,
      ))
    )
      throw new Error('UPLOAD_FORBIDDEN');
    // Destination ownership is part of authorize_upload_destination.
  } finally {
    authorization.release();
  }
  const intentId = createOpaqueId();
  const objectKey = `quarantine/${createOpaqueId()}/${createOpaqueId()}`;
  const multipart = await dependencies.storage.createMultipart({
    key: objectKey,
    contentType: mediaType,
    metadata: { 'duefold-intent': intentId },
  });
  if (multipart.key !== objectKey) throw new Error('STORAGE_KEY_MISMATCH');
  const expiresAt = new Date(dependencies.now.getTime() + INTENT_LIFETIME_MILLISECONDS);
  const client = await dependencies.pool.connect();
  try {
    await client.query('BEGIN');
    if (
      !(await roomAuthorized(
        client,
        dependencies.identity,
        input.roomId,
        dependencies.now,
        input.displayTitle,
        input.documentId ?? null,
        input.parentFolderId ?? null,
      ))
    )
      throw new Error('UPLOAD_FORBIDDEN');
    await client.query(
      `INSERT INTO upload_intent
       (id,room_id,member_id,document_id,parent_folder_id,display_title,original_filename,
        declared_media_type,declared_size,object_key,upload_id,part_plan,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        intentId,
        input.roomId,
        dependencies.identity.id,
        input.documentId ?? null,
        input.parentFolderId ?? null,
        input.displayTitle,
        input.originalFilename,
        mediaType,
        input.declaredSize,
        objectKey,
        multipart.uploadId,
        JSON.stringify(input.parts),
        expiresAt,
      ],
    );
    await client.query(`SELECT enqueue_job($1,$2,$3,$4::jsonb,$5,5)`, [
      createOpaqueId(),
      REAP_UPLOAD_JOB,
      `reap:${intentId}`,
      JSON.stringify({ intentId }),
      expiresAt,
    ]);
    await client.query(
      `INSERT INTO audit_event
       (id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
       VALUES ($1,'upload.intent','member',$2,$3,'upload_intent',$4,'success','UPLOAD_INTENT_CREATED',$5)`,
      [
        createOpaqueId(),
        dependencies.identity.id,
        input.roomId,
        intentId,
        createCorrelationId(),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await rollback(client);
    await dependencies.storage.abortMultipart(multipart);
    throw error;
  } finally {
    client.release();
  }
  const parts = await Promise.all(
    input.parts.map(async (part) => ({
      partNumber: part.partNumber,
      url: await dependencies.storage.presignPart({
        ...multipart,
        partNumber: part.partNumber,
        expiresInSeconds: PRESIGN_LIFETIME_SECONDS,
        ...(part.checksumSha256 === undefined ? {} : { checksumSha256: part.checksumSha256 }),
      }),
    })),
  );
  return { intentId, uploadId: multipart.uploadId, expiresAt, parts };
}

function validateCompletionParts(
  planned: readonly MultipartPartPlan[],
  completed: readonly CompletedUploadPart[],
  checksumRequired: boolean,
): void {
  if (completed.length !== planned.length) throw new Error('UPLOAD_PARTS_MISMATCH');
  for (const [index, part] of completed.entries()) {
    const plan = planned[index];
    if (
      part.partNumber !== plan?.partNumber ||
      !/^"?[A-Fa-f0-9]{32,64}"?$/u.test(part.etag) ||
      (checksumRequired && part.checksumSha256 !== plan.checksumSha256)
    )
      throw new Error('UPLOAD_PARTS_MISMATCH');
  }
}

export async function finalizeUpload(dependencies: {
  readonly pool: Pool;
  readonly storage: WebStorage;
  readonly identity: MemberIdentity;
  readonly input: FinalizeUploadInput;
  readonly now: Date;
  readonly log: { warn(record: TelemetryRecord): void };
}): Promise<{ readonly documentId: string; readonly versionId: string }> {
  const selected = await dependencies.pool.query<UploadIntentRow>(
    'SELECT * FROM upload_intent WHERE id = $1',
    [dependencies.input.intentId],
  );
  const intent = selected.rows[0];
  // Authorize before revealing state: an absent intent and another room's are one denial.
  if (
    intent === undefined ||
    !(await roomAuthorized(
      dependencies.pool,
      dependencies.identity,
      intent.room_id,
      dependencies.now,
      intent.display_title,
      intent.document_id,
      intent.parent_folder_id,
    ))
  )
    throw new Error('UPLOAD_FORBIDDEN');
  if (intent.state !== 'open') throw new Error('UPLOAD_INTENT_INVALID');
  if (intent.expires_at.getTime() <= dependencies.now.getTime())
    throw new Error('UPLOAD_INTENT_EXPIRED');
  if (
    intent.member_id !== dependencies.identity.id ||
    intent.upload_id !== dependencies.input.uploadId
  )
    throw new Error('UPLOAD_IDENTITY_MISMATCH');
  validateCompletionParts(
    intent.part_plan,
    dependencies.input.parts,
    dependencies.storage.checksumSupport,
  );
  const marked = await dependencies.pool.query(
    `WITH changed AS (
       UPDATE upload_intent SET state = 'completing'
       WHERE id = $1 AND state = 'open' AND expires_at > transaction_timestamp()
       RETURNING id,member_id,room_id
     )
     INSERT INTO audit_event
       (id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
     SELECT $2,'upload.completing','member',member_id,room_id,'upload_intent',id,
       'success','UPLOAD_COMPLETION_STARTED',$3 FROM changed`,
    [intent.id, createOpaqueId(), createCorrelationId()],
  );
  if (marked.rowCount !== 1) throw new Error('UPLOAD_INTENT_INVALID');
  let completedObject = false;
  let reaped = false;
  try {
    await dependencies.storage.completeMultipart({
      key: intent.object_key,
      uploadId: intent.upload_id,
      parts: dependencies.input.parts,
    });
    completedObject = true;
    const metadata = await dependencies.storage.headObject(intent.object_key);
    if (
      metadata.size !== Number(intent.declared_size) ||
      metadata.contentType !== intent.declared_media_type ||
      metadata.metadata['duefold-intent'] !== intent.id
    )
      throw new Error('UPLOAD_STORAGE_METADATA_MISMATCH');
    const client = await dependencies.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<UploadIntentRow>(
        "SELECT * FROM upload_intent WHERE id = $1 AND state = 'completing' FOR UPDATE",
        [intent.id],
      );
      // The reaper may have expired the intent while storage completed it; it owns cleanup.
      if (locked.rows[0] === undefined) {
        reaped = true;
        throw new Error('UPLOAD_INTENT_INVALID');
      }
      if (
        !(await roomAuthorized(
          client,
          dependencies.identity,
          intent.room_id,
          dependencies.now,
          intent.display_title,
          intent.document_id,
          intent.parent_folder_id,
        ))
      )
        throw new Error('UPLOAD_FORBIDDEN');
      const documentId = intent.document_id ?? createOpaqueId();
      const versionId = createOpaqueId();
      await client.query('SELECT create_quarantined_document_version($1,$2,$3,$4,$5,$6,$7)', [
        versionId,
        documentId,
        intent.id,
        dependencies.identity.id,
        metadata.size,
        createOpaqueId(),
        createCorrelationId(),
      ]);
      await client.query(`SELECT enqueue_job($1,$2,$3,$4::jsonb,transaction_timestamp(),5)`, [
        createOpaqueId(),
        VALIDATE_SOURCE_JOB,
        `validate:${versionId}`,
        JSON.stringify({ versionId }),
      ]);
      await client.query('COMMIT');
      return { documentId, versionId };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (reaped) throw error;
    // The completion failure is what the caller sees, so each cleanup step reports a fixed
    // code instead of replacing it. The multipart reaper clears what a failed intent holds.
    const reportCleanupFailure = (
      code:
        'UPLOAD_FAILURE_UNRECORDED' | 'UPLOAD_OBJECT_DELETE_FAILED' | 'MULTIPART_ABORT_FAILED',
    ): void => {
      dependencies.log.warn({ event: 'upload.cleanup.failed', code });
    };
    const failureRecorded = await dependencies.pool
      .query(
        `WITH changed AS (
         UPDATE upload_intent SET state = 'failed'
         WHERE id = $1 AND state = 'completing' RETURNING id,member_id,room_id
       )
       INSERT INTO audit_event
         (id,event_type,actor_kind,actor_id,room_id,resource_type,resource_id,result,reason_code,correlation_id)
       SELECT $2,'upload.failed','member',member_id,room_id,'upload_intent',id,
         'failure','UPLOAD_FINALIZE_FAILED',$3 FROM changed`,
        [intent.id, createOpaqueId(), createCorrelationId()],
      )
      .then(
        (result) => result.rowCount === 1,
        () => false,
      );
    if (!failureRecorded) reportCleanupFailure('UPLOAD_FAILURE_UNRECORDED');
    // A completion error can follow a version commit whose acknowledgement was lost, so the
    // completed object is deleted only once this intent is known to have failed.
    if (completedObject) {
      if (failureRecorded)
        await dependencies.storage.deleteObject(intent.object_key).catch(() => {
          reportCleanupFailure('UPLOAD_OBJECT_DELETE_FAILED');
        });
    } else
      await dependencies.storage
        .abortMultipart({ key: intent.object_key, uploadId: intent.upload_id })
        .catch(() => {
          reportCleanupFailure('MULTIPART_ABORT_FAILED');
        });
    throw error;
  }
}
