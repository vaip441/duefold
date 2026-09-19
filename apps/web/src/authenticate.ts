import type { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import type { PrincipalIdentity } from '../../../modules/core-security/src/authorization.ts';
import {
  constantTimeDigestMatch,
  digestSecret,
  IDLE_RENEWAL_CADENCE_MINUTES,
  SESSION_COOKIE,
  type SessionPolicy,
} from '../../../modules/core-security/src/sessions.ts';

export type { PrincipalIdentity } from '../../../modules/core-security/src/authorization.ts';
export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly familyId: string;
  readonly csrfDigest: string;
  readonly principal: PrincipalIdentity;
}

interface SessionRow {
  readonly id: string;
  readonly family_id: string;
  readonly principal_kind: 'member' | 'viewer';
  readonly member_id: string | null;
  readonly viewer_id: string | null;
  readonly csrf_digest: string;
  readonly secret_digest: string;
  readonly global_role: 'owner' | 'admin' | 'member' | null;
  readonly oidc_authenticated_at: Date | null;
  readonly room_roles: unknown;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseRoomRoles(value: unknown): Readonly<Record<string, 'manager' | 'contributor'>> {
  if (!isRecord(value)) return {};
  const roles: Record<string, 'manager' | 'contributor'> = {};
  for (const [roomId, role] of Object.entries(value)) {
    if (role === 'manager' || role === 'contributor') roles[roomId] = role;
    else throw new Error('invalid room role from database');
  }
  return roles;
}

/** Resolves, validates, and renews one session in a single authorizing statement. */
export function createSessionAuthenticator(
  pool: Pool,
  policy: SessionPolicy,
): (request: FastifyRequest) => Promise<AuthenticatedSession | null> {
  return async (request) => {
    const secret = request.cookies[SESSION_COOKIE];
    if (secret === undefined || secret.length < 40 || secret.length > 100) return null;
    const result = await pool.query<SessionRow>(
      `WITH authorized AS (
         SELECT s.id FROM session s
         LEFT JOIN member m ON m.id = s.member_id AND m.state = 'active'
         LEFT JOIN viewer v ON v.id = s.viewer_id AND v.state = 'active'
         WHERE s.secret_digest = $1 AND s.state = 'active'
           AND s.idle_expires_at > clock_timestamp()
           AND s.absolute_expires_at > clock_timestamp()
           AND ((s.principal_kind = 'member' AND m.id IS NOT NULL)
             OR (s.principal_kind = 'viewer' AND v.id IS NOT NULL))
         FOR UPDATE OF s
       ), renewed AS (
         UPDATE session s SET
           last_seen_at = CASE WHEN s.last_seen_at <= clock_timestamp() - ($3 * interval '1 minute')
             THEN clock_timestamp() ELSE s.last_seen_at END,
           idle_expires_at = CASE WHEN s.last_seen_at <= clock_timestamp() - ($3 * interval '1 minute')
             THEN LEAST(clock_timestamp() + ($2 * interval '1 minute'),s.absolute_expires_at)
             ELSE s.idle_expires_at END
         FROM authorized a WHERE s.id = a.id
           AND s.state = 'active'
           AND s.idle_expires_at > clock_timestamp()
           AND s.absolute_expires_at > clock_timestamp()
         RETURNING s.*
       )
       SELECT s.id,s.family_id,s.principal_kind,s.member_id,s.viewer_id,s.csrf_digest,
              s.secret_digest,m.global_role,s.oidc_authenticated_at,
              COALESCE(jsonb_object_agg(ra.room_id,ra.room_role)
                FILTER (WHERE ra.id IS NOT NULL),'{}'::jsonb) AS room_roles
       FROM renewed s
       LEFT JOIN member m ON m.id = s.member_id AND m.state = 'active'
       LEFT JOIN viewer v ON v.id = s.viewer_id AND v.state = 'active'
       LEFT JOIN room_assignment ra ON ra.member_id = m.id AND ra.state = 'active'
       WHERE ((s.principal_kind = 'member' AND m.id IS NOT NULL)
           OR (s.principal_kind = 'viewer' AND v.id IS NOT NULL))
       GROUP BY s.id,s.family_id,s.principal_kind,s.member_id,s.viewer_id,s.csrf_digest,
                s.secret_digest,s.oidc_authenticated_at,m.id`,
      [digestSecret(secret), policy.idleMinutes, IDLE_RENEWAL_CADENCE_MINUTES],
    );
    const session = result.rows[0];
    if (session === undefined || !constantTimeDigestMatch(secret, session.secret_digest))
      return null;
    let principal: PrincipalIdentity;
    if (session.principal_kind === 'member') {
      if (session.member_id === null || session.global_role === null) return null;
      principal = {
        kind: 'member',
        id: session.member_id,
        globalRole: session.global_role,
        ...(session.oidc_authenticated_at === null
          ? {}
          : { oidcAuthenticatedAt: session.oidc_authenticated_at }),
        roomRoles: parseRoomRoles(session.room_roles),
      };
    } else {
      if (session.viewer_id === null) return null;
      principal = {
        kind: 'viewer',
        id: session.viewer_id,
        sessionId: session.id,
        sessionProof: session.secret_digest,
      };
    }
    return {
      sessionId: session.id,
      familyId: session.family_id,
      csrfDigest: session.csrf_digest,
      principal,
    };
  };
}
