import { Type } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import {
  createFolder,
  fractionalOrderKey,
  mutateEntry,
  updateDocumentMetadata,
  updateFolderDescription,
} from '../structure.ts';
import { readWorkingStructure } from '../workspace-reads.ts';

/**
 * Working-structure mutations: create, rename, move, reorder, staged removal, and
 * metadata staging.
 *
 * Every action carries the caller's expected revisions, so a stale client write
 * fails for an explicit refresh instead of silently overwriting a colleague.
 * Authorization is the SECURITY DEFINER function's decision;
 * nothing here infers permission from the request.
 *
 * Reordering takes a TARGET POSITION, never a fractional order key. The server
 * resolves the key from the current sibling order, so a client cannot construct
 * an ordering value, and an accessible "move up/down/to position" control is the
 * same operation a pointer drag would perform.
 */
const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const NAME = Type.String({ minLength: 1, maxLength: 200 });
const DESCRIPTION = Type.String({ maxLength: 4000 });

export const schema = {
  body: Type.Union([
    Type.Object(
      {
        action: Type.Literal('create-folder'),
        roomId: ID,
        parentFolderId: Type.Optional(ID),
        displayName: NAME,
        description: DESCRIPTION,
        expectedWorkingRevision: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('rename'),
        roomId: ID,
        entryId: ID,
        displayName: NAME,
        expectedEntryRevision: Type.Integer(),
        expectedWorkingRevision: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('move'),
        roomId: ID,
        entryId: ID,
        destinationFolderId: Type.Union([ID, Type.Null()]),
        targetPosition: Type.Integer({ minimum: 1 }),
        expectedEntryRevision: Type.Integer(),
        expectedWorkingRevision: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('reorder'),
        roomId: ID,
        entryId: ID,
        targetPosition: Type.Integer({ minimum: 1 }),
        expectedEntryRevision: Type.Integer(),
        expectedWorkingRevision: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('stage-removal'),
        roomId: ID,
        entryId: ID,
        expectedEntryRevision: Type.Integer(),
        expectedWorkingRevision: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('folder-description'),
        roomId: ID,
        folderId: ID,
        description: DESCRIPTION,
        expectedEntryRevision: Type.Integer(),
        expectedWorkingRevision: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal('document-metadata'),
        roomId: ID,
        documentId: ID,
        title: NAME,
        description: DESCRIPTION,
        expectedDocumentRevision: Type.Integer(),
        expectedWorkingRevision: Type.Integer(),
      },
      { additionalProperties: false },
    ),
  ]),
  response: {
    200: Type.Object(
      {
        workingRevision: Type.Integer(),
        entryRevision: Type.Optional(Type.Integer()),
        documentRevision: Type.Optional(Type.Integer()),
        folderId: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
};

type Body =
  | {
      readonly action: 'create-folder';
      readonly roomId: string;
      readonly parentFolderId?: string;
      readonly displayName: string;
      readonly description: string;
      readonly expectedWorkingRevision: number;
    }
  | {
      readonly action: 'rename';
      readonly roomId: string;
      readonly entryId: string;
      readonly displayName: string;
      readonly expectedEntryRevision: number;
      readonly expectedWorkingRevision: number;
    }
  | {
      readonly action: 'move';
      readonly roomId: string;
      readonly entryId: string;
      readonly destinationFolderId: string | null;
      readonly targetPosition: number;
      readonly expectedEntryRevision: number;
      readonly expectedWorkingRevision: number;
    }
  | {
      readonly action: 'reorder';
      readonly roomId: string;
      readonly entryId: string;
      readonly targetPosition: number;
      readonly expectedEntryRevision: number;
      readonly expectedWorkingRevision: number;
    }
  | {
      readonly action: 'stage-removal';
      readonly roomId: string;
      readonly entryId: string;
      readonly expectedEntryRevision: number;
      readonly expectedWorkingRevision: number;
    }
  | {
      readonly action: 'folder-description';
      readonly roomId: string;
      readonly folderId: string;
      readonly description: string;
      readonly expectedEntryRevision: number;
      readonly expectedWorkingRevision: number;
    }
  | {
      readonly action: 'document-metadata';
      readonly roomId: string;
      readonly documentId: string;
      readonly title: string;
      readonly description: string;
      readonly expectedDocumentRevision: number;
      readonly expectedWorkingRevision: number;
    };

/**
 * Resolve a fractional ordering key from a requested 1-based position among the
 * destination's siblings, as the server sees them right now.
 *
 * The client never sends a key. It also cannot learn one: the reader returns dense
 * positions only. If the fractional space between two neighbours is exhausted,
 * fractionalOrderKey raises ORDER_REBALANCE_REQUIRED and the caller must rebalance
 * — silently rounding would corrupt the sibling order.
 */
async function keyForPosition(
  runtime: WebRuntime,
  identity: MemberIdentity,
  input: {
    readonly roomId: string;
    readonly entryId: string;
    readonly destinationFolderId: string | null;
    readonly targetPosition: number;
  },
): Promise<{ readonly orderKey: number; readonly displayName: string }> {
  const entries = await readWorkingStructure({
    pool: runtime.pool,
    identity,
    roomId: input.roomId,
  });
  const moving = entries.find((entry) => entry.entryId === input.entryId);
  if (moving === undefined) throw new Error('STRUCTURE_ENTRY_UNREACHABLE');
  const siblings = entries
    .filter(
      (entry) =>
        entry.parentFolderId === input.destinationFolderId &&
        entry.entryId !== input.entryId &&
        !entry.stagedRemoved,
    )
    .sort((left, right) => left.position - right.position);
  /*
   * Positions are resolved against the sibling list WITHOUT the moving entry, so
   * "move to position 2" means the same thing whether the entry is currently above
   * or below that slot. Reading neighbour keys requires the fractional values the
   * reader deliberately withholds, so they are fetched here on the server.
   */
  const index = Math.min(Math.max(input.targetPosition, 1), siblings.length + 1) - 1;
  const before = siblings[index - 1];
  const after = siblings[index];
  const neighbourKey = async (entryId: string | undefined): Promise<number | undefined> => {
    if (entryId === undefined) return undefined;
    const row = (
      await runtime.pool.query<{ order_key: string }>(
        'SELECT order_key FROM read_structure_entry_revision($1,$2)',
        [entryId, identity.id],
      )
    ).rows[0];
    if (row === undefined) return undefined;
    const parsed = Number(row.order_key);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const orderKey = fractionalOrderKey(
    await neighbourKey(before?.entryId),
    await neighbourKey(after?.entryId),
  );
  return { orderKey, displayName: moving.displayName };
}

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Body;
    if (body.action === 'create-folder') {
      const created = await createFolder({
        pool: runtime.pool,
        identity,
        roomId: body.roomId,
        ...(body.parentFolderId === undefined ? {} : { parentFolderId: body.parentFolderId }),
        displayName: body.displayName,
        description: body.description,
        orderKey: Date.now(),
        expectedWorkingRevision: body.expectedWorkingRevision,
      });
      reply.code(200);
      return { workingRevision: created.workingRevision, folderId: created.folderId };
    }
    if (body.action === 'folder-description') {
      const updated = await updateFolderDescription({
        pool: runtime.pool,
        identity,
        folderId: body.folderId,
        description: body.description,
        expectedEntryRevision: body.expectedEntryRevision,
        expectedWorkingRevision: body.expectedWorkingRevision,
      });
      reply.code(200);
      return updated;
    }
    if (body.action === 'document-metadata') {
      const updated = await updateDocumentMetadata({
        pool: runtime.pool,
        identity,
        documentId: body.documentId,
        title: body.title,
        description: body.description,
        expectedDocumentRevision: body.expectedDocumentRevision,
        expectedWorkingRevision: body.expectedWorkingRevision,
      });
      reply.code(200);
      return updated;
    }

    const entries = await readWorkingStructure({
      pool: runtime.pool,
      identity,
      roomId: body.roomId,
    });
    const current = entries.find((entry) => entry.entryId === body.entryId);
    if (current === undefined) throw new Error('STRUCTURE_ENTRY_UNREACHABLE');

    if (body.action === 'rename') {
      const updated = await mutateEntry({
        pool: runtime.pool,
        identity,
        entryId: body.entryId,
        ...(current.parentFolderId === null ? {} : { parentFolderId: current.parentFolderId }),
        displayName: body.displayName,
        orderKey: await currentKey(runtime, identity, body.entryId),
        stagedRemoved: current.stagedRemoved,
        expectedEntryRevision: body.expectedEntryRevision,
        expectedWorkingRevision: body.expectedWorkingRevision,
      });
      reply.code(200);
      return updated;
    }
    if (body.action === 'stage-removal') {
      const updated = await mutateEntry({
        pool: runtime.pool,
        identity,
        entryId: body.entryId,
        ...(current.parentFolderId === null ? {} : { parentFolderId: current.parentFolderId }),
        displayName: current.displayName,
        orderKey: await currentKey(runtime, identity, body.entryId),
        stagedRemoved: true,
        expectedEntryRevision: body.expectedEntryRevision,
        expectedWorkingRevision: body.expectedWorkingRevision,
      });
      reply.code(200);
      return updated;
    }

    const destination =
      body.action === 'move' ? body.destinationFolderId : current.parentFolderId;
    const placed = await keyForPosition(runtime, identity, {
      roomId: body.roomId,
      entryId: body.entryId,
      destinationFolderId: destination,
      targetPosition: body.targetPosition,
    });
    const updated = await mutateEntry({
      pool: runtime.pool,
      identity,
      entryId: body.entryId,
      ...(destination === null ? {} : { parentFolderId: destination }),
      displayName: placed.displayName,
      orderKey: placed.orderKey,
      stagedRemoved: current.stagedRemoved,
      expectedEntryRevision: body.expectedEntryRevision,
      expectedWorkingRevision: body.expectedWorkingRevision,
    });
    reply.code(200);
    return updated;
  };
}

async function currentKey(
  runtime: WebRuntime,
  identity: MemberIdentity,
  entryId: string,
): Promise<number> {
  const row = (
    await runtime.pool.query<{ order_key: string }>(
      'SELECT order_key FROM read_structure_entry_revision($1,$2)',
      [entryId, identity.id],
    )
  ).rows[0];
  if (row === undefined) throw new Error('STRUCTURE_ENTRY_UNREACHABLE');
  const parsed = Number(row.order_key);
  if (!Number.isFinite(parsed)) throw new Error('STRUCTURE_ENTRY_UNREACHABLE');
  return parsed;
}

export function handler(): never {
  throw new Error('structure mutation route runtime not initialized');
}
