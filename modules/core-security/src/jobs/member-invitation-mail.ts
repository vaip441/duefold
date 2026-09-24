import type { Pool } from 'pg';
import { readMailIdentity, type RequiredMailer } from '../auth/mail.ts';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';

/** Dependencies for required internal onboarding mail. */
export interface MemberInvitationMailDependencies {
  readonly pool: Pool;
  readonly mailer: RequiredMailer;
  readonly publicUrl: string;
}

function field(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{32}$/u.test(value))
    throw new Error('INVALID_JOB_PAYLOAD');
  return value;
}

/**
 * Delivers internal onboarding mail from a lease-gated projection.
 *
 * The payload carries only an opaque invitation id. A worker that no longer
 * holds the exact live lease cannot retrieve the invitee address.
 *
 * Jobs are at-least-once (§22), and mail delivery is an external side effect, so
 * the handler cannot make a send exactly-once. What it does guarantee:
 *
 * 1. The lease is reasserted immediately before the send, so a worker that lost
 *    its lease during the projection read stops before contacting the provider.
 * 2. The send carries an idempotency key derived from the invitation id alone,
 *    identical for every attempt and every reclaiming worker. On Resend that is
 *    a request-level `Idempotency-Key`, which collapses a repeat within the 24
 *    hours Resend documents as the key's retention window; a retry after that
 *    lapses can still deliver a second copy. Generic SMTP has no such facility
 *    at all, so there a crash between provider acceptance and the succeeded
 *    write delivers the mail twice.
 * 3. The mail is therefore made safe to repeat rather than assumed unique. A
 *    repeat is identical to the first: the same authenticated application link,
 *    and no role, room, or other protected detail. It carries no one-time code
 *    and no per-attempt state, so a duplicate is redundant rather than harmful,
 *    and the invitation it announces is unaffected.
 * 4. A revoked or expired invitation yields a row with no address, which is a
 *    deliberate no-op rather than a failure, so a withdrawn invitation cannot
 *    produce a false required-mail failure.
 */
export function createHandler(dependencies: MemberInvitationMailDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const invitationId = field(job.payload, 'invitationId');
    const mail = (
      await dependencies.pool.query<{ email_display: string | null }>(
        'SELECT * FROM read_member_invitation_mail($1,$2,$3,$4)',
        [invitationId, job.id, context.leaseOwner, job.lease_token],
      )
    ).rows[0];
    /* No row means the lease fence itself refused: this worker is not the holder
     * of the live lease and must not learn anything about the invitation. */
    if (mail === undefined) throw new Error('MEMBER_INVITATION_MAIL_FORBIDDEN');
    /* A row with no address means the invitation reached a terminal state before
     * delivery. Sending is now wrong, so completing is the correct outcome. */
    if (mail.email_display === null) return;

    const base = new URL(dependencies.publicUrl);
    base.pathname = '/';
    base.search = '';
    base.hash = '';
    const identity = await readMailIdentity(dependencies.pool);
    await context.assertLease();
    await dependencies.mailer.deliverOnboarding({
      emailDisplay: mail.email_display,
      identity,
      authenticatedLink: base.toString(),
      /* The job's own idempotency key: one invitation is one onboarding mail, so
       * the same value is presented on every attempt. */
      idempotencyKey: `member-invitation:${invitationId}`,
    });
  };
}
