import { Type } from '@sinclair/typebox';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';

export const schema = {
  response: {
    200: Type.Object(
      { roomIntroduction: Type.String({ maxLength: 2000 }) },
      { additionalProperties: false },
    ),
  },
};

function sessionProof(identity: ViewerIdentity): string {
  if (identity.sessionProof === undefined) throw new Error('VIEWER_SESSION_PROOF_REQUIRED');
  return identity.sessionProof;
}

/** Viewer-only optional branding projection; no core SQL contract is overwritten. */
export function createHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return async (): Promise<{ readonly roomIntroduction: string }> => {
    const row = (
      await runtime.pool.query<{ room_introduction: string }>(
        'SELECT * FROM read_viewer_branding_introduction($1)',
        [sessionProof(identity)],
      )
    ).rows[0];
    return { roomIntroduction: row?.room_introduction ?? '' };
  };
}

export function handler(): never {
  throw new Error('viewer introduction route runtime not initialized');
}
