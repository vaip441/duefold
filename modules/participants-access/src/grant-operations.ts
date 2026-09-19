import type { Pool } from 'pg';
import { hasFreshOidc, type MemberIdentity } from '../../core-security/src/authorization.ts';
import type { GrantTargetKind } from './grant-model.ts';

export type GrantChangeAction = 'grant' | 'revoke' | 'expiry';
export type GranteeKind = 'viewer' | 'counterparty';

export interface GrantChangeInput {
  readonly action: GrantChangeAction;
  readonly grantId: string;
  readonly granteeKind: GranteeKind | null;
  readonly viewerId: string | null;
  readonly counterpartyId: string | null;
  readonly targetKind: GrantTargetKind | null;
  readonly folderId: string | null;
  readonly documentId: string | null;
  readonly expiresAt: Date | null;
}

export interface GrantImpact {
  readonly action: GrantChangeAction;
  readonly affectedCount: number;
  readonly paths: readonly string[];
  readonly confirmation: string;
  readonly message: string;
  readonly resolvedExpiresAt: string | null;
}

interface GrantImpactRow {
  readonly dry_run_grant_change?: GrantImpact;
  readonly apply_grant_change?: GrantImpact & { readonly roomRevision: number };
}

function values(identity: MemberIdentity, roomId: string, input: GrantChangeInput) {
  return [
    identity.id,
    roomId,
    input.action,
    input.grantId,
    input.granteeKind,
    input.viewerId,
    input.counterpartyId,
    input.targetKind,
    input.folderId,
    input.documentId,
    input.expiresAt,
  ];
}

export async function dryRunGrantChange(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly change: GrantChangeInput;
}): Promise<GrantImpact> {
  const result = await input.pool.query<GrantImpactRow>(
    'SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    values(input.identity, input.roomId, input.change),
  );
  const impact = result.rows[0]?.dry_run_grant_change;
  if (impact === undefined) throw new Error('GRANT_IMPACT_UNAVAILABLE');
  return impact;
}

export function isBroadGrantChange(change: GrantChangeInput): boolean {
  // Room grants expose the entire room. Counterparty grants affect a group even
  // when their current target is narrower. Revokes/expiry changes are resolved
  // authoritatively in SQL because the existing grant shape is not client input.
  return (
    change.action === 'grant' &&
    (change.targetKind === 'room' || change.granteeKind === 'counterparty')
  );
}

export async function applyGrantChange(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly change: GrantChangeInput;
  readonly expectedRoomRevision: number;
  readonly confirmation: string;
  readonly auditId: string;
  readonly correlationId: string;
  readonly now?: Date;
}): Promise<GrantImpact & { readonly roomRevision: number }> {
  const now = input.now ?? new Date();
  if (
    isBroadGrantChange(input.change) &&
    !hasFreshOidc(input.identity.oidcAuthenticatedAt, now)
  )
    throw new Error('FRESH_OIDC_REQUIRED');
  const result = await input.pool.query<GrantImpactRow>(
    'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
    [
      ...values(input.identity, input.roomId, input.change),
      input.expectedRoomRevision,
      input.identity.oidcAuthenticatedAt ?? null,
      input.confirmation,
      input.auditId,
      input.correlationId,
    ],
  );
  const impact = result.rows[0]?.apply_grant_change;
  if (impact === undefined) throw new Error('GRANT_CHANGE_UNAVAILABLE');
  return impact;
}
