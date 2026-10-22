import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Pool, PoolClient } from 'pg';
import type { Clock } from '@duefold/shared/clock';
import { normalizeEmail } from '@duefold/shared/email';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';

export const OTP_DIGITS = 8;
export const OTP_LIFETIME_SECONDS = 600;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_DELIVERY_JOB = 'auth.otp.deliver';

const OTP_LIMITS = {
  perEmailPerHour: 5,
  perNetworkPerHour: 20,
  installationPerHour: 500,
} as const;
export interface CoarseClient {
  readonly browser: 'chromium' | 'firefox' | 'safari' | 'other';
  readonly os: 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'other';
  readonly device: 'desktop' | 'mobile' | 'tablet' | 'other';
}
export interface OtpChallengeResult {
  readonly id: string;
}
export interface AuthenticatedViewer {
  readonly kind: 'viewer';
  readonly id: string;
  readonly familyId: string;
}

export function generateOtp(): string {
  return randomInt(0, 100_000_000).toString().padStart(OTP_DIGITS, '0');
}
export function digestOtp(code: string, key: string): string {
  return createHmac('sha256', key).update(code).digest('hex');
}
export function verifyOtpDigest(code: string, digest: string, key: string): boolean {
  const actual = Buffer.from(digestOtp(code, key), 'hex');
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
/** The network a client address belongs to. IPv6 is keyed by its /64, the smallest block
 * one subscriber is normally given, so rotating addresses within it does not escape the
 * per-network limits; an IPv4-mapped address is keyed as the IPv4 address. */
export function clientNetwork(ip: string): string {
  const trimmed = ip.trim();
  const version = isIP(trimmed);
  if (version === 0) throw new Error('invalid network address');
  if (version === 4) return new URL(`http://${trimmed}`).hostname;
  // URL canonicalizes to lowercase hexadecimal groups, writing an embedded IPv4 in hex.
  const [head = '', tail] = new URL(`http://[${trimmed}]`).hostname.slice(1, -1).split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = [
    ...left,
    ...Array.from({ length: 8 - left.length - right.length }, () => '0'),
    ...right,
  ].map((group) => Number.parseInt(group, 16));
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff)
    return groups
      .slice(6)
      .flatMap((group) => [group >> 8, group & 0xff])
      .join('.');
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}
export function networkCorrelation(
  ip: string,
  now: Date,
  key: string,
): { period: string; hmac: string } {
  const period = now.toISOString().slice(0, 7);
  const hmac = createHmac('sha256', key)
    .update(`${period}\0${clientNetwork(ip)}`)
    .digest('hex');
  return { period, hmac };
}
export function otpUsable(
  challenge: {
    readonly state: string;
    readonly expiresAt: Date | null;
    readonly failedAttempts: number;
  },
  now: Date,
): boolean {
  return (
    challenge.state === 'pending' &&
    challenge.expiresAt !== null &&
    challenge.expiresAt.getTime() > now.getTime() &&
    challenge.failedAttempts < OTP_MAX_ATTEMPTS
  );
}

