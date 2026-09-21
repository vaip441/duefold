import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import {
  applyRoomVisibility,
  dryRunRoomVisibility,
  type ReviewedVisibility,
} from '../room-settings.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const STATE = Type.Union([
  Type.Literal('draft'),
  Type.Literal('published'),
  Type.Literal('archived'),
]);
const REVIEWED = Type.Union([Type.Literal('published'), Type.Literal('archived')]);
const REVISION = Type.Integer({ minimum: 1 });

const IMPACT = Type.Object(
  {
    roomId: ID,
    currentState: STATE,
    proposedState: REVIEWED,
    viewerCount: Type.Integer({ minimum: 0 }),
    publishedDocumentCount: Type.Integer({ minimum: 0 }),
    requiresFreshAuthentication: Type.Boolean(),
    expectedRevision: REVISION,
    confirmation: Type.String(),
  },
  { additionalProperties: false },
);

/**
 * Room visibility. The body union carries the asymmetry: a reviewed change names its
 * phrase, and the kill switch has no field for one.
 *
 * The response is a union for the same reason. A review answers an impact and an apply
 * answers a revision; two optional fields would also admit an empty object and one carrying
 * both, neither of which any code path can produce.
 */
export const schema = {
  body: Type.Union([
    Type.Object(
      { action: Type.Literal('dry-run'), roomId: ID, state: REVIEWED },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('apply'),
        roomId: ID,
        state: REVIEWED,
        expectedRevision: REVISION,
        confirmation: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('apply'),
        roomId: ID,
        state: Type.Literal('draft'),
        expectedRevision: REVISION,
      },
      { additionalProperties: false },
    ),
  ]),
  response: {
    200: Type.Union([
      Type.Object({ impact: IMPACT }, { additionalProperties: false }),
      Type.Object({ revision: REVISION }, { additionalProperties: false }),
    ]),
  },
};

type Body =
  | { readonly action: 'dry-run'; readonly roomId: string; readonly state: ReviewedVisibility }
  | {
      readonly action: 'apply';
      readonly roomId: string;
      readonly state: ReviewedVisibility;
      readonly expectedRevision: number;
      readonly confirmation: string;
    }
  | {
      readonly action: 'apply';
      readonly roomId: string;
      readonly state: 'draft';
      readonly expectedRevision: number;
    };

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const body = request.body as Body;
    if (body.action === 'dry-run')
      return {
        impact: await dryRunRoomVisibility({
          pool: runtime.pool,
          identity,
          roomId: body.roomId,
          state: body.state,
        }),
      };
    const change = {
      pool: runtime.pool,
      identity,
      roomId: body.roomId,
      expectedRevision: body.expectedRevision,
    };
    return body.state === 'draft'
      ? applyRoomVisibility({ ...change, state: 'draft' })
      : applyRoomVisibility({ ...change, state: body.state, confirmation: body.confirmation });
  };
}

export function handler(): never {
  throw new Error('room visibility route runtime not initialized');
}
