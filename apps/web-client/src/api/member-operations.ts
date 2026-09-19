/**
 * Processing state, exports, branding configuration, and uploads.
 *
 * Split out of api/client.ts, which had grown to hold every HTTP domain in one
 * file. The transport, CSRF handling, and failure classification stay shared in
 * transport.ts so there is exactly one place that talks to the network.
 */

import {
  ApiError,
  failureForStatus,
  isRecord,
  json,
  request,
  requireArray,
  requireNumber,
  requireString,
  serverErrorCode,
} from './transport.ts';

export interface ProcessingVersion {
  readonly documentId: string;
  readonly versionId: string;
  readonly displayTitle: string;
  /** Server vocabulary. Mapped to copy by the UI, never shown raw. */
  readonly state: string;
  readonly failureKind: string | null;
  readonly failureCode: string | null;
  readonly manualRetryCount: number;
  readonly retainedUntil: string | null;
  readonly createdAt: string;
}

export async function loadProcessingState(
  roomId: string,
  signal?: AbortSignal,
): Promise<readonly ProcessingVersion[]> {
  const payload = await json({
    method: 'GET',
    path: `/api/documents/processing?roomId=${encodeURIComponent(roomId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  return requireArray(payload, 'versions') as readonly ProcessingVersion[];
}

export async function retryProcessing(versionId: string): Promise<void> {
  await request({
    method: 'POST',
    path: '/api/documents/processing-retry',
    body: { versionId },
  }).then(async (response) => {
    if (!response.ok)
      throw new ApiError(failureForStatus(response.status, await serverErrorCode(response)));
  });
}

/** Deletes a failed source. Irreversible, so the UI confirms before calling. */
export async function deleteFailedSource(versionId: string): Promise<void> {
  const response = await request({
    method: 'DELETE',
    path: '/api/documents/failed-source',
    body: { versionId },
  });
  if (!response.ok)
    throw new ApiError(failureForStatus(response.status, await serverErrorCode(response)));
}

export type ExportPreset = 'room-index-audit' | 'participant-access' | 'selected-documents';

export interface ExportRecord {
  readonly exportId: string;
  readonly preset: ExportPreset;
  readonly includeOriginals: boolean;
  readonly state: string;
  readonly sizeBytes: number | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly deletedAt: string | null;
}

export interface ExportPreflight {
  readonly piiCategories: readonly string[];
  readonly fileCount: number;
  readonly estimatedSize: number;
  readonly retentionEffect: string;
  readonly originalsIncluded: boolean;
}

export async function loadExports(
  roomId: string,
  signal?: AbortSignal,
): Promise<readonly ExportRecord[]> {
  const payload = await json({
    method: 'GET',
    path: `/api/exports?roomId=${encodeURIComponent(roomId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  return requireArray(payload, 'exports') as readonly ExportRecord[];
}

export interface ExportRequestInput {
  readonly roomId: string;
  readonly preset: ExportPreset;
  readonly selectedDocumentIds: readonly string[];
  readonly includeOriginals: boolean;
}

export async function preflightExport(input: ExportRequestInput): Promise<ExportPreflight> {
  const payload = await json({
    method: 'POST',
    path: '/api/exports',
    body: { action: 'preflight', ...input },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const categories = payload['piiCategories'];
  if (!Array.isArray(categories) || !categories.every((value) => typeof value === 'string'))
    throw new ApiError('unavailable');
  if (typeof payload['originalsIncluded'] !== 'boolean') throw new ApiError('unavailable');
  return {
    piiCategories: categories,
    fileCount: requireNumber(payload, 'fileCount'),
    estimatedSize: requireNumber(payload, 'estimatedSize'),
    retentionEffect: requireString(payload, 'retentionEffect'),
    originalsIncluded: payload['originalsIncluded'],
  };
}

export async function generateExport(input: ExportRequestInput): Promise<string> {
  const payload = await json({
    method: 'POST',
    path: '/api/exports',
    body: { action: 'generate', ...input },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return requireString(payload, 'exportId');
}

/**
 * Downloads an export ONCE.
 *
 * The server consumes the record on the first successful delivery, so there is no
 * second attempt. The caller must have told the member that before the click.
 */
export async function downloadExportOnce(exportId: string): Promise<Blob> {
  const response = await request({
    method: 'POST',
    path: '/api/exports/download',
    body: { exportId },
  });
  if (!response.ok)
    throw new ApiError(failureForStatus(response.status, await serverErrorCode(response)));
  return response.blob();
}

export interface BrandingConfiguration {
  readonly organizationName: string;
  readonly accentColor: string;
  readonly senderDisplayName: string;
  readonly roomIntroduction: string;
  readonly supportContact: string | null;
  readonly revision: number;
  readonly hasLogo?: boolean;
  readonly hasSquareMark?: boolean;
}

function parseBranding(payload: unknown): BrandingConfiguration {
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const contact = payload['supportContact'];
  if (contact !== null && typeof contact !== 'string') throw new ApiError('unavailable');
  const introduction = payload['roomIntroduction'];
  if (typeof introduction !== 'string') throw new ApiError('unavailable');
  return {
    organizationName: requireString(payload, 'organizationName'),
    accentColor: requireString(payload, 'accentColor'),
    senderDisplayName: requireString(payload, 'senderDisplayName'),
    roomIntroduction: introduction,
    supportContact: contact,
    revision: requireNumber(payload, 'revision'),
    hasLogo: payload['hasLogo'] === true,
    hasSquareMark: payload['hasSquareMark'] === true,
  };
}

export async function loadBranding(roomId: string): Promise<BrandingConfiguration> {
  return parseBranding(
    await json({
      method: 'POST',
      path: '/api/branding/configuration',
      body: { action: 'read', roomId },
    }),
  );
}

export async function updateBranding(input: {
  readonly roomId: string;
  readonly organizationName: string;
  readonly accentColor: string;
  readonly senderDisplayName: string;
  readonly roomIntroduction: string;
  readonly supportContact: string | null;
  readonly expectedRevision: number;
}): Promise<BrandingConfiguration> {
  return parseBranding(
    await json({
      method: 'POST',
      path: '/api/branding/configuration',
      body: { action: 'update', ...input },
    }),
  );
}

export async function createBrandingUploadIntent(input: {
  readonly assetKind: 'logo' | 'square-mark';
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly size: number;
  readonly parts: readonly { readonly partNumber: number; readonly size: number }[];
}): Promise<UploadIntentResponse> {
  const payload = await json({
    method: 'POST',
    path: '/api/branding/assets',
    body: { action: 'create', ...input },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const rawParts = payload['parts'];
  if (!Array.isArray(rawParts)) throw new ApiError('unavailable');
  const parts = rawParts.map((entry) => {
    if (!isRecord(entry)) throw new ApiError('unavailable');
    return {
      partNumber: requireNumber(entry, 'partNumber'),
      url: requireString(entry, 'url'),
    };
  });
  return {
    intentId: requireString(payload, 'intentId'),
    uploadId: requireString(payload, 'uploadId'),
    expiresAt: '',
    parts,
  };
}

export async function finalizeBrandingUpload(input: {
  readonly intentId: string;
  readonly uploadId: string;
  readonly parts: readonly { readonly partNumber: number; readonly etag: string }[];
}): Promise<void> {
  await json({
    method: 'POST',
    path: '/api/branding/assets',
    body: { action: 'finalize', ...input },
  });
}

export async function deleteBrandingAsset(input: {
  readonly roomId: string;
  readonly assetKind: 'logo' | 'square-mark';
}): Promise<void> {
  await json({
    method: 'POST',
    path: '/api/branding/assets/delete',
    body: { action: 'delete', ...input },
  });
}

export interface PublicBranding {
  readonly organizationName: string;
  readonly accentColor: string;
  readonly hasLogo: boolean;
  readonly hasSquareMark: boolean;
  readonly supportContact: { readonly kind: 'email' | 'url'; readonly value: string } | null;
}

export async function loadPublicBranding(signal?: AbortSignal): Promise<PublicBranding> {
  const payload = await json({
    method: 'GET',
    path: '/api/branding/public',
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const contact = payload['supportContact'];
  let parsedContact: { kind: 'email' | 'url'; value: string } | null = null;
  if (
    isRecord(contact) &&
    (contact['kind'] === 'email' || contact['kind'] === 'url') &&
    typeof contact['value'] === 'string'
  ) {
    parsedContact = { kind: contact['kind'], value: contact['value'] };
  }
  return {
    organizationName:
      typeof payload['organizationName'] === 'string' ? payload['organizationName'] : 'Duefold',
    accentColor:
      typeof payload['accentColor'] === 'string' ? payload['accentColor'] : '#006b5e',
    hasLogo: payload['hasLogo'] === true,
    hasSquareMark: payload['hasSquareMark'] === true,
    supportContact: parsedContact,
  };
}

/*
 * Upload intent and finalization.
 *
 * The server returns presigned part URLs; the browser holds no storage credential
 * and constructs no storage URL. The original filename is declared so the server
 * can validate the extension, and readers see the member-chosen display title
 * instead.
 */
export interface UploadIntentResponse {
  readonly intentId: string;
  readonly uploadId: string;
  readonly expiresAt: string;
  readonly parts: readonly { readonly partNumber: number; readonly url: string }[];
}

export async function createUploadIntent(input: {
  readonly roomId: string;
  readonly documentId?: string;
  readonly displayTitle: string;
  readonly originalFilename: string;
  readonly declaredMediaType: string;
  readonly declaredSize: number;
  readonly parts: readonly { readonly partNumber: number; readonly size: number }[];
}): Promise<UploadIntentResponse> {
  const payload = await json({ method: 'POST', path: '/api/uploads/intents', body: input });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const rawParts = payload['parts'];
  if (!Array.isArray(rawParts)) throw new ApiError('unavailable');
  const parts = rawParts.map((entry) => {
    if (!isRecord(entry)) throw new ApiError('unavailable');
    return {
      partNumber: requireNumber(entry, 'partNumber'),
      url: requireString(entry, 'url'),
    };
  });
  return {
    intentId: requireString(payload, 'intentId'),
    uploadId: requireString(payload, 'uploadId'),
    expiresAt: requireString(payload, 'expiresAt'),
    parts,
  };
}

export async function finalizeUpload(input: {
  readonly intentId: string;
  readonly uploadId: string;
  readonly parts: readonly { readonly partNumber: number; readonly etag: string }[];
}): Promise<{ readonly documentId: string; readonly versionId: string }> {
  const payload = await json({ method: 'POST', path: '/api/uploads/finalize', body: input });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return {
    documentId: requireString(payload, 'documentId'),
    versionId: requireString(payload, 'versionId'),
  };
}
