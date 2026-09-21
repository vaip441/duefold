/**
 * The installation-wide download default. Thin wrappers: authority, freshness, the phrase and
 * the audit row are the `SECURITY DEFINER` functions'.
 */
import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';
import type { DownloadPolicy } from './room-settings.ts';

export interface InstallationSettings {
  readonly downloadPolicy: DownloadPolicy;
  readonly revision: number;
  readonly inheritingRoomCount: number;
}

export interface InstallationDownloadImpact {
  readonly currentPolicy: DownloadPolicy;
  readonly proposedPolicy: DownloadPolicy;
  readonly inheritingRoomCount: number;
  readonly affectedDocumentCount: number;
  readonly requiresFreshAuthentication: boolean;
  readonly expectedRevision: number;
  /** The phrase allowing needs; null when denying, which takes none. */
  readonly confirmation: string | null;
}

/** Allowing carries the phrase it was reviewed under; denying has no field for one. */
export type InstallationDownloadChange =
  | {
      readonly policy: 'allow';
      readonly expectedRevision: number;
      readonly confirmation: string;
    }
  | { readonly policy: 'deny'; readonly expectedRevision: number };

export async function readInstallationSettings(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
}): Promise<InstallationSettings> {
  const row = (
    await input.pool.query<{
      download_policy: DownloadPolicy;
      policy_revision: number;
      inheriting_room_count: number;
    }>('SELECT * FROM read_installation_settings($1)', [input.identity.id])
  ).rows[0];
  if (row === undefined) throw new Error('INSTALLATION_SETTINGS_UNAVAILABLE');
  return {
    downloadPolicy: row.download_policy,
    revision: row.policy_revision,
    inheritingRoomCount: row.inheriting_room_count,
  };
}

export async function dryRunInstallationDownloadPolicy(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly policy: DownloadPolicy;
}): Promise<InstallationDownloadImpact> {
  const impact = (
    await input.pool.query<{ impact: InstallationDownloadImpact }>(
      'SELECT dry_run_installation_download_policy($1,$2) AS impact',
      [input.identity.id, input.policy],
    )
  ).rows[0]?.impact;
  if (impact === undefined) throw new Error('INSTALLATION_DOWNLOAD_IMPACT_UNAVAILABLE');
  return impact;
}

export async function applyInstallationDownloadPolicy(
  input: {
    readonly pool: Pool;
    readonly identity: MemberIdentity;
  } & InstallationDownloadChange,
): Promise<{ readonly revision: number }> {
  const revision = (
    await input.pool.query<{ revision: number }>(
      'SELECT apply_installation_download_policy($1,$2,$3,$4,$5,$6,$7) AS revision',
      [
        input.identity.id,
        input.policy,
        input.expectedRevision,
        input.identity.oidcAuthenticatedAt ?? null,
        input.policy === 'allow' ? input.confirmation : null,
        createOpaqueId(),
        createCorrelationId(),
      ],
    )
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('INSTALLATION_DOWNLOAD_CHANGE_UNAVAILABLE');
  return { revision };
}
