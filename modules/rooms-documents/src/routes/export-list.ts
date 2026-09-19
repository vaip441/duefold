import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const EXPORT = Type.Object(
  {
    exportId: ID,
    preset: Type.Union([
      Type.Literal('room-index-audit'),
      Type.Literal('participant-access'),
      Type.Literal('selected-documents'),
    ]),
    includeOriginals: Type.Boolean(),
    state: Type.String(),
    /*
     * bigint in PostgreSQL, but the column CHECK in 010_exports.sql bounds it to
     * 10 GiB, which is far below Number.MAX_SAFE_INTEGER, so Number() cannot lose
     * precision. The bound is restated here so the schema is honest about the
     * range and a future ceiling increase fails validation instead of silently
     * rounding.
     */
    sizeBytes: Type.Union([Type.Integer({ minimum: 1, maximum: 10737418240 }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    expiresAt: Type.String({ format: 'date-time' }),
    consumedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    deletedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false },
);
export const schema = {
  querystring: Type.Object(
    {
      roomId: ID,
      limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
      afterCreatedAt: Type.Optional(Type.String({ format: 'date-time' })),
      afterExportId: Type.Optional(ID),
    },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object({ exports: Type.Array(EXPORT) }, { additionalProperties: false }),
  },
};
interface Query {
  readonly roomId: string;
  readonly limit?: string;
  readonly afterCreatedAt?: string;
  readonly afterExportId?: string;
}
interface Row {
  readonly export_id: string;
  readonly preset: 'room-index-audit' | 'participant-access' | 'selected-documents';
  readonly include_originals: boolean;
  readonly state: string;
  readonly size_bytes: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly deleted_at: Date | null;
}
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const query = request.query as Query;
    if ((query.afterCreatedAt === undefined) !== (query.afterExportId === undefined))
      throw new Error('EXPORT_CURSOR_INVALID');
    const result = await runtime.pool.query<Row>(
      'SELECT * FROM read_member_exports($1,$2,$3,$4,$5)',
      [
        identity.id,
        query.roomId,
        query.afterCreatedAt ?? null,
        query.afterExportId ?? null,
        Number(query.limit ?? '50'),
      ],
    );
    return {
      exports: result.rows.map((row) => ({
        exportId: row.export_id,
        preset: row.preset,
        includeOriginals: row.include_originals,
        state: row.state,
        sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        consumedAt: row.consumed_at?.toISOString() ?? null,
        deletedAt: row.deleted_at?.toISOString() ?? null,
      })),
    };
  };
}
export function handler(): never {
  throw new Error('export list route runtime not initialized');
}
