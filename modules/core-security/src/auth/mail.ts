import type { Pool } from 'pg';
import nodemailer from 'nodemailer';
import type { CompositionManifest } from '@duefold/composition/contract';

/** Who a required mail says it comes from, read from `read_mail_identity()`. */
export interface MailIdentity {
  readonly organizationName: string;
  readonly senderDisplayName: string;
}
export interface OtpMailInput {
  readonly emailDisplay: string;
  readonly code: string;
  readonly challengeId: string;
  readonly identity: MailIdentity;
}
export interface OutboundMail {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
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
    readonly identity: MailIdentity;
    readonly authenticatedLink: string;
  }): Promise<void>;
  deliverOnboarding(input: {
    readonly emailDisplay: string;
    readonly identity: MailIdentity;
    readonly authenticatedLink: string;
    /**
     * See `MailDelivery.idempotencyKey`. It must be identical across attempts
     * for one invitation and must contain no secret, because it travels as a
     * provider request header and may be retained by the provider.
     */
    readonly idempotencyKey: string;
  }): Promise<void>;
  deliverSecurityNotice(input: SecurityNoticeInput): Promise<void>;
}
export const SECURITY_EVENT_CLASSES = [
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
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The display name on `From`, with the configured address kept.
 *
 * The name comes from organization data, so it is refused if it could break the
 * header and quoted so a comma or angle bracket stays part of the name.
 */
export function mailSender(configuredFrom: string, displayName: string): string {
  const from = safeLine(configuredFrom, 'MAIL_FROM_INVALID');
  const address = /<([^<>]+)>\s*$/u.exec(from)?.[1] ?? from;
  const name = safeLine(displayName, 'MAIL_SENDER_INVALID').replace(/["\\]/gu, '\\$&');
  return `"${name}" <${address.trim()}>`;
}

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * One layout for every required mail: a heading, short paragraphs, and at most one
 * action. Inline styles because mail clients drop stylesheets; nothing here is
 * served by the application, so its CSP does not apply.
 */
function renderLayout(input: {
  readonly subject: string;
  readonly organizationName: string;
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly action?: { readonly label: string; readonly href: string };
  readonly code?: string;
  readonly closing: readonly string[];
}): RenderedMail {
  const paragraph = (value: string): string =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#1b211f">${escapeHtml(value)}</p>`;
  const action =
    input.action === undefined
      ? ''
      : `<p style="margin:24px 0"><a href="${escapeHtml(input.action.href)}" style="display:inline-block;padding:12px 20px;background:#006b5e;color:#ffffff;font-weight:600;font-size:16px;text-decoration:none;border-radius:2px">${escapeHtml(input.action.label)}</a></p>` +
        `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:#5a625d">Or paste this link into your browser: ${escapeHtml(input.action.href)}</p>`;
  const code =
    input.code === undefined
      ? ''
      : `<p style="margin:24px 0;font-size:32px;font-weight:600;letter-spacing:0.2em;font-variant-numeric:tabular-nums;color:#1b211f">${escapeHtml(input.code)}</p>`;
  const html =
    '<!doctype html><html><body style="margin:0;padding:0;background:#f2f3f1">' +
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif">' +
    `<p style="margin:0 0 24px;font-size:14px;font-weight:600;color:#5a625d">${escapeHtml(input.organizationName)}</p>` +
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#1b211f;font-family:Georgia,'Times New Roman',serif">${escapeHtml(input.heading)}</h1>` +
    input.paragraphs.map(paragraph).join('') +
    code +
    action +
    `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #c7cdc7">${input.closing
      .map(
        (value) =>
          `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#5a625d">${escapeHtml(value)}</p>`,
      )
      .join('')}</div></div></body></html>`;
  const text = [
    input.heading,
    '',
    ...input.paragraphs.flatMap((value) => [value, '']),
    ...(input.code === undefined ? [] : [input.code, '']),
    ...(input.action === undefined ? [] : [`${input.action.label}: ${input.action.href}`, '']),
    ...input.closing,
  ].join('\n');
  return { subject: input.subject, text, html };
}

/*
 * Required mail names the organization and says what to do next. It carries no room
 * title, document detail, or access scope: the recipient learns those after signing
 * in, and a forwarded or intercepted mail reveals only that an invitation exists.
 */
export function renderViewerInvitation(input: {
  readonly organizationName: string;
  readonly authenticatedLink: string;
}): RenderedMail {
  const organization = safeLine(input.organizationName, 'MAIL_ORGANIZATION_INVALID');
  return renderLayout({
    subject: `${organization} invited you to their document room`,
    organizationName: organization,
    heading: `${organization} has shared documents with you`,
    paragraphs: [
      `You have been invited to read documents in ${organization}'s secure document room.`,
      'Open the room and enter this email address. We will send you a one-time sign-in code, so there is no password to create.',
    ],
    action: {
      label: 'Open the document room',
      href: authenticatedHttpsLink(input.authenticatedLink),
    },
    closing: [
      'If you were not expecting this invitation, you can ignore this email.',
      `Sent on behalf of ${organization} by Duefold.`,
    ],
  });
}

