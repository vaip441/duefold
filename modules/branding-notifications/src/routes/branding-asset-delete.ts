/**
 * Route for removing an existing custom brand asset (logo or square-mark).
 *
 * Authorization enforced in SQL: only an Owner or Admin can delete branding assets.
 * Deletion is transactionally audited and removes the derivative from storage.
 */

import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';

export const schema = {
  body: Type.Object(
    {
      action: Type.Literal('delete'),
      assetKind: Type.Union([Type.Literal('logo'), Type.Literal('square-mark')]),
    },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object({ deleted: Type.Boolean() }, { additionalProperties: false }),
  },
};

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const body = request.body as {
      readonly assetKind: 'logo' | 'square-mark';
    };
    const auditId = createOpaqueId();
    const correlationId = createCorrelationId();
    const client = await runtime.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{ read_branding_asset_for_delete: string | null }>(
        'SELECT read_branding_asset_for_delete($1,$2)',
        [identity.id, body.assetKind],
      );
      const key = selected.rows[0]?.read_branding_asset_for_delete;
      if (key !== null && key !== undefined && key !== '') {
        // Keep the database reference when object deletion fails. The row is locked
        // until commit so replacement processing cannot race this operation.
        await runtime.storage.deleteObject(key);
      }
      const result = await client.query<{ delete_branding_asset: string | null }>(
        'SELECT delete_branding_asset($1,$2,$3,$4)',
        [identity.id, body.assetKind, auditId, correlationId],
      );
      const deletedKey = result.rows[0]?.delete_branding_asset;
      if ((key ?? null) !== (deletedKey ?? null)) throw new Error('BRANDING_ASSET_DELETE_RACE');
      await client.query('COMMIT');
      return { deleted: deletedKey !== null && deletedKey !== undefined };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}

export function handler(): never {
  throw new Error('branding route runtime not initialized');
}
