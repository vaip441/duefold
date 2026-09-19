import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { requestExport, preflightExport, type ExportPreset } from '../exports.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const PRESET = Type.Union([
  Type.Literal('room-index-audit'),
  Type.Literal('participant-access'),
  Type.Literal('selected-documents'),
]);
const preflightBody = {
  roomId: ID,
  preset: PRESET,
  selectedDocumentIds: Type.Array(ID, { maxItems: 1000, uniqueItems: true }),
  includeOriginals: Type.Boolean(),
};
export const schema = {
  body: Type.Union([
    Type.Object(
      { action: Type.Literal('preflight'), ...preflightBody },
      { additionalProperties: false },
    ),
    Type.Object(
      { action: Type.Literal('generate'), ...preflightBody },
      { additionalProperties: false },
    ),
  ]),
  response: {
    200: Type.Union([
      Type.Object(
        {
          piiCategories: Type.Array(Type.String()),
          fileCount: Type.Integer(),
          estimatedSize: Type.Integer(),
          retentionEffect: Type.String(),
          originalsIncluded: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      Type.Object({ exportId: ID }, { additionalProperties: false }),
    ]),
  },
};
interface Body {
  readonly action: 'preflight' | 'generate';
  readonly roomId: string;
  readonly preset: ExportPreset;
  readonly selectedDocumentIds: readonly string[];
  readonly includeOriginals: boolean;
}
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest): Promise<unknown> => {
    const body = request.body as Body;
    const common = {
      pool: runtime.pool,
      identity,
      roomId: body.roomId,
      preset: body.preset,
      selectedDocumentIds: body.selectedDocumentIds,
      includeOriginals: body.includeOriginals,
    };
    if (body.action === 'preflight') return preflightExport(common);
    const generated = await requestExport({
      ...common,
    });
    return { exportId: generated.exportId };
  };
}
export function handler(): never {
  throw new Error('export route runtime not initialized');
}
