/**
 * Room settings, visibility, download policy, default expiry, and counterparties.
 *
 * Thin wrappers. Authority, validation, freshness and audit are decided by the
 * `SECURITY DEFINER` functions; a wrapper throws only when a function that must return
 * a row returned none.
 */
import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';

export type DownloadPolicy = 'allow' | 'deny';
export type RoomState = 'draft' | 'published' | 'archived';
export type PurgeState = 'scheduled' | 'marker_pending' | 'purging' | 'purged' | 'failed';

export interface RoomCapabilities {
  readonly publish: boolean;
  readonly archive: boolean;
  readonly returnToDraft: boolean;
  readonly setRetention: boolean;
  readonly schedulePurge: boolean;
  readonly cancelPurge: boolean;
}

export interface RoomSettings {
  readonly roomId: string;
  readonly state: RoomState;
  readonly revision: number;
  readonly publishedRevision: number;
  readonly auditRetentionYears: number;
  readonly defaultGrantExpiresAt: string | null;
  /** Null when the room inherits `installationDownloadPolicy`. */
  readonly downloadPolicy: DownloadPolicy | null;
  readonly installationDownloadPolicy: DownloadPolicy;
  readonly purge: {
    readonly purgeId: string;
    readonly state: PurgeState;
    readonly purgeAfter: string;
  } | null;
  readonly capabilities: RoomCapabilities;
}

export interface DownloadOverride {
  readonly documentId: string;
  readonly policy: DownloadPolicy;
}

export interface RoomSettingsRead {
  readonly settings: RoomSettings;
  readonly downloadOverrides: readonly DownloadOverride[];
}

interface SettingsRow {
  readonly room_id: string;
  readonly state: RoomState;
  readonly revision: number;
  readonly published_revision: number;
  readonly audit_retention_years: number;
  readonly default_grant_expires_at: Date | null;
  readonly download_policy: DownloadPolicy | null;
  readonly installation_download_policy: DownloadPolicy;
  readonly purge_id: string | null;
  readonly purge_state: PurgeState | null;
  readonly purge_after: Date | null;
  readonly capabilities: RoomCapabilities;
}

export async function readRoomSettings(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
}): Promise<RoomSettingsRead> {
  const parameters = [input.identity.id, input.roomId];
  const row = (
    await input.pool.query<SettingsRow>('SELECT * FROM read_room_settings($1,$2)', parameters)
  ).rows[0];
  if (row === undefined) throw new Error('ROOM_SETTINGS_UNAVAILABLE');
  const overrides = await input.pool.query<{
    document_id: string;
    download_policy: DownloadPolicy;
  }>('SELECT * FROM read_room_download_overrides($1,$2)', parameters);
  return {
    settings: {
      roomId: row.room_id,
      state: row.state,
      revision: row.revision,
      publishedRevision: row.published_revision,
      auditRetentionYears: row.audit_retention_years,
      defaultGrantExpiresAt: row.default_grant_expires_at?.toISOString() ?? null,
      downloadPolicy: row.download_policy,
      installationDownloadPolicy: row.installation_download_policy,
      purge:
        row.purge_id === null || row.purge_state === null || row.purge_after === null
          ? null
          : {
              purgeId: row.purge_id,
              state: row.purge_state,
              purgeAfter: row.purge_after.toISOString(),
            },
      capabilities: row.capabilities,
    },
    downloadOverrides: overrides.rows.map((override) => ({
      documentId: override.document_id,
      policy: override.download_policy,
    })),
  };
}

export type ReviewedVisibility = 'published' | 'archived';

export interface VisibilityImpact {
  readonly roomId: string;
  readonly currentState: RoomState;
  readonly proposedState: ReviewedVisibility;
  readonly viewerCount: number;
  readonly publishedDocumentCount: number;
  readonly requiresFreshAuthentication: boolean;
  readonly expectedRevision: number;
  readonly confirmation: string;
}

export async function dryRunRoomVisibility(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly state: ReviewedVisibility;
}): Promise<VisibilityImpact> {
  const impact = (
    await input.pool.query<{ impact: VisibilityImpact }>(
      'SELECT dry_run_room_visibility($1,$2,$3) AS impact',
      [input.identity.id, input.roomId, input.state],
    )
  ).rows[0]?.impact;
  if (impact === undefined) throw new Error('VISIBILITY_IMPACT_UNAVAILABLE');
  return impact;
}

/**
 * A reviewed change carries the phrase it was reviewed under; the kill switch has no field
 * for one. Typed as a union so a caller cannot assemble the pairing SQL then refuses.
 */
export type VisibilityChange =
  | { readonly state: ReviewedVisibility; readonly confirmation: string }
  | { readonly state: 'draft' };

