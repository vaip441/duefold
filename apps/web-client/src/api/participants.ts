/**
 * Participants and allow-only access grants.
 *
 * Split out of api/client.ts, which had grown to hold every HTTP domain in one
 * file. The transport, CSRF handling, and failure classification stay shared in
 * transport.ts so there is exactly one place that talks to the network.
 */

import {
  ApiError,
  isRecord,
  json,
  requireArray,
  requireNumber,
  requireString,
} from './transport.ts';

export type GrantSource = 'direct' | 'counterparty';
export type GrantTargetKind = 'room' | 'folder' | 'document';
export type GrantChangeAction = 'grant' | 'revoke' | 'expiry';
export type GranteeKind = 'viewer' | 'counterparty';

export interface ParticipantGrant {
  readonly grantId: string;
  readonly source: GrantSource;
  readonly targetKind: GrantTargetKind;
  readonly folderId: string | null;
  readonly documentId: string | null;
  readonly expiresAt: string | null;
  /** False for an expired or superseded grant, which is still shown. */
  readonly effective: boolean;
  readonly revision: number;
}

export interface Participant {
  readonly viewerId: string;
  readonly email: string;
  readonly membershipState: 'active' | 'revoked';
  readonly membershipRevision: number;
  readonly counterpartyId: string | null;
  readonly counterpartyName: string | null;
  readonly grants: readonly ParticipantGrant[];
}

/** The server's impact statement. Every field is the server's, not derived. */
export interface GrantImpact {
  readonly grantId: string;
  readonly action: GrantChangeAction;
  readonly affectedCount: number;
  readonly paths: readonly string[];
  readonly confirmation: string;
  readonly message: string;
  readonly resolvedExpiresAt: string | null;
  readonly roomRevision?: number;
}

export interface GrantChangeRequest {
  readonly roomId: string;
  readonly changeAction: GrantChangeAction;
  readonly grantId?: string;
  readonly granteeKind: GranteeKind | null;
  readonly viewerId: string | null;
  readonly counterpartyId: string | null;
  readonly targetKind: GrantTargetKind | null;
  readonly folderId: string | null;
  readonly documentId: string | null;
  readonly expiresAt: string | null;
}

export async function loadParticipants(
  roomId: string,
  signal?: AbortSignal,
): Promise<readonly Participant[]> {
  const payload = await json({
    method: 'GET',
    path: `/api/participants?roomId=${encodeURIComponent(roomId)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  return requireArray(payload, 'participants') as readonly Participant[];
}

export async function inviteParticipant(input: {
  readonly roomId: string;
  readonly email: string;
  readonly expectedRoomRevision: number;
}): Promise<{ readonly invitationId: string; readonly roomRevision: number }> {
  const payload = await json({
    method: 'POST',
    path: '/api/participants/invitations',
    body: input,
  });
  if (!isRecord(payload)) throw new ApiError('unavailable');
  return {
    invitationId: requireString(payload, 'invitationId'),
    roomRevision: requireNumber(payload, 'roomRevision'),
  };
}

/**
 * Parses a grant impact STRICTLY.
 *
 * A count without its paths, or a missing confirmation phrase, would render a
 * confident "this affects N documents" that the apply path might not honour.
 * That is the false-confirmation failure the preview exists to prevent, so an
 * inconsistent payload surfaces as unavailable instead of as reassurance.
 */
function parseGrantImpact(payload: unknown): GrantImpact {
  if (!isRecord(payload)) throw new ApiError('unavailable');
  const action = payload['action'];
  if (action !== 'grant' && action !== 'revoke' && action !== 'expiry')
    throw new ApiError('unavailable');
  const rawPaths = payload['paths'];
  if (!Array.isArray(rawPaths) || !rawPaths.every((value) => typeof value === 'string'))
    throw new ApiError('unavailable');
  const expires = payload['resolvedExpiresAt'];
  if (expires !== null && typeof expires !== 'string') throw new ApiError('unavailable');
  const revision = payload['roomRevision'];
  if (revision !== undefined && typeof revision !== 'number') throw new ApiError('unavailable');
  return {
    grantId: requireString(payload, 'grantId'),
    action,
    affectedCount: requireNumber(payload, 'affectedCount'),
    paths: rawPaths,
    confirmation: requireString(payload, 'confirmation'),
    message: requireString(payload, 'message'),
    resolvedExpiresAt: expires,
    ...(revision === undefined ? {} : { roomRevision: revision }),
  };
}

export async function dryRunGrantChange(input: GrantChangeRequest): Promise<GrantImpact> {
  return parseGrantImpact(
    await json({ method: 'POST', path: '/api/grants', body: { action: 'dry-run', ...input } }),
  );
}

/**
 * Applies a grant change. `grantId` and `confirmation` MUST be the values the
 * dry-run returned: the server re-runs the impact and compares both, so a caller
 * that skipped the preview cannot guess them.
 */
export async function applyGrantChange(
  input: GrantChangeRequest & {
    readonly grantId: string;
    readonly expectedRoomRevision: number;
    readonly confirmation: string;
  },
): Promise<GrantImpact> {
  return parseGrantImpact(
    await json({ method: 'POST', path: '/api/grants', body: { action: 'apply', ...input } }),
  );
}
