import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import {
  readTrash,
  readWorkingStructure,
  type TrashEntry,
  type WorkingStructureEntry,
} from '../workspace-reads.ts';
import { TRASH_RETENTION_DAYS } from '../room-operations.ts';

/**
 * One room's working structure, its publication delta, and its trash.
 *
 * The reader authorizes internally and returns zero rows for a room the member
 * cannot reach, so an unauthorized room is indistinguishable from an empty one:
 * no title, path, count, or identifier leaks through this response.
 *
 * `changeKinds` comes from the same server expression the publication preview
 * uses, so the workspace's pending markers and the publish preview cannot
 * disagree. `position`/`canMoveUp`/`canMoveDown` replace the fractional ordering
 * key, which is never exposed: the reorder API takes a target position.
 *
 * `retentionDays` is stated as the fixed policy value and `purgeAfter` is an
 * absolute server instant. The client must not compute a countdown from its own
 * clock — a wrong "1 day left" before an irreversible purge is a serious failure.
 */
const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });

export const schema = {
  querystring: Type.Object({ roomId: ID }, { additionalProperties: false }),
  response: {
    200: Type.Object(
      {
        entries: Type.Array(
          Type.Object(
            {
              entryId: Type.String(),
              resourceKind: Type.Union([Type.Literal('folder'), Type.Literal('document')]),
              resourceId: Type.String(),
              parentFolderId: Type.Union([Type.String(), Type.Null()]),
              displayName: Type.String(),
              description: Type.String(),
              revision: Type.Integer(),
              stagedRemoved: Type.Boolean(),
              depth: Type.Integer(),
              position: Type.Integer(),
              canMoveUp: Type.Boolean(),
              canMoveDown: Type.Boolean(),
              changeKinds: Type.Array(Type.String()),
              hasPublishableVersion: Type.Boolean(),
              isPublished: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
        ),
        trash: Type.Array(
          Type.Object(
            {
              trashId: Type.String(),
              resourceKind: Type.Union([Type.Literal('folder'), Type.Literal('document')]),
              displayName: Type.String(),
              rootEntryId: Type.String(),
              entryRevision: Type.Integer(),
              trashedAt: Type.String(),
              purgeAfter: Type.String(),
              wasPublished: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
        ),
        retentionDays: Type.Integer(),
      },
      { additionalProperties: false },
    ),
  },
};

function query(value: unknown): { readonly roomId: string } {
  return value as { readonly roomId: string };
}

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (
    request: FastifyRequest,
  ): Promise<{
    readonly entries: readonly WorkingStructureEntry[];
    readonly trash: readonly TrashEntry[];
    readonly retentionDays: number;
  }> => {
    const { roomId } = query(request.query);
    const [entries, trash] = await Promise.all([
      readWorkingStructure({ pool: runtime.pool, identity, roomId }),
      readTrash({ pool: runtime.pool, identity, roomId }),
    ]);
    return { entries, trash, retentionDays: TRASH_RETENTION_DAYS };
  };
}
export function handler(): never {
  throw new Error('room workspace route runtime not initialized');
}
