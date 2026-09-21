import type { Pool } from 'pg';
import nodemailer from 'nodemailer';
import type { CompositionManifest } from '@duefold/composition/contract';

export interface OtpMailInput {
  readonly emailDisplay: string;
  readonly code: string;
  readonly challengeId: string;
}
export interface OutboundMail {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly headers?: Readonly<Record<string, string>>;
}
/**
 * Per-request delivery instructions that are not part of the message content.
 *
 * These are transport concerns: a provider that understands them applies them,
 * and one that does not is not told a different story in the message body.
 */
export interface MailDelivery {
  /**
   * Provider request idempotency key for an at-least-once retry of the same
   * mail. Resend accepts it as the `Idempotency-Key` request header on
   * `POST /emails` and returns the original response instead of sending again
   * for the 24 hours it documents as the key's retention window.
   *
   * That suppression is bounded, not permanent: a retry after the window lapses
   * is a new request and can deliver a second copy. Generic SMTP has no
   * equivalent at all, so the SMTP transport ignores this key -- once a remote
   * MTA has returned acceptance there is no request to replay and no way for the
   * client to retract or collapse a later duplicate.
   *
   * Mail carrying this key is therefore still at-least-once. Callers must keep a
   * duplicate harmless rather than assume it cannot happen.
   */
  readonly idempotencyKey?: string;
}
export interface MailTransport {
  send(message: OutboundMail, delivery?: MailDelivery): Promise<void>;
  close(): void;
}
export interface OtpMailer {
  deliver(input: OtpMailInput): Promise<void>;
  close(): void;
}
export interface RequiredMailer extends OtpMailer {
  deliverInvitation(input: {
    readonly emailDisplay: string;
    readonly roomAlias: string;
    readonly authenticatedLink: string;
    readonly occurredAt: Date;
  }): Promise<void>;
  deliverOnboarding(input: {
    readonly emailDisplay: string;
    readonly authenticatedLink: string;
    readonly occurredAt: Date;
    /**
     * See `MailDelivery.idempotencyKey`. It must be identical across attempts
     * for one invitation and must contain no secret, because it travels as a
     * provider request header and may be retained by the provider.
     */
    readonly idempotencyKey: string;
  }): Promise<void>;
  deliverSecurityNotice(input: SecurityNoticeInput): Promise<void>;
}
export const REQUIRED_MAIL_EVENT_CLASSES = [
  'viewer-invitation',
  'internal-onboarding',
] as const;
export const SECURITY_EVENT_CLASSES = [
  ...REQUIRED_MAIL_EVENT_CLASSES,
  'invitation-accepted',
  'original-download',
  'repeated-auth-failures',
  'access-expiry',
  'processing-failure',
  'backup-status-failure',
] as const;
export type SecurityEventClass = (typeof SECURITY_EVENT_CLASSES)[number];

/** Deliberately closed input: sensitive facts cannot be supplied to the renderer. */
export interface SecurityNoticeInput {
  readonly recipient: string;
  readonly roomAlias: string;
  readonly eventClass: SecurityEventClass;
  readonly occurredAt: Date;
  readonly authenticatedLink: string;
}

function authenticatedHttpsLink(raw: string): string {
  const value = new URL(raw);
  if (value.protocol !== 'https:' || value.username !== '' || value.password !== '')
    throw new Error('MAIL_LINK_INVALID');
  return value.toString();
}
function safeLine(value: string, code: string): string {
  if (value === '' || value.length > 200 || /[\r\n\0]/u.test(value)) throw new Error(code);
  return value;
}
/**
 * Bounded to the 1–256 printable characters a Resend `Idempotency-Key` request
 * header accepts. Validated for every adapter, so a malformed key is refused
 * identically under SMTP rather than only where the provider would reject it.
 */
function safeIdempotencyKey(value: string): string {
  if (value === '' || value.length > 256 || /[^\u0021-\u007e]/u.test(value))
    throw new Error('MAIL_IDEMPOTENCY_KEY_INVALID');
  return value;
}
export async function renderRoomSecurityNotice(input: {
  readonly pool: Pool;
  readonly roomId: string;
  readonly eventClass: SecurityEventClass;
  readonly occurredAt: Date;
  readonly authenticatedLink: string;
}): Promise<{ readonly subject: string; readonly text: string }> {
  /* Select only the public alias. Distinctive viewer emails, document titles,
   * source filenames, and object keys may exist in the same room but are not in
   * the result shape and therefore cannot reach the renderer. */
  const row = (
    await input.pool.query<{ room_alias: string }>(
      "SELECT 'ROOM-'||upper(substr(md5(id),1,10)) room_alias FROM room WHERE id=$1",
      [input.roomId],
    )
  ).rows[0];
  if (row === undefined) throw new Error('MAIL_ROOM_UNAVAILABLE');
  return renderSecurityNotice({
    roomAlias: row.room_alias,
    eventClass: input.eventClass,
    occurredAt: input.occurredAt,
    authenticatedLink: input.authenticatedLink,
  });
}

export function renderSecurityNotice(input: Omit<SecurityNoticeInput, 'recipient'>): {
  readonly subject: string;
  readonly text: string;
} {
  const alias = safeLine(input.roomAlias, 'MAIL_ROOM_ALIAS_INVALID');
  if (!SECURITY_EVENT_CLASSES.includes(input.eventClass)) throw new Error('MAIL_EVENT_INVALID');
  if (!Number.isFinite(input.occurredAt.getTime())) throw new Error('MAIL_TIME_INVALID');
  const link = authenticatedHttpsLink(input.authenticatedLink);
  const utc = input.occurredAt.toISOString();
  return {
    subject: `Duefold security event: ${input.eventClass}`,
    text: `Room alias: ${alias}\nEvent class: ${input.eventClass}\nUTC time: ${utc}\nDuefold link: ${link}`,
  };
}

