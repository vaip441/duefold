import { describe, expect, it, vi } from 'vitest';
import {
  createConfiguredMailer,
  createRequiredMailer,
  createResendTransport,
  createSmtpTransport,
  mailSender,
  renderSecurityNotice,
  renderViewerInvitation,
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

    await mailer.deliver({
      emailDisplay: 'investor@example.test',
      code: '12345678',
      challengeId: 'chal_abc123',
      identity: { organizationName: 'Northwind Capital', senderDisplayName: 'Northwind IR' },
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]?.from).toBe('"Northwind IR" <mail@example.test>');
    expect(messages[1]?.subject).toBe('Your sign-in code for Northwind Capital');
    expect(messages[1]?.text).toContain('12345678');
    expect(messages[1]?.html).toContain('12345678');
    expect(messages[1]?.headers?.['X-Duefold-Challenge']).toBe('chal_abc123');
  });

  it('invites a viewer by organization name, with no room or document detail', () => {
    const rendered = renderViewerInvitation({
      organizationName: 'Northwind Capital',
      authenticatedLink: 'https://duefold.example/read',
    });
    expect(rendered.subject).toBe('Northwind Capital invited you to their document room');
    expect(rendered.text).toContain('https://duefold.example/read');
    expect(rendered.text).toContain('one-time sign-in code');
    expect(rendered.html).toContain('href="https://duefold.example/read"');
    expect(`${rendered.subject}${rendered.text}`).not.toMatch(/ROOM-|security event/u);
  });

  it('escapes organization data in HTML and refuses it where it could split a header', () => {
    const rendered = renderViewerInvitation({
      organizationName: '<script>alert(1)</script> & Co',
      authenticatedLink: 'https://duefold.example/read',
    });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
    expect(() =>
      renderViewerInvitation({
        organizationName: 'North\nBcc: x@example.test',
        authenticatedLink: 'https://duefold.example/read',
      }),
    ).toThrow('MAIL_ORGANIZATION_INVALID');
  });

  it('quotes the sender name and keeps the configured address', () => {
    expect(mailSender('Duefold <no-reply@example.test>', 'Northwind, "IR"')).toBe(
      '"Northwind, \\"IR\\"" <no-reply@example.test>',
    );
    expect(mailSender('no-reply@example.test', 'Northwind')).toBe(
      '"Northwind" <no-reply@example.test>',
    );
    expect(() => mailSender('no-reply@example.test', 'North\r\nBcc: x@example.test')).toThrow(
      'MAIL_SENDER_INVALID',
    );
  });

  it('carries an onboarding idempotency key as a Resend request header, not in the message', async () => {
    const requests: { readonly headers: Record<string, string>; readonly body: string }[] = [];
    const transport = createResendTransport({
      apiKey: 'test-key',
      fetch: (_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('test body absent');
        requests.push({
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          body: init.body,
        });
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });
    const mailer = createRequiredMailer({ from: 'mail@example.test', transport });
    /* Onboarding mail is at-least-once. Resend returns the original result for a
     * repeated request carrying this key within the 24 hours it retains the key,
     * so a prompt reclaim does not mail the invitee twice. Suppression ends with
     * that window; test/integration/member-invitation-mail.test.ts covers both
     * sides of the bound. */
    const identity = { organizationName: 'Northwind Capital', senderDisplayName: 'Northwind' };
    await mailer.deliverOnboarding({
      emailDisplay: 'joiner@example.test',
      identity,
      authenticatedLink: 'https://duefold.example/',
      idempotencyKey: 'member-invitation:abc',
    });
    expect(requests[0]?.headers['idempotency-key']).toBe('member-invitation:abc');
    /* The key is provider request metadata. It must not reach the recipient's
     * mailbox as a message header, and it must not be mistaken for content. */
    const sent: unknown = JSON.parse(requests[0]?.body ?? 'null');
    /* A repeat of this message is tolerated because it discloses nothing beyond the
     * organization and the application link: no role, no room, no one-time code. */
    expect(sent).toMatchObject({
      to: 'joiner@example.test',
      from: '"Northwind" <mail@example.test>',
      subject: 'You are invited to join Northwind Capital on Duefold',
      headers: { 'X-Duefold-Brand': 'Duefold' },
    });
    expect(JSON.stringify(sent)).not.toContain('member-invitation:abc');

    /* Viewer invitation mail supplies no key, so no idempotency header is sent at
     * all rather than an empty or invented one. */
    await mailer.deliverInvitation({
      emailDisplay: 'viewer@example.test',
      identity,
      authenticatedLink: 'https://duefold.example/read',
    });
    expect(requests[1]?.headers).not.toHaveProperty('idempotency-key');
  });

  /*
   * SMTP submission has no request-level idempotency, so the transport adds
   * nothing: no custom header may imply deduplication that no generic MTA
   * performs. Onboarding mail is byte-identical to the same mail sent without a
   * key, which is what makes a duplicate redundant rather than harmful.
   */
  it('adds no deduplication header to SMTP onboarding mail', async () => {
    const messages: OutboundMail[] = [];
    const mailer = createRequiredMailer({
      from: 'mail@example.test',
      transport: createSmtpTransport({
        smtpUrl: 'smtp://localhost',
        send: (message) => Promise.resolve(void messages.push(message)),
      }),
    });
    await mailer.deliverOnboarding({
      emailDisplay: 'joiner@example.test',
      identity: { organizationName: 'Northwind Capital', senderDisplayName: 'Northwind' },
      authenticatedLink: 'https://duefold.example/',
      idempotencyKey: 'member-invitation:abc',
    });
    expect(messages[0]?.headers).toEqual({ 'X-Duefold-Brand': 'Duefold' });
    expect(JSON.stringify(messages[0])).not.toContain('member-invitation:abc');
  });

  it('rejects an idempotency key the provider contract cannot carry', async () => {
    const mailer = createRequiredMailer({
      from: 'mail@example.test',
      transport: { send: () => Promise.resolve(), close: () => undefined },
    });
    const onboarding = {
      emailDisplay: 'joiner@example.test',
      identity: { organizationName: 'Northwind Capital', senderDisplayName: 'Northwind' },
      authenticatedLink: 'https://duefold.example/',
    };
    /* A header-splitting key must fail here rather than be handed to `fetch`, and
     * it must fail identically under SMTP, where nothing would reject it. */
    await expect(
      mailer.deliverOnboarding({ ...onboarding, idempotencyKey: 'ok\nBcc: attacker@x.test' }),
    ).rejects.toThrow('MAIL_IDEMPOTENCY_KEY_INVALID');
    await expect(
      mailer.deliverOnboarding({ ...onboarding, idempotencyKey: 'a'.repeat(257) }),
    ).rejects.toThrow('MAIL_IDEMPOTENCY_KEY_INVALID');
    await expect(
      mailer.deliverOnboarding({ ...onboarding, idempotencyKey: '' }),
    ).rejects.toThrow('MAIL_IDEMPOTENCY_KEY_INVALID');
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