export async function applyRoomVisibility(
  input: {
    readonly pool: Pool;
    readonly identity: MemberIdentity;
    readonly roomId: string;
    readonly expectedRevision: number;
  } & VisibilityChange,
): Promise<{ readonly revision: number }> {
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT apply_room_visibility($1,$2,$3,$4,$5,$6,$7,$8) AS revision',
      [
        input.identity.id,
        input.roomId,
        input.state,
        input.expectedRevision,
        input.identity.oidcAuthenticatedAt ?? null,
        input.state === 'draft' ? null : input.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('VISIBILITY_CHANGE_UNAVAILABLE');
  return { revision };
}

export interface DefaultExpiryImpact {
  readonly affectedCount: number;
  readonly paths: readonly string[];
  readonly resolvedExpiresAt: string | null;
  readonly confirmation: string;
  readonly message: string;
  readonly roomRevision?: number;
}

export async function setRoomDownloadPolicy(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly policy: DownloadPolicy | null;
  readonly expectedRoomRevision: number;
}): Promise<{ readonly roomRevision: number }> {
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT set_room_download_policy($1,$2,$3,$4,$5,$6) AS revision',
      [
        input.identity.id,
        input.roomId,
        input.policy,
        input.expectedRoomRevision,
        createOpaqueId(),
        createCorrelationId(),
      ],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('ROOM_POLICY_UNAVAILABLE');
  return { roomRevision: revision };
}

export async function setDocumentDownloadPolicy(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly documentId: string;
  readonly policy: DownloadPolicy | null;
  readonly expectedDocumentRevision: number;
}): Promise<{ readonly documentRevision: number }> {
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT set_document_download_policy($1,$2,$3,$4,$5,$6) AS revision',
      [
        input.identity.id,
        input.documentId,
        input.policy,
        input.expectedDocumentRevision,
        createOpaqueId(),
        createCorrelationId(),
      ],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('DOCUMENT_POLICY_UNAVAILABLE');
  return { documentRevision: revision };
}

export async function dryRunDefaultExpiry(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly expiresAt: Date | null;
}): Promise<DefaultExpiryImpact> {
  const impact = (
    await input.pool.query<{ impact: DefaultExpiryImpact }>(
      'SELECT dry_run_room_default_expiry($1,$2,$3) AS impact',
      [input.identity.id, input.roomId, input.expiresAt],
    )
  ).rows[0]?.impact;
  if (impact === undefined) throw new Error('EXPIRY_IMPACT_UNAVAILABLE');
  return impact;
}

export async function applyDefaultExpiry(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly expiresAt: Date | null;
  readonly expectedRoomRevision: number;
  readonly confirmation: string;
}): Promise<DefaultExpiryImpact> {
  const impact = (
    await input.pool.query<{ impact: DefaultExpiryImpact }>(
      'SELECT apply_room_default_expiry($1,$2,$3,$4,$5,$6,$7) AS impact',
      [
        input.identity.id,
        input.roomId,
        input.expiresAt,
        input.expectedRoomRevision,
        input.confirmation,
        createOpaqueId(),
        createCorrelationId(),
      ],
    )
  ).rows[0]?.impact;
  if (impact === undefined) throw new Error('EXPIRY_CHANGE_UNAVAILABLE');
  return impact;
}

export interface Counterparty {
  readonly counterpartyId: string;
  readonly name: string;
  readonly revision: number;
  readonly viewerCount: number;
}

/**
 * `Queryable` rather than `Pool`, so a caller reading counterparties alongside another
 * reader can pass the client both run on and get ONE snapshot. Two autocommit reads would
 * each see a different committed state, and a placement landing between them would answer a
 * roster and a viewer count that disagree.
 */
export type Queryable = Pick<Pool, 'query'>;

export async function readRoomCounterparties(input: {
  readonly pool: Queryable;
  readonly identity: MemberIdentity;
  readonly roomId: string;
}): Promise<readonly Counterparty[]> {
  const result = await input.pool.query<{
    counterparty_id: string;
    name: string;
    revision: number;
    viewer_count: number;
  }>('SELECT * FROM read_room_counterparties($1,$2)', [input.identity.id, input.roomId]);
  return result.rows.map((row) => ({
    counterpartyId: row.counterparty_id,
    name: row.name,
    revision: row.revision,
    viewerCount: row.viewer_count,
  }));
}

export async function createCounterparty(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly name: string;
  readonly expectedRoomRevision: number;
}): Promise<{ readonly counterpartyId: string; readonly roomRevision: number }> {
  const counterpartyId = createOpaqueId();
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT create_counterparty($1,$2,$3,$4,$5,$6,$7) AS revision',
      [
        counterpartyId,
        input.roomId,
        input.name,
        input.identity.id,
        input.expectedRoomRevision,
        createOpaqueId(),
        createCorrelationId(),
      ],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('COUNTERPARTY_UNAVAILABLE');
  return { counterpartyId, roomRevision: revision };
}

export async function placeViewer(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly counterpartyId: string;
  readonly viewerId: string;
  readonly expectedRoomRevision: number;
}): Promise<{ readonly roomRevision: number }> {
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT assign_viewer_counterparty($1,$2,$3,$4,$5,$6,$7,$8) AS revision',
      [
        createOpaqueId(),
        input.counterpartyId,
        input.viewerId,
        input.roomId,
        input.identity.id,
        input.expectedRoomRevision,
        createOpaqueId(),
        createCorrelationId(),
      ],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('PLACEMENT_UNAVAILABLE');
  return { roomRevision: revision };
}

export async function removeViewerFromCounterparty(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly viewerId: string;
  readonly expectedRoomRevision: number;
}): Promise<{ readonly roomRevision: number }> {
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT remove_viewer_counterparty($1,$2,$3,$4,$5,$6) AS revision',
      [
        input.identity.id,
        input.roomId,
        input.viewerId,
        input.expectedRoomRevision,
        createOpaqueId(),
        createCorrelationId(),
      ],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('PLACEMENT_UNAVAILABLE');
  return { roomRevision: revision };
}
