import type { Pool } from 'pg';
import type { ViewerIdentity } from '../../core-security/src/authorization.ts';

function requiredSession(identity: ViewerIdentity): string {
  if (identity.sessionId === undefined) throw new Error('VIEWER_SESSION_REQUIRED');
  return identity.sessionId;
}

/** Room-level capability check only; data projection remains viewer-aware in SQL. */
export async function authorizeViewerPublishedRoom(input: {
  readonly pool: Pool;
  readonly identity: ViewerIdentity;
  readonly roomId: string;
}): Promise<boolean> {
  const result = await input.pool.query<{ allowed: boolean }>(
    'SELECT authorize_viewer_published_room($1,$2,$3) allowed',
    [input.identity.id, requiredSession(input.identity), input.roomId],
  );
  return result.rows[0]?.allowed === true;
}

/** Document-scoped authorizer for protected page delivery. */
export async function canViewerPreviewDocument(input: {
  readonly pool: Pool;
  readonly identity: ViewerIdentity;
  readonly roomId: string;
  readonly documentId: string;
}): Promise<boolean> {
  const result = await input.pool.query<{ allowed: boolean }>(
    'SELECT viewer_can_preview_document($1,$2,$3,$4) allowed',
    [input.identity.id, requiredSession(input.identity), input.roomId, input.documentId],
  );
  return result.rows[0]?.allowed === true;
}
