import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { readRoomSettings } from '../room-settings.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const POLICY = Type.Union([Type.Literal('allow'), Type.Literal('deny')]);
const INSTANT = Type.String({ format: 'date-time' });

export const SETTINGS = Type.Object(
  {
    roomId: ID,
    state: Type.Union([
      Type.Literal('draft'),
      Type.Literal('published'),
      Type.Literal('archived'),
    ]),
    revision: Type.Integer({ minimum: 1 }),
    publishedRevision: Type.Integer({ minimum: 0 }),
    auditRetentionYears: Type.Integer({ minimum: 1, maximum: 10 }),
    defaultGrantExpiresAt: Type.Union([INSTANT, Type.Null()]),
    downloadPolicy: Type.Union([POLICY, Type.Null()]),
    installationDownloadPolicy: POLICY,
    purge: Type.Union([
      Type.Object(
        {
          purgeId: ID,
          state: Type.Union([
            Type.Literal('scheduled'),
            Type.Literal('marker_pending'),
            Type.Literal('purging'),
            Type.Literal('purged'),
            Type.Literal('failed'),
          ]),
          purgeAfter: INSTANT,
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    capabilities: Type.Object(
      {
        publish: Type.Boolean(),
        archive: Type.Boolean(),
        returnToDraft: Type.Boolean(),
        setRetention: Type.Boolean(),
        schedulePurge: Type.Boolean(),
        cancelPurge: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const schema = {
  querystring: Type.Object({ roomId: ID }, { additionalProperties: false }),
  response: {
    200: Type.Object(
      {
        settings: SETTINGS,
        downloadOverrides: Type.Array(
          Type.Object({ documentId: ID, policy: POLICY }, { additionalProperties: false }),
        ),
      },
      { additionalProperties: false },
    ),
  },
};

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const { roomId } = request.query as { readonly roomId: string };
    return readRoomSettings({ pool: runtime.pool, identity, roomId });
  };
}

export function handler(): never {
  throw new Error('room settings route runtime not initialized');
}
