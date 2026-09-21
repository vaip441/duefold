/**
 * Room seeding for the room-administration suites, through the same audited functions
 * the product calls. Pools, sessions and the app come from `route-fixture.ts`.
 *
 * The organization and its Owner are inserted in ONE transaction, because
 * `exactly_one_owner_after_member` is a deferred trigger that requires exactly one
 * active Owner whenever an organization exists.
 */
import type { Pool, PoolClient } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import { generatedMigrations } from '../../../.duefold/generated/migrations.ts';
import { migrate } from '../../../modules/core-security/src/db/migrate.ts';
import { bootstrapPool, databasePool, migrationPool } from './route-fixture.ts';

async function insertMember(
  client: Pool | PoolClient,
  role: 'owner' | 'admin' | 'member',
  label: string,
): Promise<string> {
  const id = createOpaqueId();
  await client.query(
    `INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
     VALUES ($1,$2,$2,'https://issuer.example',$1,$3,'active')`,
    [id, `${label}@example.test`, role],
  );
  return id;
}

/** Drops and migrates the schema, inserts the organization and its Owner, returns the Owner's id. */
export async function resetRoomSchema(organizationName: string): Promise<string> {
  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  const client = await migrationPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO organization (id,name) VALUES ($1,$2)', [
      createOpaqueId(),
      organizationName,
    ]);
    const ownerId = await insertMember(client, 'owner', 'fixture.owner');
    await client.query('COMMIT');
    return ownerId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function seedMember(role: 'admin' | 'member', label: string): Promise<string> {
  return insertMember(migrationPool, role, label);
}

export async function seedRoom(actorId: string, title: string): Promise<string> {
  const roomId = createOpaqueId();
  await databasePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
    roomId,
    title,
    '',
    actorId,
    createOpaqueId(),
    createCorrelationId(),
  ]);
  return roomId;
}

export async function staffRoom(
  memberId: string,
  roomId: string,
  role: 'manager' | 'contributor',
  actorId: string,
): Promise<void> {
  await databasePool.query('SELECT apply_room_assignments($1,$2::jsonb,$3::jsonb,$4,$5,$6)', [
    memberId,
    JSON.stringify([{ roomId, roomRole: role }]),
    '[]',
    actorId,
    createOpaqueId(),
    createCorrelationId(),
  ]);
}

export async function roomRevision(roomId: string): Promise<number> {
  const revision = (
    await migrationPool.query<{ revision: number }>('SELECT revision FROM room WHERE id=$1', [
      roomId,
    ])
  ).rows[0]?.revision;
  if (revision === undefined) throw new Error('room missing');
  return revision;
}

/** An active viewer in the room holding an active whole-room grant. Returns the viewer id. */
export async function seedViewerWithRoomGrant(
  roomId: string,
  actorId: string,
  label: string,
): Promise<string> {
  const viewerId = createOpaqueId();
  await migrationPool.query(
    'INSERT INTO viewer (id,email_key,email_display,session_family_id) VALUES ($1,$2,$2,$3)',
    [viewerId, `${label}@example.test`, createOpaqueId()],
  );
  await databasePool.query('SELECT add_viewer_to_room($1,$2,$3,$4,$5,$6,$7)', [
    createOpaqueId(),
    viewerId,
    roomId,
    actorId,
    await roomRevision(roomId),
    createOpaqueId(),
    createCorrelationId(),
  ]);
  const grantId = createOpaqueId();
  const shape = [
    actorId,
    roomId,
    'grant',
    grantId,
    'viewer',
    viewerId,
    null,
    'room',
    null,
    null,
    null,
  ];
  const impact = (
    await databasePool.query<{ impact: { confirmation: string } }>(
      'SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS impact',
      shape,
    )
  ).rows[0]?.impact;
  if (impact === undefined) throw new Error('grant preview missing');
  await databasePool.query(
    'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
    [
      ...shape,
      await roomRevision(roomId),
      new Date(),
      impact.confirmation,
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  return viewerId;
}
