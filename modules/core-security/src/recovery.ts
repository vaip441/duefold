import type { Pool } from 'pg';
import { normalizeEmail } from '@duefold/shared/email';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';

/** Guarded CLI calls this only after backup acknowledgement and typed confirmation.
 * Sessions of both members are revoked by the member_privilege_session_revoke trigger. */
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
    const correlationId = createCorrelationId();
    await client.query(
      "UPDATE member SET global_role = 'member', revision = revision + 1 WHERE global_role = 'owner' AND state = 'active'",
    );
    await client.query(
      "UPDATE member SET global_role = 'owner', revision = revision + 1 WHERE id = $1",
      [targetId],
    );
    // Mirrors supersede_room_assignments_for_role, attributed to the operator rather than a member.
    await client.query(
      `WITH revoked AS (
         UPDATE room_assignment SET state = 'revoked' WHERE member_id = $1 AND state = 'active'
         RETURNING room_id, room_role
       )
       INSERT INTO audit_event (id,event_type,actor_kind,subject_id,resource_type,resource_id,result,reason_code,correlation_id,detail)
       SELECT $2,'room.assignment','operator',$1,'member',$1,'success','ROOM_ASSIGNMENTS_SUPERSEDED',$3,
         jsonb_build_object('revoked',
           jsonb_agg(jsonb_build_object('roomId',room_id,'roomRole',room_role) ORDER BY room_id),
           'reason','global_role','toRole','owner')
       FROM revoked HAVING count(*) > 0`,
      [targetId, createOpaqueId(), correlationId],
    );
    await client.query(
      "INSERT INTO audit_event (id,event_type,actor_kind,subject_id,result,reason_code,correlation_id,detail) VALUES ($1,'recovery.owner','operator',$2,'success','CLI_RECOVERY',$3,jsonb_build_object('backup_acknowledged',true))",
      [createOpaqueId(), targetId, correlationId],
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
