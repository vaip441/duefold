import { Type } from '@sinclair/typebox';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../authorization.ts';
import { readDeploymentStatus } from '../deployment-status.ts';
import { protectedErrorResponses } from './error-envelope.ts';

const COUNT = Type.Integer({ minimum: 0 });
const INSTANT = Type.String({ format: 'date-time' });
const NAME = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' });
const RELEASE = Type.String({ pattern: '^[0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6}$' });
const closed = { additionalProperties: false } as const;

const OBSERVATION = Type.Object(
  {
    result: Type.Union([Type.Literal('pass'), Type.Literal('attention'), Type.Literal('fail')]),
    code: Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' }),
    evidenceAt: Type.Union([INSTANT, Type.Null()]),
    evidenceVersion: Type.Union([RELEASE, Type.Null()]),
    observedAt: INSTANT,
    stale: Type.Boolean(),
  },
  closed,
);

/**
 * What an Owner or Admin reads about this deployment. Every string is a version, a module
 * or adapter name, a migration id or a code; nothing here can carry configuration.
 */
export const schema = {
  response: {
    200: Type.Object(
      {
        application: Type.Object(
          {
            version: RELEASE,
            modules: Type.Array(NAME, { minItems: 1, maxItems: 4 }),
            adapters: Type.Object({ storage: NAME, mail: NAME, identity: NAME }, closed),
          },
          closed,
        ),
        oidc: Type.Object({ discoveryConformedAt: INSTANT }, closed),
        migrations: Type.Object(
          {
            state: Type.Union([
              Type.Literal('current'),
              Type.Literal('pending'),
              Type.Literal('unrecognized'),
            ]),
            appliedCount: COUNT,
            expectedCount: COUNT,
            latestApplied: Type.Union([
              Type.String({ pattern: '^[0-9]{3}_[a-z0-9_]{1,80}$' }),
              Type.Null(),
            ]),
          },
          closed,
        ),
        queue: Type.Object(
          {
            due: COUNT,
            running: COUNT,
            failedRecently: COUNT,
            oldestDueSeconds: Type.Union([COUNT, Type.Null()]),
          },
          closed,
        ),
        mail: Type.Object(
          { lastDeliveredAt: Type.Union([INSTANT, Type.Null()]), failedRecently: COUNT },
          closed,
        ),
        checks: Type.Array(
          Type.Object(
            {
              check: Type.Union([
                Type.Literal('storage-privacy'),
                Type.Literal('storage-versioning'),
                Type.Literal('scanner'),
                Type.Literal('updates'),
              ]),
              observation: Type.Union([OBSERVATION, Type.Null()]),
            },
            closed,
          ),
          { minItems: 4, maxItems: 4 },
        ),
      },
      closed,
    ),
    ...protectedErrorResponses(),
  },
};

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return () =>
    readDeploymentStatus({ pool: runtime.pool, identity, facts: runtime.deployment });
}

export function handler(): never {
  throw new Error('deployment status route runtime not initialized');
}
