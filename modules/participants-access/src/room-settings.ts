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
