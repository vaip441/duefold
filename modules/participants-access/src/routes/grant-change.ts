import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import {
  applyGrantChange,
  dryRunGrantChange,
  type GrantChangeInput,
} from '../grant-operations.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const NULLABLE_ID = Type.Union([ID, Type.Null()]);
const CHANGE = {
  granteeKind: Type.Union([Type.Literal('viewer'), Type.Literal('counterparty'), Type.Null()]),
  viewerId: NULLABLE_ID,
  counterpartyId: NULLABLE_ID,
  targetKind: Type.Union([
    Type.Literal('room'),
    Type.Literal('folder'),
    Type.Literal('document'),
    Type.Null(),
  ]),
  folderId: NULLABLE_ID,
  documentId: NULLABLE_ID,
  expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
};
const IMPACT = Type.Object(
  {
    grantId: ID,
    action: Type.Union([Type.Literal('grant'), Type.Literal('revoke'), Type.Literal('expiry')]),
    affectedCount: Type.Integer({ minimum: 0 }),
    paths: Type.Array(Type.String()),
    confirmation: Type.String(),
    message: Type.String(),
    resolvedExpiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    roomRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
export const schema = {
  body: Type.Union([
    Type.Object(
      {
        action: Type.Literal('dry-run'),
        roomId: ID,
        changeAction: Type.Union([
          Type.Literal('grant'),
          Type.Literal('revoke'),
          Type.Literal('expiry'),
        ]),
        grantId: Type.Optional(ID),
        ...CHANGE,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('apply'),
        roomId: ID,
        changeAction: Type.Union([
          Type.Literal('grant'),
          Type.Literal('revoke'),
          Type.Literal('expiry'),
        ]),
        grantId: ID,
        ...CHANGE,
        expectedRoomRevision: Type.Integer({ minimum: 1 }),
        confirmation: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
  ]),
  response: { 200: IMPACT },
};
interface Body {
  readonly action: 'dry-run' | 'apply';
  readonly roomId: string;
  readonly changeAction: 'grant' | 'revoke' | 'expiry';
  readonly grantId?: string;
  readonly granteeKind: 'viewer' | 'counterparty' | null;
  readonly viewerId: string | null;
  readonly counterpartyId: string | null;
  readonly targetKind: 'room' | 'folder' | 'document' | null;
  readonly folderId: string | null;
  readonly documentId: string | null;
  readonly expiresAt: string | null;
  readonly expectedRoomRevision?: number;
  readonly confirmation?: string;
}
function change(body: Body): GrantChangeInput {
  if (body.changeAction !== 'grant' && body.grantId === undefined)
    throw new Error('GRANT_ID_REQUIRED');
  return {
    action: body.changeAction,
    grantId: body.grantId ?? createOpaqueId(),
    granteeKind: body.granteeKind,
    viewerId: body.viewerId,
    counterpartyId: body.counterpartyId,
    targetKind: body.targetKind,
    folderId: body.folderId,
    documentId: body.documentId,
    expiresAt: body.expiresAt === null ? null : new Date(body.expiresAt),
  };
}
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const body = request.body as Body;
    const parsed = change(body);
    if (body.action === 'dry-run') {
      const impact = await dryRunGrantChange({
        pool: runtime.pool,
        identity,
        roomId: body.roomId,
        change: parsed,
      });
      return { grantId: parsed.grantId, ...impact };
    }
    if (body.expectedRoomRevision === undefined || body.confirmation === undefined)
      throw new Error('GRANT_APPLY_INPUT_REQUIRED');
    const impact = await applyGrantChange({
      pool: runtime.pool,
      identity,
      roomId: body.roomId,
      change: parsed,
      expectedRoomRevision: body.expectedRoomRevision,
      confirmation: body.confirmation,
      auditId: createOpaqueId(),
      correlationId: createCorrelationId(),
      now: runtime.clock.now(),
    });
    return { grantId: parsed.grantId, ...impact };
  };
}
export function handler(): never {
  throw new Error('grant change route runtime not initialized');
}
