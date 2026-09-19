import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { inviteViewer } from '../declaration.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
export const schema = {
  body: Type.Object(
    {
      roomId: ID,
      email: Type.String({ minLength: 3, maxLength: 320 }),
      expectedRoomRevision: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
  response: {
    201: Type.Object(
      {
        invitationId: ID,
        expiresAt: Type.String({ format: 'date-time' }),
        roomRevision: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
};
interface Body {
  readonly roomId: string;
  readonly email: string;
  readonly expectedRoomRevision: number;
}
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Body;
    const invited = await inviteViewer({ pool: runtime.pool, identity, ...body });
    reply.code(201);
    return { ...invited, expiresAt: invited.expiresAt.toISOString() };
  };
}
export function handler(): never {
  throw new Error('participant invite route runtime not initialized');
}
