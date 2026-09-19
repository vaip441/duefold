import type { Pool } from 'pg';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';

export type GrantSource = 'direct' | 'counterparty';
export type GrantTargetKind = 'room' | 'folder' | 'document';
export type DownloadPolicy = 'allow' | 'deny';

export interface EffectivePermission {
  readonly grantId: string;
  readonly source: GrantSource;
  readonly targetKind: GrantTargetKind;
  readonly path: string;
  readonly expiresAt: string | null;
  readonly documentLevelException: boolean;
}

interface EffectivePermissionRow {
  readonly grant_id: string;
  readonly source: GrantSource;
  readonly target_kind: GrantTargetKind;
  readonly path: string;
  readonly expires_at: Date | null;
  readonly document_level_exception: boolean;
}

/** Manager-only explanation of the direct/counterparty union. */
export async function readEffectivePermissionPreview(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly viewerId: string;
  readonly roomId: string;
}): Promise<readonly EffectivePermission[]> {
  const result = await input.pool.query<EffectivePermissionRow>(
    'SELECT * FROM read_effective_permission_preview($1,$2,$3)',
    [input.identity.id, input.viewerId, input.roomId],
  );
  return result.rows.map((row) => ({
    grantId: row.grant_id,
    source: row.source,
    targetKind: row.target_kind,
    path: row.path,
    expiresAt: row.expires_at?.toISOString() ?? null,
    documentLevelException: row.document_level_exception,
  }));
}

/** Uniform document policy; the caller must separately authorize document access. */
export async function resolveDocumentDownloadPolicy(input: {
  readonly pool: Pool;
  readonly viewerId: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly documentId: string;
}): Promise<DownloadPolicy> {
  const result = await input.pool.query<{ policy: string | null }>(
    'SELECT policy FROM read_viewer_document_download_policy($1,$2,$3,$4)',
    [input.viewerId, input.sessionId, input.roomId, input.documentId],
  );
  const policy = result.rows[0]?.policy;
  if (policy !== 'allow' && policy !== 'deny') throw new Error('DOWNLOAD_POLICY_UNAVAILABLE');
  return policy;
}
