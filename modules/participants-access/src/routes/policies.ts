import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import {
  applyDefaultExpiry,
  dryRunDefaultExpiry,
  setDocumentDownloadPolicy,
  setRoomDownloadPolicy,
  type DownloadPolicy,
} from '../room-settings.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const POLICY = Type.Union([Type.Literal('allow'), Type.Literal('deny'), Type.Null()]);
const EXPIRY = Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);
const REVISION = Type.Integer({ minimum: 1 });

const IMPACT = Type.Object(
  {
    affectedCount: Type.Integer({ minimum: 0 }),
    paths: Type.Array(Type.String()),
    resolvedExpiresAt: EXPIRY,
    confirmation: Type.String(),
    message: Type.String(),
    roomRevision: Type.Optional(REVISION),
  },
  { additionalProperties: false },
);

export const schema = {
  body: Type.Union([
    Type.Object(
      {
        action: Type.Literal('room-download'),
        roomId: ID,
        policy: POLICY,
        expectedRoomRevision: REVISION,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('document-download'),
        documentId: ID,
        policy: POLICY,
        expectedDocumentRevision: REVISION,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal('default-expiry-dry-run'), roomId: ID, expiresAt: EXPIRY },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('default-expiry-apply'),
        roomId: ID,
        expiresAt: EXPIRY,
        expectedRoomRevision: REVISION,
        confirmation: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
  ]),
  response: {
    200: Type.Union([
      Type.Object({ roomRevision: REVISION }, { additionalProperties: false }),
      Type.Object({ documentRevision: REVISION }, { additionalProperties: false }),
      Type.Object({ impact: IMPACT }, { additionalProperties: false }),
    ]),
  },
};

type Body =
  | {
      readonly action: 'room-download';
      readonly roomId: string;
      readonly policy: DownloadPolicy | null;
      readonly expectedRoomRevision: number;
    }
  | {
      readonly action: 'document-download';
      readonly documentId: string;
      readonly policy: DownloadPolicy | null;
      readonly expectedDocumentRevision: number;
    }
  | {
      readonly action: 'default-expiry-dry-run';
      readonly roomId: string;
      readonly expiresAt: string | null;
    }
  | {
      readonly action: 'default-expiry-apply';
      readonly roomId: string;
      readonly expiresAt: string | null;
      readonly expectedRoomRevision: number;
      readonly confirmation: string;
    };

const instant = (value: string | null): Date | null =>
  value === null ? null : new Date(value);

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const body = request.body as Body;
    const pool = runtime.pool;
    switch (body.action) {
      case 'room-download':
        return setRoomDownloadPolicy({ pool, identity, ...body });
      case 'document-download':
        return setDocumentDownloadPolicy({ pool, identity, ...body });
      case 'default-expiry-dry-run':
        return {
          impact: await dryRunDefaultExpiry({
            pool,
            identity,
            roomId: body.roomId,
            expiresAt: instant(body.expiresAt),
          }),
        };
      case 'default-expiry-apply':
        return {
          impact: await applyDefaultExpiry({
            pool,
            identity,
            roomId: body.roomId,
            expiresAt: instant(body.expiresAt),
            expectedRoomRevision: body.expectedRoomRevision,
            confirmation: body.confirmation,
          }),
        };
    }
  };
}

export function handler(): never {
  throw new Error('policies route runtime not initialized');
}
