/**
 * Branding configuration and asset requests.
 *
 * These live in the module rather than in the application's API barrel because
 * they are the only callers of the branding routes, and an omitted module must
 * leave no request path behind. The shared transport still owns CSRF, failure
 * classification, and the rule that nothing is persisted.
 */

import {
  ApiError,
  isRecord,
  json,
  requireNumber,
  requireString,
  type UploadIntentResponse,
} from '@duefold/web-client/module-api';

export interface BrandingConfiguration {
  readonly organizationName: string;
  readonly accentColor: string;
  readonly senderDisplayName: string;
  readonly roomIntroduction: string;
  readonly supportContact: string | null;
  readonly revision: number;
  readonly hasLogo: boolean;
  readonly hasSquareMark: boolean;
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

export async function loadBranding(): Promise<BrandingConfiguration> {
  return parseBranding(
    await json({
      method: 'POST',
      path: '/api/branding/configuration',
      body: { action: 'read' },
    }),
  );
}

export interface BrandingUpdate {
  readonly organizationName: string;
  readonly accentColor: string;
  readonly senderDisplayName: string;
  readonly roomIntroduction: string;
  readonly supportContact: string | null;
  readonly expectedRevision: number;
}

export async function updateBranding(input: BrandingUpdate): Promise<BrandingConfiguration> {
  return parseBranding(
    await json({
      method: 'POST',
      path: '/api/branding/configuration',
      body: { action: 'update', ...input },
    }),
  );
}

export type BrandingAssetKind = 'logo' | 'square-mark';
export type BrandingUploadState = 'processing' | 'ready' | 'failed';

export async function createBrandingUploadIntent(input: {
  readonly assetKind: BrandingAssetKind;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly size: number;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly size: number;
    readonly checksumSha256: string;
  }[];
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
    return { partNumber: requireNumber(entry, 'partNumber'), url: requireString(entry, 'url') };
  });
  /* The branding intent carries no expiry of its own; the shared intent shape
   * requires the field, and an empty value states "not reported" rather than
   * inventing an instant a caller might compare against. */
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
  readonly parts: readonly {
    readonly partNumber: number;
    readonly etag: string;
    readonly checksumSha256: string;
  }[];
}): Promise<void> {
  await json({
    method: 'POST',
    path: '/api/branding/assets',
    body: { action: 'finalize', ...input },
  });
}

export async function loadBrandingUploadState(intentId: string): Promise<BrandingUploadState> {
  const payload = await json({
    method: 'POST',
    path: '/api/branding/assets',
    body: { action: 'status', intentId },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const state = requireString(payload, 'state');
  if (state !== 'processing' && state !== 'ready' && state !== 'failed')
    throw new ApiError('unavailable');
  return state;
}

export async function deleteBrandingAsset(input: {
  readonly assetKind: BrandingAssetKind;
}): Promise<void> {
  await json({
    method: 'POST',
    path: '/api/branding/assets/delete',
    body: { action: 'delete', ...input },
  });
}
