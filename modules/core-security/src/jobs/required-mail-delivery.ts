import type { Pool } from 'pg';
import type { RequiredMailer } from '../auth/mail.ts';
import type { JobContext, LeasedJob } from '../../../../apps/worker/src/runner.ts';

export interface RequiredMailDeliveryDependencies {
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
export function createHandler(dependencies: RequiredMailDeliveryDependencies) {
  return async (job: LeasedJob, context: JobContext): Promise<void> => {
    const invitationId = field(job.payload, 'invitationId');
    const roomId = field(job.payload, 'roomId');
    const mail = (
      await dependencies.pool.query<{
        email_display: string;
        room_alias: string;
        occurred_at: Date;
      }>('SELECT * FROM read_viewer_invitation_mail($1,$2,$3,$4,$5)', [
        invitationId,
        roomId,
        job.id,
        context.leaseOwner,
        job.lease_token,
      ])
    ).rows[0];
    if (mail === undefined) throw new Error('INVITATION_MAIL_FORBIDDEN');
    const base = new URL(dependencies.publicUrl);
    base.pathname = '/read';
    base.search = '';
    base.hash = '';
    await dependencies.mailer.deliverInvitation({
      emailDisplay: mail.email_display,
      roomAlias: mail.room_alias,
      authenticatedLink: base.toString(),
      occurredAt: mail.occurred_at,
    });
  };
}
