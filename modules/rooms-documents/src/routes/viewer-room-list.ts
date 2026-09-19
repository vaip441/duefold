import { Type } from '@sinclair/typebox';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { readViewerRooms } from '../viewer-discovery.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
export const schema = {
  response: {
    200: Type.Object(
      {
        rooms: Type.Array(
          Type.Object(
            {
              roomId: ID,
              title: Type.String({ minLength: 1, maxLength: 200 }),
              description: Type.String({ maxLength: 2000 }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
};

export function createHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return async () => ({ rooms: await readViewerRooms({ pool: runtime.pool, identity }) });
}
export function handler(): never {
  throw new Error('viewer room list route runtime not initialized');
}
