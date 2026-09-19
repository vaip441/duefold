import type { Kysely, Transaction } from 'kysely';
import { createOpaqueId } from '@duefold/shared/ids';
import type { CorrelationId } from '@duefold/shared/ids';
import type { SecurityDatabase } from './db/schema.ts';

export const SECURITY_EVENT_TYPES = [
  'auth.oidc',
  'auth.otp',
  'invitation.created',
  'session.revoked',
  'ownership.transferred',
  'recovery.owner',
  'upload.intent',
  'upload.finalized',
  'upload.expired',
  'upload.completing',
  'upload.failed',
  'document.validation',
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];
export interface AuditInput {
  readonly eventType: SecurityEventType;
  readonly actorKind: 'member' | 'viewer' | 'system' | 'operator';
  readonly actorId?: string;
  readonly subjectId?: string;
  readonly roomId?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly result: 'success' | 'denied' | 'failure';
  readonly reasonCode: string;
  readonly correlationId: CorrelationId;
  readonly detail?: Readonly<Record<string, unknown>>;
}
export async function appendAudit(
  transaction: Transaction<SecurityDatabase>,
  input: AuditInput,
): Promise<void> {
  await transaction
    .insertInto('audit_event')
    .values({
      id: createOpaqueId(),
      event_type: input.eventType,
      actor_kind: input.actorKind,
      actor_id: input.actorId ?? null,
      subject_id: input.subjectId ?? null,
      room_id: input.roomId ?? null,
      resource_type: input.resourceType ?? null,
      resource_id: input.resourceId ?? null,
      result: input.result,
      reason_code: input.reasonCode,
      correlation_id: input.correlationId,
      detail: input.detail ?? {},
    })
    .executeTakeFirstOrThrow();
}
/** Security mutation and audit are inseparable: either callback and event commit, or both roll back. */
export async function auditedMutation<T>(
  database: Kysely<SecurityDatabase>,
  audit: AuditInput,
  mutation: (transaction: Transaction<SecurityDatabase>) => Promise<T>,
): Promise<T> {
  return database.transaction().execute(async (transaction) => {
    const value = await mutation(transaction);
    await appendAudit(transaction, audit);
    return value;
  });
}
export async function queryAudit(
  database: Kysely<SecurityDatabase>,
  scope:
    | { readonly installation: true }
    | { readonly roomId: string }
    | { readonly actorId: string },
  limit = 100,
): Promise<readonly unknown[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error('invalid audit page limit');
  let query = database.selectFrom('audit_event').selectAll();
  if ('roomId' in scope) query = query.where('room_id', '=', scope.roomId);
  if ('actorId' in scope) query = query.where('actor_id', '=', scope.actorId);
  return query.orderBy('sequence', 'desc').limit(limit).execute();
}
