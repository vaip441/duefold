import type { Pool } from 'pg';
import { normalizeEmail } from '@duefold/shared/email';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';

/** Guarded CLI calls this only after backup acknowledgement and typed confirmation. */
export async function recoverOwner(
  pool: Pool,
  email: string,
): Promise<{ readonly targetId: string }> {
  const normalized = normalizeEmail(email);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query<{ id: string }>(
      "SELECT id FROM member WHERE email_key = $1 AND state = 'active' FOR UPDATE",
      [normalized.comparisonKey],
    );
    const targetId = target.rows[0]?.id;
    if (targetId === undefined) throw new Error('exact active member not found');
    await client.query(
      "UPDATE session SET state = 'revoked' WHERE state = 'active' AND member_id IN (SELECT id FROM member WHERE global_role = 'owner' OR id = $1)",
      [targetId],
    );
    await client.query(
      "UPDATE member SET global_role = 'member', revision = revision + 1 WHERE global_role = 'owner' AND state = 'active'",
    );
    await client.query(
      "UPDATE member SET global_role = 'owner', revision = revision + 1 WHERE id = $1",
      [targetId],
    );
    await client.query(
      "INSERT INTO audit_event (id,event_type,actor_kind,subject_id,result,reason_code,correlation_id,detail) VALUES ($1,'recovery.owner','operator',$2,'success','CLI_RECOVERY',$3,jsonb_build_object('backup_acknowledged',true))",
      [createOpaqueId(), targetId, createCorrelationId()],
    );
    await client.query('COMMIT');
    return { targetId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
