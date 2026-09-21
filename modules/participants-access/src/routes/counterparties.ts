import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import {
  createCounterparty,
  placeViewer,
  removeViewerFromCounterparty,
} from '../room-settings.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const REVISION = Type.Integer({ minimum: 1 });

export const schema = {
  body: Type.Union([
    Type.Object(
      {
        action: Type.Literal('create'),
        roomId: ID,
        /* At least one visible character; the database owns every other name rule. */
        name: Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' }),
        expectedRoomRevision: REVISION,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('assign-viewer'),
        roomId: ID,
        counterpartyId: ID,
        viewerId: ID,
        expectedRoomRevision: REVISION,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('remove-viewer'),
        roomId: ID,
        viewerId: ID,
        expectedRoomRevision: REVISION,
      },
      { additionalProperties: false },
    ),
  ]),
  response: {
    200: Type.Object({ roomRevision: REVISION }, { additionalProperties: false }),
    201: Type.Object(
      { counterpartyId: ID, roomRevision: REVISION },
      { additionalProperties: false },
    ),
  },
};

type Body =
  | {
      readonly action: 'create';
      readonly roomId: string;
      readonly name: string;
      readonly expectedRoomRevision: number;
    }
  | {
      readonly action: 'assign-viewer';
      readonly roomId: string;
      readonly counterpartyId: string;
      readonly viewerId: string;
      readonly expectedRoomRevision: number;
    }
  | {
      readonly action: 'remove-viewer';
      readonly roomId: string;
      readonly viewerId: string;
      readonly expectedRoomRevision: number;
    };

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Body;
    const pool = runtime.pool;
    if (body.action === 'create') {
      const created = await createCounterparty({ pool, identity, ...body });
      reply.code(201);
      return created;
    }
    if (body.action === 'assign-viewer') return placeViewer({ pool, identity, ...body });
    return removeViewerFromCounterparty({ pool, identity, ...body });
  };
}

export function handler(): never {
  throw new Error('counterparty route runtime not initialized');
}
