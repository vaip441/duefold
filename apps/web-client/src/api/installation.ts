/**
 * The installation-wide download default: its read, its review, and its change.
 */
import type { DownloadPolicy } from './room-settings.ts';
import {
  ApiError,
  isRecord,
  json,
  nonNegative,
  oneOf,
  positive,
  requireBoolean,
  requireRecord,
  textOrNull,
} from './transport.ts';

export interface InstallationSettings {
  readonly downloadPolicy: DownloadPolicy;
  readonly revision: number;
  readonly inheritingRoomCount: number;
}

interface ImpactCounts {
  readonly currentPolicy: DownloadPolicy;
  readonly inheritingRoomCount: number;
  readonly affectedDocumentCount: number;
  readonly expectedRevision: number;
}

/** Allowing carries its phrase and needs a fresh sign-in; denying carries neither. */
export type InstallationDownloadImpact =
  | (ImpactCounts & {
      readonly proposedPolicy: 'allow';
      readonly confirmation: string;
      readonly requiresFreshAuthentication: true;
    })
  | (ImpactCounts & {
      readonly proposedPolicy: 'deny';
      readonly confirmation: null;
      readonly requiresFreshAuthentication: false;
    });

export type InstallationDownloadChange =
  | {
      readonly policy: 'allow';
      readonly expectedRevision: number;
      readonly confirmation: string;
    }
  | { readonly policy: 'deny'; readonly expectedRevision: number };

const POLICIES: readonly DownloadPolicy[] = ['allow', 'deny'];
const PATH = '/api/installation/download-policy';

export async function loadInstallationSettings(
  signal?: AbortSignal,
): Promise<InstallationSettings> {
  const payload = await json({
    method: 'GET',
    path: '/api/installation',
    ...(signal === undefined ? {} : { signal }),
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const settings = requireRecord(payload, 'settings');
  return {
    downloadPolicy: oneOf(POLICIES, settings['downloadPolicy']),
    revision: positive(settings, 'revision'),
    inheritingRoomCount: nonNegative(settings, 'inheritingRoomCount'),
  };
}

export async function reviewInstallationDownload(
  policy: DownloadPolicy,
): Promise<InstallationDownloadImpact> {
  const payload = await json({
    method: 'POST',
    path: PATH,
    body: { action: 'dry-run', policy },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const impact = requireRecord(payload, 'impact');
  const counts: ImpactCounts = {
    currentPolicy: oneOf(POLICIES, impact['currentPolicy']),
    inheritingRoomCount: nonNegative(impact, 'inheritingRoomCount'),
    affectedDocumentCount: nonNegative(impact, 'affectedDocumentCount'),
    expectedRevision: positive(impact, 'expectedRevision'),
  };
  const fresh = requireBoolean(impact, 'requiresFreshAuthentication');
  const confirmation = textOrNull(impact['confirmation']);
  if (oneOf(POLICIES, impact['proposedPolicy']) === 'allow') {
    if (!fresh || confirmation === null) throw new ApiError('unavailable');
    return {
      ...counts,
      proposedPolicy: 'allow',
      confirmation,
      requiresFreshAuthentication: true,
    };
  }
  if (fresh || confirmation !== null) throw new ApiError('unavailable');
  return {
    ...counts,
    proposedPolicy: 'deny',
    confirmation: null,
    requiresFreshAuthentication: false,
  };
}

export async function applyInstallationDownload(
  change: InstallationDownloadChange,
): Promise<void> {
  const payload = await json({
    method: 'POST',
    path: PATH,
    body: { action: 'apply', ...change },
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  positive(payload, 'revision');
}
