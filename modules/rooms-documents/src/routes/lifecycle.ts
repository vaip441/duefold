import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import {
  applyRetention,
  cancelRoomPurge,
  dryRunRetention,
  dryRunRoomPurge,
  scheduleRoomPurge,
} from '../lifecycle.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const RETENTION_IMPACT = Type.Object(
  {
    roomId: ID,
    currentYears: Type.Integer(),
    proposedYears: Type.Integer(),
    existingAuditRowsUnaffected: Type.Literal(true),
    confirmation: Type.String(),
    revision: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);
const PURGE_IMPACT = Type.Object(
  {
    roomId: ID,
    documentCount: Type.Integer(),
    viewerCount: Type.Integer(),
    sourceBytes: Type.Integer(),
    cancellationDays: Type.Literal(30),
    confirmation: Type.String(),
    purgeId: Type.Optional(ID),
    purgeAfter: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { additionalProperties: false },
);
export const schema = {
  body: Type.Union([
    Type.Object(
      {
        action: Type.Literal('retention-dry-run'),
        roomId: ID,
        years: Type.Integer({ minimum: 1, maximum: 10 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('retention-apply'),
        roomId: ID,
        years: Type.Integer({ minimum: 1, maximum: 10 }),
        expectedRevision: Type.Integer({ minimum: 1 }),
        confirmation: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal('purge-dry-run'), roomId: ID },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('purge-schedule'),
        roomId: ID,
        expectedRevision: Type.Integer({ minimum: 1 }),
        confirmation: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('purge-cancel'),
        purgeId: ID,
        confirmation: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
  ]),
  response: {
    200: Type.Object(
      {
        retention: Type.Optional(RETENTION_IMPACT),
        purge: Type.Optional(PURGE_IMPACT),
        cancelled: Type.Optional(Type.Literal(true)),
      },
      { additionalProperties: false },
    ),
  },
};

type Body =
  | { readonly action: 'retention-dry-run'; readonly roomId: string; readonly years: number }
  | {
      readonly action: 'retention-apply';
      readonly roomId: string;
      readonly years: number;
      readonly expectedRevision: number;
      readonly confirmation: string;
    }
  | { readonly action: 'purge-dry-run'; readonly roomId: string }
  | {
      readonly action: 'purge-schedule';
      readonly roomId: string;
      readonly expectedRevision: number;
      readonly confirmation: string;
    }
  | {
      readonly action: 'purge-cancel';
      readonly purgeId: string;
      readonly confirmation: string;
    };

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const body = request.body as Body;
    if (body.action === 'retention-dry-run')
      return {
        retention: await dryRunRetention({
          pool: runtime.pool,
          identity,
          roomId: body.roomId,
          years: body.years,
        }),
      };
    if (body.action === 'retention-apply')
      return {
        retention: await applyRetention({
          pool: runtime.pool,
          identity,
          roomId: body.roomId,
          years: body.years,
          expectedRevision: body.expectedRevision,
          confirmation: body.confirmation,
        }),
      };
    if (body.action === 'purge-dry-run')
      return {
        purge: await dryRunRoomPurge({ pool: runtime.pool, identity, roomId: body.roomId }),
      };
    if (body.action === 'purge-schedule')
      return {
        purge: await scheduleRoomPurge({
          pool: runtime.pool,
          identity,
          roomId: body.roomId,
          expectedRevision: body.expectedRevision,
          confirmation: body.confirmation,
        }),
      };
    await cancelRoomPurge({
      pool: runtime.pool,
      identity,
      purgeId: body.purgeId,
      confirmation: body.confirmation,
    });
    return { cancelled: true as const };
  };
}
export function handler(): never {
  throw new Error('lifecycle route runtime not initialized');
}
