import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { readRoomCounterparties } from '../room-settings.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const GRANT = Type.Object(
  {
    grantId: ID,
    source: Type.Union([Type.Literal('direct'), Type.Literal('counterparty')]),
    targetKind: Type.Union([
      Type.Literal('room'),
      Type.Literal('folder'),
      Type.Literal('document'),
    ]),
    folderId: Type.Union([ID, Type.Null()]),
    documentId: Type.Union([ID, Type.Null()]),
    expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    effective: Type.Boolean(),
    revision: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const schema = {
  querystring: Type.Object({ roomId: ID }, { additionalProperties: false }),
  response: {
    200: Type.Object(
      {
        participants: Type.Array(
          Type.Object(
            {
              viewerId: ID,
              email: Type.String({ minLength: 3, maxLength: 320 }),
              membershipState: Type.Union([Type.Literal('active'), Type.Literal('revoked')]),
              membershipRevision: Type.Integer({ minimum: 1 }),
              counterpartyId: Type.Union([ID, Type.Null()]),
              counterpartyName: Type.Union([
                Type.String({ minLength: 1, maxLength: 200 }),
                Type.Null(),
              ]),
              grants: Type.Array(GRANT),
            },
            { additionalProperties: false },
          ),
        ),
        counterparties: Type.Array(
          Type.Object(
            {
              counterpartyId: ID,
              name: Type.String({ minLength: 1, maxLength: 200 }),
              revision: Type.Integer({ minimum: 1 }),
              viewerCount: Type.Integer({ minimum: 0 }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
};

interface GrantRow {
  readonly grantId: string;
  readonly source: 'direct' | 'counterparty';
  readonly targetKind: 'room' | 'folder' | 'document';
  readonly folderId: string | null;
  readonly documentId: string | null;
  readonly expiresAt: string | null;
  readonly effective: boolean;
  readonly revision: number;
}
interface ParticipantRow {
  readonly viewer_id: string;
  readonly email_display: string;
  readonly membership_state: 'active' | 'revoked';
  readonly membership_revision: number;
  readonly counterparty_id: string | null;
  readonly counterparty_name: string | null;
  readonly grants: readonly GrantRow[];
}

/**
 * The roster and its counterparties are two readers, so they run in ONE read-only repeatable
 * read transaction. Read separately, a placement committing between them would answer a
 * participant whose counterparty is missing from the list, or a viewer count that does not
 * match the participants shown beside it.
 */
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const { roomId } = request.query as { readonly roomId: string };
    const client = await runtime.pool.connect();
    let result;
    let counterparties;
    try {
      await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
      result = await client.query<ParticipantRow>(
        'SELECT * FROM read_room_participants($1,$2)',
        [identity.id, roomId],
      );
      counterparties = await readRoomCounterparties({ pool: client, identity, roomId });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return {
      participants: result.rows.map((row) => ({
        viewerId: row.viewer_id,
        email: row.email_display,
        membershipState: row.membership_state,
        membershipRevision: row.membership_revision,
        counterpartyId: row.counterparty_id,
        counterpartyName: row.counterparty_name,
        grants: row.grants,
      })),
      counterparties,
    };
  };
}
export function handler(): never {
  throw new Error('participant list route runtime not initialized');
}