export function createSmtpTransport(input: {
  readonly smtpUrl: string;
  readonly send?: (message: OutboundMail) => Promise<void>;
}): MailTransport {
  if (input.smtpUrl === '') throw new Error('MAIL_SMTP_CONFIG_INVALID');
  if (input.send !== undefined) return { send: input.send, close: () => undefined };
  const transport = nodemailer.createTransport(input.smtpUrl, {
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return {
    /*
     * `MailDelivery` is deliberately unused. SMTP submission offers no
     * request-level idempotency, and inventing a custom message header would
     * claim deduplication that no generic MTA performs, so the at-least-once
     * duplicate risk is left visible instead of being disguised.
     */
    async send(message) {
      await transport.sendMail(message);
    },
    close() {
      transport.close();
    },
  };
}

export function createResendTransport(input: {
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
}): MailTransport {
  if (input.apiKey === '') throw new Error('MAIL_RESEND_CONFIG_INVALID');
  const request = input.fetch ?? globalThis.fetch;
  return {
    async send(message, delivery) {
      const response = await request('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          'content-type': 'application/json',
          /* Resend collapses a repeated request carrying this header for 24
           * hours. It is a request header rather than a body field or message
           * header, so it never reaches the recipient's mailbox. */
          ...(delivery?.idempotencyKey === undefined
            ? {}
            : { 'idempotency-key': delivery.idempotencyKey }),
        },
        body: JSON.stringify(message),
      });
      if (!response.ok) throw new Error('MAIL_DELIVERY_FAILED');
    },
    close: () => undefined,
  };
}

export function createRequiredMailer(input: {
  readonly transport: MailTransport;
  readonly from: string;
}): RequiredMailer {
  const rawFrom = safeLine(input.from, 'MAIL_FROM_INVALID');
  const from = rawFrom.includes('<') ? rawFrom : `Duefold <${rawFrom}>`;
  const sendSecurity = async (
    notice: SecurityNoticeInput,
    delivery?: MailDelivery,
  ): Promise<void> => {
    const rendered = renderSecurityNotice(notice);
    const key = delivery?.idempotencyKey;
    await input.transport.send(
      {
        to: notice.recipient,
        from,
        subject: rendered.subject,
        text: rendered.text,
        headers: { 'X-Duefold-Brand': 'Duefold' },
      },
      key === undefined ? {} : { idempotencyKey: safeIdempotencyKey(key) },
    );
  };
  return {
    async deliver(message) {
      await input.transport.send({
        from,
        to: message.emailDisplay,
        subject: 'Your Duefold sign-in code',
        text: `Your Duefold sign-in code is ${message.code}. It expires in 10 minutes.`,
        headers: { 'X-Duefold-Challenge': message.challengeId, 'X-Duefold-Brand': 'Duefold' },
      });
    },
    deliverInvitation(message) {
      return sendSecurity({
        recipient: message.emailDisplay,
        roomAlias: message.roomAlias,
        eventClass: 'viewer-invitation',
        occurredAt: message.occurredAt,
        authenticatedLink: message.authenticatedLink,
      });
    },
    deliverOnboarding(message) {
      return sendSecurity(
        {
          recipient: message.emailDisplay,
          roomAlias: 'internal',
          eventClass: 'internal-onboarding',
          occurredAt: message.occurredAt,
          authenticatedLink: message.authenticatedLink,
        },
        { idempotencyKey: message.idempotencyKey },
      );
    },
    deliverSecurityNotice: (notice) => sendSecurity(notice),
    close() {
      input.transport.close();
    },
  };
}

export function createConfiguredMailer(input: {
  readonly adapter: CompositionManifest['adapters']['mail'];
  readonly smtpUrl?: string;
  readonly resendApiKey?: string;
  readonly from: string;
  readonly smtpSend?: (message: OutboundMail) => Promise<void>;
  readonly resendFetch?: typeof globalThis.fetch;
}): RequiredMailer {
  const hasSmtp = input.smtpUrl !== undefined && input.smtpUrl !== '';
  const hasResend = input.resendApiKey !== undefined && input.resendApiKey !== '';
  if (hasSmtp === hasResend) throw new Error('MAIL_ADAPTER_SELECTION_INVALID');
  if (input.adapter === 'smtp' && !hasSmtp) throw new Error('MAIL_ADAPTER_SELECTION_INVALID');
  if (input.adapter === 'resend' && !hasResend)
    throw new Error('MAIL_ADAPTER_SELECTION_INVALID');
  return createRequiredMailer({
    from: input.from,
    transport:
      input.adapter === 'smtp'
        ? createSmtpTransport({
            smtpUrl: input.smtpUrl ?? '',
            ...(input.smtpSend ? { send: input.smtpSend } : {}),
          })
        : createResendTransport({
            apiKey: input.resendApiKey ?? '',
            ...(input.resendFetch ? { fetch: input.resendFetch } : {}),
          }),
  });
}

/** Compatibility wrapper for callers composed with SMTP before adapter selection. */
export function createSmtpOtpMailer(input: {
  readonly smtpUrl: string;
  readonly from: string;
}): OtpMailer {
  return createRequiredMailer({
    transport: createSmtpTransport({ smtpUrl: input.smtpUrl }),
    from: input.from,
  });
}
