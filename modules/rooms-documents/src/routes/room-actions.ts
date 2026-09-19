import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import {
  applyBulkPublish,
  dryRunBulkPublish,
  restoreTrash,
  searchMemberRoom,
  type BulkImpact,
  type SearchResult,
} from '../room-operations.ts';

/**
 * High-consequence room actions.
 *
 * Publication is dry-run, then typed confirmation, then an atomic switch. The
 * confirmation string is produced by the server's dry-run and compared server-side
 * by apply_bulk_publish; the client cannot synthesize one, and a client that skips
 * the preview cannot guess it. Manager-only enforcement and fresh-OIDC live in the
 * SECURITY DEFINER function, not here.
 *
 * Restore requires an explicit destination and a non-conflicting name. It returns
 * content to draft and restores neither publication nor grants — the response says
 * only what happened, and the UI must not imply otherwise.
 */
const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });

export const schema = {
  body: Type.Union([
    Type.Object(
      { action: Type.Literal('publish-dry-run'), roomId: ID },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('publish-apply'),
        roomId: ID,
        expectedWorkingRevision: Type.Integer(),
        expectedPublishedRevision: Type.Integer(),
        confirmation: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('restore'),
        trashId: ID,
        destinationFolderId: Type.Union([ID, Type.Null()]),
        displayName: Type.String({ minLength: 1, maxLength: 200 }),
        expectedEntryRevision: Type.Integer(),
        expectedWorkingRevision: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('search'),
        roomId: ID,
        query: Type.String({ minLength: 1, maxLength: 200 }),
      },
      { additionalProperties: false },
    ),
  ]),
  response: {
    200: Type.Object(
      {
        impact: Type.Optional(
          Type.Object(
            {
              message: Type.String(),
              affectedCount: Type.Integer(),
              paths: Type.Array(Type.String()),
              confirmation: Type.String(),
              /*
               * REQUIRED, not optional. A high-consequence publish confirmation
               * must enumerate what it will change; an absent items array let the
               * client substitute an empty list and show a count with no detail.
               */
              items: Type.Array(
                Type.Object(
                  {
                    entryId: Type.String(),
                    path: Type.String(),
                    changes: Type.Array(Type.String(), { minItems: 1 }),
                  },
                  { additionalProperties: false },
                ),
              ),
            },
            { additionalProperties: true },
          ),
        ),
        publishedRevision: Type.Optional(Type.Integer()),
        workingRevision: Type.Optional(Type.Integer()),
        entryRevision: Type.Optional(Type.Integer()),
        results: Type.Optional(
          Type.Array(
            Type.Object(
              {
                resourceKind: Type.Union([
                  Type.Literal('room'),
                  Type.Literal('folder'),
                  Type.Literal('document'),
                ]),
                resourceId: Type.String(),
                displayName: Type.String(),
                description: Type.String(),
                path: Type.String(),
              },
              { additionalProperties: false },
            ),
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
};

type Body =
  | { readonly action: 'publish-dry-run'; readonly roomId: string }
  | {
      readonly action: 'publish-apply';
      readonly roomId: string;
      readonly expectedWorkingRevision: number;
      readonly expectedPublishedRevision: number;
      readonly confirmation: string;
    }
  | {
      readonly action: 'restore';
      readonly trashId: string;
      readonly destinationFolderId: string | null;
      readonly displayName: string;
      readonly expectedEntryRevision: number;
      readonly expectedWorkingRevision: number;
    }
  | { readonly action: 'search'; readonly roomId: string; readonly query: string };

interface RoomActionResponse {
  readonly impact?: BulkImpact;
  readonly publishedRevision?: number;
  readonly workingRevision?: number;
  readonly entryRevision?: number;
  readonly results?: readonly SearchResult[];
}

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest): Promise<RoomActionResponse> => {
    const body = request.body as Body;
    if (body.action === 'publish-dry-run') {
      const impact = await dryRunBulkPublish({
        pool: runtime.pool,
        identity,
        roomId: body.roomId,
      });
      return { impact };
    }
    if (body.action === 'publish-apply') {
      const applied = await applyBulkPublish({
        pool: runtime.pool,
        identity,
        roomId: body.roomId,
        expectedWorkingRevision: body.expectedWorkingRevision,
        expectedPublishedRevision: body.expectedPublishedRevision,
        confirmation: body.confirmation,
      });
      return { publishedRevision: applied.publishedRevision };
    }
    if (body.action === 'restore') {
      const restored = await restoreTrash({
        pool: runtime.pool,
        identity,
        trashId: body.trashId,
        destinationFolderId: body.destinationFolderId,
        displayName: body.displayName,
        orderKey: Date.now(),
        expectedEntryRevision: body.expectedEntryRevision,
        expectedWorkingRevision: body.expectedWorkingRevision,
      });
      return {
        entryRevision: restored.entryRevision,
        workingRevision: restored.workingRevision,
      };
    }
    const results = await searchMemberRoom({
      pool: runtime.pool,
      identity,
      roomId: body.roomId,
      query: body.query,
    });
    return { results };
  };
}
export function handler(): never {
  throw new Error('room action route runtime not initialized');
}