async function countRecent(
  client: PoolClient,
  column: 'email_key' | 'network_hmac' | null,
  value: string | null,
): Promise<number> {
  const where = column === null ? '' : ` AND ${column} = $1`;
  const values = column === null ? [] : [value];
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM otp_challenge WHERE created_at >= transaction_timestamp() - interval '1 hour'${where}`,
    values,
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** Creates the same non-verifiable row and durable job for every address. */
export async function createOtpChallenge(input: {
  readonly pool: Pool;
  readonly email: string;
  readonly normalizedIp: string;
  readonly digestKey: string;
  readonly networkKey: string;
  readonly client: CoarseClient;
  readonly clock: Clock;
}): Promise<OtpChallengeResult> {
  const normalized = normalizeEmail(input.email);
  const db = await input.pool.connect();
  const now = input.clock.now();
  const network = networkCorrelation(input.normalizedIp, now, input.networkKey);
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock($1)', [1_443_707_501]);
    const prior = await db.query<{ created_at: Date }>(
      "SELECT created_at FROM otp_challenge WHERE email_key = $1 AND state IN ('awaiting_delivery','pending') FOR UPDATE",
      [normalized.comparisonKey],
    );
    const latest = prior.rows[0]?.created_at;
    if (
      latest !== undefined &&
      now.getTime() - latest.getTime() < OTP_RESEND_COOLDOWN_SECONDS * 1_000
    )
      throw new Error('OTP_RESEND_COOLDOWN');
    const emailCount = await countRecent(db, 'email_key', normalized.comparisonKey);
    const networkCount = await countRecent(db, 'network_hmac', network.hmac);
    const installationCount = await countRecent(db, null, null);
    if (
      emailCount >= OTP_LIMITS.perEmailPerHour ||
      networkCount >= OTP_LIMITS.perNetworkPerHour ||
      installationCount >= OTP_LIMITS.installationPerHour
    )
      throw new Error('OTP_RATE_LIMITED');
    await db.query(
      "UPDATE otp_challenge SET state = 'invalidated' WHERE email_key = $1 AND state IN ('awaiting_delivery','pending')",
      [normalized.comparisonKey],
    );
    const eligible = await db.query<{ id: string }>(
      `SELECT v.id FROM viewer v
       WHERE v.email_key = $1 AND v.state = 'active' AND EXISTS (
         SELECT 1 FROM invitation i WHERE i.kind = 'viewer' AND i.email_key = v.email_key
           AND (i.state = 'accepted' OR (i.state = 'pending' AND i.expires_at > transaction_timestamp()))
       ) AND viewer_holds_room_membership(v.id) FOR UPDATE`,
      [normalized.comparisonKey],
    );
    const id = createOpaqueId();
    await db.query(
      `INSERT INTO otp_challenge
       (id,email_key,viewer_id,digest,network_period,network_hmac,browser_category,os_category,device_category,expires_at,created_at)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,NULL,$9)`,
      [
        id,
        normalized.comparisonKey,
        eligible.rows[0]?.id ?? null,
        network.period,
        network.hmac,
        input.client.browser,
        input.client.os,
        input.client.device,
        now,
      ],
    );
    await db.query(
      `SELECT enqueue_job($1,$2,$3,jsonb_build_object('challengeId',$4::text),transaction_timestamp(),5)`,
      [createOpaqueId(), OTP_DELIVERY_JOB, `otp-delivery:${id}`, id],
    );
    await db.query(
      `INSERT INTO audit_event (id,event_type,actor_kind,subject_id,result,reason_code,correlation_id)
       VALUES ($1,'auth.otp','system',$2,'success','OTP_CHALLENGE_CREATED',$3)`,
      [createOpaqueId(), id, createCorrelationId()],
    );
    await db.query('COMMIT');
    return { id };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export async function consumeOtp(input: {
  readonly pool: Pool;
  readonly challengeId: string;
  readonly code: string;
  readonly digestKey: string;
  readonly clock: Clock;
}): Promise<AuthenticatedViewer | null> {
  const db = await input.pool.connect();
  try {
    await db.query('BEGIN');
    const result = await db.query<{
      digest: string | null;
      state: string;
      expires_at: Date | null;
      failed_attempts: number;
      viewer_id: string | null;
      session_family_id: string | null;
    }>(
      `SELECT o.digest,o.state,o.expires_at,o.failed_attempts,o.viewer_id,v.session_family_id
       FROM otp_challenge o LEFT JOIN viewer v ON v.id = o.viewer_id AND v.state = 'active'
       WHERE o.id = $1 FOR UPDATE OF o`,
      [input.challengeId],
    );
    const challenge = result.rows[0];
    const usable =
      challenge !== undefined &&
      otpUsable(
        {
          state: challenge.state,
          expiresAt: challenge.expires_at,
          failedAttempts: challenge.failed_attempts,
        },
        input.clock.now(),
      );
    const digest = challenge?.digest ?? '0'.repeat(64);
    const validDigest = verifyOtpDigest(input.code, digest, input.digestKey);
    const eligiblePrincipal =
      challenge === undefined
        ? null
        : { viewerId: challenge.viewer_id, familyId: challenge.session_family_id };
    const eligibleViewerId = eligiblePrincipal?.viewerId;
    const eligibleFamilyId = eligiblePrincipal?.familyId;
    if (
      !usable ||
      !validDigest ||
      eligibleViewerId === null ||
      eligibleViewerId === undefined ||
      eligibleFamilyId === null ||
      eligibleFamilyId === undefined
    ) {
      /* Every existing challenge records its first OTP_MAX_ATTEMPTS attempts alike, so
         timing cannot tell an invited address from one whose challenge delivery
         invalidated (§8.2), and this public route's writes stay bounded per challenge.
         Only 'pending' may lock: any other transition would raise, itself an oracle. */
      const recorded =
        challenge !== undefined &&
        (
          await db.query(
            `UPDATE otp_challenge SET failed_attempts = failed_attempts + 1,
               state = CASE WHEN state = 'pending' AND failed_attempts + 1 >= $2 THEN 'locked' ELSE state END
             WHERE id = $1 AND failed_attempts < $2`,
            [input.challengeId, OTP_MAX_ATTEMPTS],
          )
        ).rowCount === 1;
      if (!recorded) {
        await db.query('ROLLBACK');
        return null;
      }
      await db.query(
        `INSERT INTO audit_event (id,event_type,actor_kind,subject_id,result,reason_code,correlation_id)
         VALUES ($1,'auth.otp','system',$2,'denied','OTP_INVALID',$3)`,
        [createOpaqueId(), input.challengeId, createCorrelationId()],
      );
      await db.query('COMMIT');
      return null;
    }
    await db.query("UPDATE otp_challenge SET state = 'consumed' WHERE id = $1", [
      input.challengeId,
    ]);
    const correlationId = createCorrelationId();
    await db.query('SELECT accept_viewer_invitation($1,$2,$3)', [
      input.challengeId,
      createOpaqueId(),
      correlationId,
    ]);
    await db.query(
      `INSERT INTO audit_event (id,event_type,actor_kind,actor_id,subject_id,result,reason_code,correlation_id)
       VALUES ($1,'auth.otp','viewer',$2,$3,'success','OTP_ACCEPTED',$4)`,
      [createOpaqueId(), challenge.viewer_id, input.challengeId, correlationId],
    );
    await db.query('COMMIT');
    return {
      kind: 'viewer',
      id: eligibleViewerId,
      familyId: eligibleFamilyId,
    };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
