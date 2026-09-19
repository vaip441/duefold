import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';

export interface RetentionImpact {
  readonly roomId: string;
  readonly currentYears: number;
  readonly proposedYears: number;
  readonly existingAuditRowsUnaffected: true;
  readonly confirmation: string;
  readonly revision?: number;
}
export interface PurgeImpact {
  readonly roomId: string;
  readonly documentCount: number;
  readonly viewerCount: number;
  readonly sourceBytes: number;
  readonly cancellationDays: 30;
  readonly confirmation: string;
  readonly purgeId?: string;
  readonly purgeAfter?: string;
}

export async function dryRunRetention(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly years: number;
}): Promise<RetentionImpact> {
  const row = await input.pool.query<{ impact: RetentionImpact }>(
    'SELECT dry_run_audit_retention($1,$2,$3) impact',
    [input.identity.id, input.roomId, input.years],
  );
  const impact = row.rows[0]?.impact;
  if (impact === undefined) throw new Error('RETENTION_IMPACT_UNAVAILABLE');
  return impact;
}

export async function applyRetention(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly years: number;
  readonly expectedRevision: number;
  readonly confirmation: string;
}): Promise<RetentionImpact> {
  const row = await input.pool.query<{ impact: RetentionImpact }>(
    'SELECT apply_audit_retention($1,$2,$3,$4,$5,$6,$7,$8) impact',
    [
      input.identity.id,
      input.roomId,
      input.years,
      input.identity.oidcAuthenticatedAt ?? null,
      input.expectedRevision,
      input.confirmation,
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  const impact = row.rows[0]?.impact;
  if (impact === undefined) throw new Error('RETENTION_CHANGE_UNAVAILABLE');
  return impact;
}

export async function dryRunRoomPurge(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
}): Promise<PurgeImpact> {
  const row = await input.pool.query<{ impact: PurgeImpact }>(
    'SELECT dry_run_room_purge($1,$2) impact',
    [input.identity.id, input.roomId],
  );
  const impact = row.rows[0]?.impact;
  if (impact === undefined) throw new Error('PURGE_IMPACT_UNAVAILABLE');
  return impact;
}

export async function scheduleRoomPurge(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly expectedRevision: number;
  readonly confirmation: string;
}): Promise<PurgeImpact> {
  const purgeId = createOpaqueId();
  const markerKey = `system/deletion-markers/v1/${input.roomId}/${purgeId}.json`;
  const row = await input.pool.query<{ impact: PurgeImpact }>(
    'SELECT schedule_room_purge($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) impact',
    [
      purgeId,
      input.identity.id,
      input.roomId,
      input.identity.oidcAuthenticatedAt ?? null,
      input.expectedRevision,
      input.confirmation,
      markerKey,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  const impact = row.rows[0]?.impact;
  if (impact === undefined) throw new Error('PURGE_SCHEDULE_UNAVAILABLE');
  return impact;
}

export async function cancelRoomPurge(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly purgeId: string;
  readonly confirmation: string;
}): Promise<void> {
  await input.pool.query('SELECT cancel_room_purge($1,$2,$3,$4,$5)', [
    input.purgeId,
    input.identity.id,
    input.confirmation,
    createOpaqueId(),
    createCorrelationId(),
  ]);
}