export function renderSignInCode(input: {
  readonly organizationName: string;
  readonly code: string;
}): RenderedMail {
  const organization = safeLine(input.organizationName, 'MAIL_ORGANIZATION_INVALID');
  if (!/^\d{6,10}$/u.test(input.code)) throw new Error('MAIL_CODE_INVALID');
  return renderLayout({
    subject: `Your sign-in code for ${organization}`,
    organizationName: organization,
    heading: 'Your sign-in code',
    paragraphs: [
      `Enter this code on the sign-in page to open ${organization}'s document room. It expires in 10 minutes and works once.`,
    ],
    code: input.code,
    closing: [
      'If you did not try to sign in, you can ignore this email. No one can sign in without this code.',
    ],
  });
}

export function renderMemberOnboarding(input: {
  readonly organizationName: string;
  readonly authenticatedLink: string;
}): RenderedMail {
  const organization = safeLine(input.organizationName, 'MAIL_ORGANIZATION_INVALID');
  return renderLayout({
    subject: `You are invited to join ${organization} on Duefold`,
    organizationName: organization,
    heading: `Join ${organization} on Duefold`,
    paragraphs: [
      `${organization} uses Duefold to prepare and share document rooms. You have been invited to join the team.`,
      'Sign in with your organization account, using this email address.',
    ],
    action: {
      label: 'Sign in to Duefold',
      href: authenticatedHttpsLink(input.authenticatedLink),
    },
    closing: ['If you were not expecting this invitation, you can ignore this email.'],
  });
}

export async function readMailIdentity(pool: Pool): Promise<MailIdentity> {
  const row = (
    await pool.query<{ organization_name: string; sender_display_name: string }>(
      'SELECT * FROM read_mail_identity()',
    )
  ).rows[0];
  if (row === undefined) throw new Error('MAIL_IDENTITY_UNAVAILABLE');
  return {
    organizationName: row.organization_name,
    senderDisplayName: row.sender_display_name,
  };
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
  const securityFrom = rawFrom.includes('<') ? rawFrom : `Duefold <${rawFrom}>`;
  const sendRequired = async (
    to: string,
    identity: MailIdentity,
    rendered: RenderedMail,
    headers: Readonly<Record<string, string>>,
    delivery: MailDelivery = {},
  ): Promise<void> => {
    const key = delivery.idempotencyKey;
    await input.transport.send(
      {
        to,
        from: mailSender(rawFrom, identity.senderDisplayName),
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        headers: { ...headers, 'X-Duefold-Brand': 'Duefold' },
      },
      key === undefined ? {} : { idempotencyKey: safeIdempotencyKey(key) },
    );
  };
  return {
    async deliver(message) {
      await sendRequired(
        message.emailDisplay,
        message.identity,
        renderSignInCode({
          organizationName: message.identity.organizationName,
          code: message.code,
        }),
        { 'X-Duefold-Challenge': message.challengeId },
      );
    },
    deliverInvitation(message) {
      return sendRequired(
        message.emailDisplay,
        message.identity,
        renderViewerInvitation({
          organizationName: message.identity.organizationName,
          authenticatedLink: message.authenticatedLink,
        }),
        {},
      );
    },
    deliverOnboarding(message) {
      return sendRequired(
        message.emailDisplay,
        message.identity,
        renderMemberOnboarding({
          organizationName: message.identity.organizationName,
          authenticatedLink: message.authenticatedLink,
        }),
        {},
        { idempotencyKey: message.idempotencyKey },
      );
    },
    async deliverSecurityNotice(notice) {
      const rendered = renderSecurityNotice(notice);
      await input.transport.send({
        to: notice.recipient,
        from: securityFrom,
        subject: rendered.subject,
        text: rendered.text,
        headers: { 'X-Duefold-Brand': 'Duefold' },
      });
    },
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
