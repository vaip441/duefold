import { Type } from '@sinclair/typebox';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { protectedErrorResponses } from '../../../core-security/src/routes/error-envelope.ts';
import { readInstallationSettings } from '../installation-settings.ts';

const closed = { additionalProperties: false } as const;

export const schema = {
  response: {
    200: Type.Object(
      {
        settings: Type.Object(
          {
            downloadPolicy: Type.Union([Type.Literal('allow'), Type.Literal('deny')]),
            revision: Type.Integer({ minimum: 1 }),
            inheritingRoomCount: Type.Integer({ minimum: 0 }),
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
  return async () => ({
    settings: await readInstallationSettings({ pool: runtime.pool, identity }),
  });
}

export function handler(): never {
  throw new Error('installation route runtime not initialized');
}
