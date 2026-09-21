import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { createRoom } from '../structure.ts';

/** Room creation. Owner/Admin authority and every text rule live in `create_room`. */
export const schema = {
  body: Type.Object(
    {
      title: Type.String({ minLength: 1, maxLength: 200 }),
      description: Type.String({ maxLength: 4000 }),
    },
    { additionalProperties: false },
  ),
  response: {
    201: Type.Object(
      { roomId: Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' }) },
      { additionalProperties: false },
    ),
  },
};

interface Body {
  readonly title: string;
  readonly description: string;
}

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Body;
    const created = await createRoom({ pool: runtime.pool, identity, ...body });
    reply.code(201);
    return created;
  };
}

export function handler(): never {
  throw new Error('room create route runtime not initialized');
}
