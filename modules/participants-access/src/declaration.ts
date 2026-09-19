/**
 * `participants-access` module declaration.
 *
 * Owns counterparties, invitations, grants, expiry, revocation, and the
 * effective-permission preview.
 */

import type { ModuleDeclaration } from '@duefold/composition/contract';
import { normalizeEmail } from '@duefold/shared/email';
import type { Pool } from 'pg';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';

export async function inviteViewer(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly email: string;
  readonly expectedRoomRevision: number;
}): Promise<{
  readonly invitationId: string;
  readonly expiresAt: Date;
  readonly roomRevision: number;
}> {
  const normalized = normalizeEmail(input.email);
  const invitationId = createOpaqueId();
  const viewerId = createOpaqueId();
  const membershipId = createOpaqueId();
  const result = await input.pool.query<{
    invitation_id: string;
    viewer_id: string;
    expires_at: Date;
    room_revision: number;
  }>('SELECT * FROM create_viewer_invitation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
    invitationId,
    viewerId,
    membershipId,
    normalized.comparisonKey,
    normalized.display,
    input.roomId,
    input.identity.id,
    input.expectedRoomRevision,
    createOpaqueId(),
    createOpaqueId(),
    createCorrelationId(),
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('VIEWER_INVITATION_FAILED');
  return {
    invitationId: row.invitation_id,
    expiresAt: row.expires_at,
    roomRevision: row.room_revision,
  };
}

export const moduleDeclaration: ModuleDeclaration = {
  id: 'participants-access',
  packageName: '@duefold/participants-access',
  requires: ['core-security', 'rooms-documents'],
  routes: [
    {
      id: 'participant.list',
      method: 'GET',
      path: '/api/participants',
      audience: 'member',
      handler: 'routes/participant-list.ts',
      handlerFactoryExport: 'createHandler',
    },
    {
      id: 'participant.invite',
      method: 'POST',
      path: '/api/participants/invitations',
      audience: 'member',
      handler: 'routes/participant-invite.ts',
      handlerFactoryExport: 'createHandler',
    },
    {
      id: 'grant.change',
      method: 'POST',
      path: '/api/grants',
      audience: 'member',
      handler: 'routes/grant-change.ts',
      handlerFactoryExport: 'createHandler',
    },
  ],
  migrations: [
    { id: '007_participant_grants', file: '007_participant_grants.sql' },
    { id: '013_participant_routes', file: '013_participant_routes.sql' },
  ],
  jobs: [],
  config: [],
  browserEntries: [],
};
