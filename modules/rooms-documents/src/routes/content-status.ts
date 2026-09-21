import { Type } from '@sinclair/typebox';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { protectedErrorResponses } from '../../../core-security/src/routes/error-envelope.ts';
import { readContentStatus } from '../content-status.ts';

const INSTANT = Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);
const TEXT = Type.Union([Type.String({ minLength: 1, maxLength: 500 }), Type.Null()]);
const closed = { additionalProperties: false } as const;

export const schema = {
  response: {
    200: Type.Object(
      {
        processing: Type.Object({ failedCount: Type.Integer({ minimum: 0 }) }, closed),
        recovery: Type.Object(
          {
            backupStatus: Type.Union([
              Type.Literal('undetermined'),
              Type.Literal('operator-acknowledged'),
            ]),
            backupRetention: TEXT,
            recoveryExpectation: TEXT,
            acknowledgedAt: INSTANT,
            restoreDrillStatus: Type.Union([
              Type.Literal('not-tested'),
              Type.Literal('passed'),
              Type.Literal('failed'),
            ]),
            restoreDrillAt: INSTANT,
          },
          closed,
        ),
      },
      closed,
    ),
    ...protectedErrorResponses(),
  },
};

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return () => readContentStatus({ pool: runtime.pool, identity });
}

export function handler(): never {
  throw new Error('content status route runtime not initialized');
}
