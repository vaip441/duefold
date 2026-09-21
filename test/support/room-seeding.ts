/**
 * Room facts a browser journey starts from, seeded through the migration role. A journey
 * seeds where it begins and makes every change it asserts through the product.
 */
import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';

/** The room's structure has been published once, so the room may be made visible. */
export async function markStructurePublished(pool: Pool, roomId: string): Promise<void> {
  await pool.query('UPDATE room SET published_revision=published_revision+1 WHERE id=$1', [
    roomId,
  ]);
}

export async function archiveRoom(pool: Pool, roomId: string): Promise<void> {
  await pool.query("UPDATE room SET state='archived',revision=revision+1 WHERE id=$1", [
    roomId,
  ]);
}

/** A document entry in the working structure, created as `actorId` through the audited function. */
export async function addDocument(
  pool: Pool,
  roomId: string,
  actorId: string,
  title: string,
): Promise<string> {
  const working = (
    await pool.query<{ working_revision: number }>(
      'SELECT working_revision FROM room WHERE id=$1',
      [roomId],
    )
  ).rows[0]?.working_revision;
  if (working === undefined) throw new Error('room missing');
  const documentId = createOpaqueId();
  await pool.query(
    'INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,$3,$4)',
    [documentId, roomId, title, actorId],
  );
  await pool.query('SELECT create_document_entry($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
    createOpaqueId(),
    documentId,
    null,
    title,
    1,
    actorId,
    working,
    createOpaqueId(),
    createCorrelationId(),
  ]);
  return documentId;
}

/** Moves the member's OIDC authentication timestamp past the 15-minute freshness window. */
export async function makeSessionStale(pool: Pool, memberId: string): Promise<void> {
  await pool.query(
    "UPDATE session SET oidc_authenticated_at = transaction_timestamp() - interval '20 minutes' WHERE member_id = $1",
    [memberId],
  );
}
