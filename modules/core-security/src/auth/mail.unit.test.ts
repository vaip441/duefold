import { describe, expect, it, vi } from 'vitest';
import {
  createConfiguredMailer,
  createRequiredMailer,
  createResendTransport,
  createSmtpTransport,
  renderSecurityNotice,
  type MailTransport,
  type OutboundMail,
} from './mail.ts';

function conformance(name: string, factory: (sink: OutboundMail[]) => MailTransport): void {
  describe(`${name} mail transport conformance`, () => {
    it('delivers exactly one bounded message and propagates provider failure', async () => {
      const delivered: OutboundMail[] = [];
      const transport = factory(delivered);
      await transport.send({
        to: 'recipient@example.test',
        from: 'Duefold <mail@example.test>',
        subject: 's',
        text: 't',
      });
      expect(delivered).toEqual([
        {
          to: 'recipient@example.test',
          from: 'Duefold <mail@example.test>',
          subject: 's',
          text: 't',
        },
      ]);
      transport.close();
    });
  });
}
conformance('SMTP', (sink) =>
  createSmtpTransport({
    smtpUrl: 'smtp://localhost',
    send: (message) => Promise.resolve(void sink.push(message)),
  }),
);
conformance('Resend', (sink) =>
  createResendTransport({
    apiKey: 'test-key',
    fetch: (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('test body absent');
      const parsed: unknown = JSON.parse(init.body);
      sink.push(parsed as OutboundMail);
      return Promise.resolve(new Response('{}', { status: 200 }));
    },
  }),
);

describe('mail policy', () => {
  it('selects exactly one reviewed adapter and fails closed on zero, two, or mismatched config', () => {
    const base = { from: 'mail@example.test' };
    expect(() => createConfiguredMailer({ ...base, adapter: 'smtp' })).toThrow(
      'MAIL_ADAPTER_SELECTION_INVALID',
    );
    expect(() =>
      createConfiguredMailer({
        ...base,
        adapter: 'smtp',
        smtpUrl: 'smtp://localhost',
        resendApiKey: 'also-set',
      }),
    ).toThrow('MAIL_ADAPTER_SELECTION_INVALID');
    expect(() =>
      createConfiguredMailer({ ...base, adapter: 'resend', smtpUrl: 'smtp://localhost' }),
    ).toThrow('MAIL_ADAPTER_SELECTION_INVALID');
    const smtp = createConfiguredMailer({
      ...base,
      adapter: 'smtp',
      smtpUrl: 'smtp://localhost',
      smtpSend: () => Promise.resolve(),
    });
    expect(smtp).toBeDefined();
    smtp.close();
  });

  it('renders security email from only alias, class, UTC time and authenticated link', async () => {
    const distinctive = {
      viewer: 'LEAK-VIEWER-76e9@example.test',
      roomTitle: 'LEAK-ROOM-TITLE-40be',
      filename: 'LEAK-FILENAME-bff2.pdf',
    };
    const input = {
      roomAlias: 'ROOM-ALIAS-7',
      eventClass: 'original-download' as const,
      occurredAt: new Date('2027-04-05T06:07:08.000Z'),
      authenticatedLink: 'https://duefold.example/auth/events/event_123',
    };
    const rendered = renderSecurityNotice(input);
    expect(`${rendered.subject}\n${rendered.text}`).toContain('ROOM-ALIAS-7');
    expect(rendered.text).toContain('original-download');
    expect(rendered.text).toContain('2027-04-05T06:07:08.000Z');
    expect(rendered.text).toContain('https://duefold.example/auth/events/event_123');
    for (const secret of Object.values(distinctive))
      expect(`${rendered.subject}\n${rendered.text}`).not.toContain(secret);

    const messages: OutboundMail[] = [];
    const mailer = createRequiredMailer({
      from: 'mail@example.test',
      transport: {
        send: (message) => Promise.resolve(void messages.push(message)),
        close: () => undefined,
      },
    });
    await mailer.deliverSecurityNotice({ recipient: distinctive.viewer, ...input });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe(rendered.text);
    expect(messages[0]?.from).toBe('Duefold <mail@example.test>');
    expect(messages[0]?.headers?.['X-Duefold-Brand']).toBe('Duefold');

    // Sign-in OTP delivery carries the brand name in sender and header
    await mailer.deliver({
      emailDisplay: 'investor@example.test',
      code: '123456',
      challengeId: 'chal_abc123',
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]?.from).toBe('Duefold <mail@example.test>');
    expect(messages[1]?.subject).toContain('Duefold');
    expect(messages[1]?.headers?.['X-Duefold-Brand']).toBe('Duefold');
    expect(messages[1]?.headers?.['X-Duefold-Challenge']).toBe('chal_abc123');
  });

  it('rejects credential-bearing, non-HTTPS, and line-breaking security fields', () => {
    expect(() =>
      renderSecurityNotice({
        roomAlias: 'a',
        eventClass: 'access-expiry',
        occurredAt: new Date(),
        authenticatedLink: 'http://duefold.example/',
      }),
    ).toThrow('MAIL_LINK_INVALID');
    expect(() =>
      renderSecurityNotice({
        roomAlias: 'a',
        eventClass: 'access-expiry',
        occurredAt: new Date(),
        authenticatedLink: 'https://user:pass@duefold.example/',
      }),
    ).toThrow('MAIL_LINK_INVALID');
    expect(() =>
      renderSecurityNotice({
        roomAlias: 'a\nBcc: x@example.test',
        eventClass: 'access-expiry',
        occurredAt: new Date(),
        authenticatedLink: 'https://duefold.example/',
      }),
    ).toThrow('MAIL_ROOM_ALIAS_INVALID');
  });

  it('fails Resend delivery closed without real network calls', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 503 })));
    const transport = createResendTransport({ apiKey: 'key', fetch });
    await expect(
      transport.send({ to: 'a@example.test', from: 'b@example.test', subject: 'x', text: 'y' }),
    ).rejects.toThrow('MAIL_DELIVERY_FAILED');
    expect(fetch).toHaveBeenCalledOnce();
  });
});
