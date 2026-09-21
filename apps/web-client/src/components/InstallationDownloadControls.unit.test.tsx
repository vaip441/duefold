import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { InstallationDownloadImpact } from '../api/client.ts';
import { messages } from '../i18n/en.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import type { InstallationSettingsSection } from '../workspace/useInstallationSettings.ts';
import {
  ConfirmationBody,
  isConfirmationUnlocked,
  type ConfirmationContent,
} from './ConfirmationDialog.tsx';
import {
  Consequence,
  confirmationFor,
  InstallationDownloadControls,
} from './InstallationDownloadControls.tsx';

const COUNTS = { inheritingRoomCount: 4, affectedDocumentCount: 12, expectedRevision: 3 };

const ALLOW: InstallationDownloadImpact = {
  ...COUNTS,
  currentPolicy: 'deny',
  proposedPolicy: 'allow',
  requiresFreshAuthentication: true,
  confirmation: 'ALLOW ORIGINAL DOWNLOADS',
};

const DENY: InstallationDownloadImpact = {
  ...COUNTS,
  currentPolicy: 'allow',
  proposedPolicy: 'deny',
  requiresFreshAuthentication: false,
  confirmation: null,
};

const STALE_FAILURE: PresentedFailure = {
  kind: 'fresh-oidc',
  title: 'Sign in again',
  body: 'This change needs a sign-in within the last 15 minutes.',
  offerReload: false,
};

describe('confirmationFor and phrase gating', () => {
  it('asks for the server’s phrase before allowing, and sends what was typed', async () => {
    const finish = vi.fn().mockResolvedValue(null);
    const confirmation = confirmationFor(ALLOW, finish);
    expect(confirmation.phrase).toBe('ALLOW ORIGINAL DOWNLOADS');
    if (confirmation.phrase === null) throw new Error('phrase expected');

    await confirmation.confirm('ALLOW ORIGINAL DOWNLOADS');
    expect(finish).toHaveBeenCalledWith({
      policy: 'allow',
      expectedRevision: 3,
      confirmation: 'ALLOW ORIGINAL DOWNLOADS',
    });
  });

  it('keeps the apply button locked until the exact phrase is typed for allowing', () => {
    const finish = vi.fn().mockResolvedValue(null);
    const confirmation = confirmationFor(ALLOW, finish);
    expect(isConfirmationUnlocked(confirmation, '')).toBe(false);
    expect(isConfirmationUnlocked(confirmation, 'ALLOW ORIGINAL')).toBe(false);
    expect(isConfirmationUnlocked(confirmation, 'allow original downloads')).toBe(false);
    expect(isConfirmationUnlocked(confirmation, 'ALLOW ORIGINAL DOWNLOADS')).toBe(true);
  });

  it('denies on one press, with no phrase, unlocked immediately', async () => {
    const finish = vi.fn().mockResolvedValue(null);
    const confirmation = confirmationFor(DENY, finish);
    expect(confirmation.phrase).toBeNull();
    if (confirmation.phrase !== null) throw new Error('no phrase expected');

    expect(isConfirmationUnlocked(confirmation, '')).toBe(true);
    await confirmation.confirm();
    expect(finish).toHaveBeenCalledWith({ policy: 'deny', expectedRevision: 3 });
  });
});

describe('Consequence component', () => {
  it('states the room and document counts for allowing', () => {
    const markup = renderToStaticMarkup(<Consequence impact={ALLOW} />);
    expect(markup).toContain('4 rooms');
    expect(markup).toContain('12 published documents');
    expect(markup).toContain(messages['installation.download.freshSignIn']);
  });

  it('states the room and document counts for denying, without fresh sign-in notice', () => {
    const markup = renderToStaticMarkup(<Consequence impact={DENY} />);
    expect(markup).toContain('4 rooms');
    expect(markup).toContain('12 published documents');
    expect(markup).not.toContain(messages['installation.download.freshSignIn']);
  });
});

describe('Confirmation dialog body with installation download consequence', () => {
  const noop = (): void => undefined;
  const renderBody = (
    content: ConfirmationContent,
    failure: PresentedFailure | null = null,
    typed = '',
  ) =>
    renderToStaticMarkup(
      <ConfirmationBody
        content={content}
        consequenceId="consequence-test"
        typed={typed}
        pending={false}
        failure={failure}
        onTypedChange={noop}
        onReload={noop}
      />,
    );

  it('states consequence text before the confirmation field when allowing', () => {
    const finish = vi.fn().mockResolvedValue(null);
    const markup = renderBody({
      kind: 'ready',
      consequence: <Consequence impact={ALLOW} />,
      confirmation: confirmationFor(ALLOW, finish),
    });

    const consequenceIndex = markup.indexOf('Viewers will be able to download originals');
    const phraseIndex = markup.indexOf('ALLOW ORIGINAL DOWNLOADS');
    expect(consequenceIndex).toBeGreaterThan(-1);
    expect(phraseIndex).toBeGreaterThan(consequenceIndex);
    expect(markup).toContain('ALLOW ORIGINAL DOWNLOADS');
    expect(markup).toContain('<input');
  });

  it('offers no phrase field when denying', () => {
    const finish = vi.fn().mockResolvedValue(null);
    const markup = renderBody({
      kind: 'ready',
      consequence: <Consequence impact={DENY} />,
      confirmation: confirmationFor(DENY, finish),
    });

    expect(markup).toContain('Original downloads stop in the 4 rooms');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('ALLOW ORIGINAL DOWNLOADS');
  });

  it('surfaces a mismatch error alert when partially typed', () => {
    const finish = vi.fn().mockResolvedValue(null);
    const markup = renderBody(
      {
        kind: 'ready',
        consequence: <Consequence impact={ALLOW} />,
        confirmation: confirmationFor(ALLOW, finish),
      },
      null,
      'ALLOW ORIG',
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain(messages['confirm.mismatch']);
    expect(markup).toContain('aria-invalid="true"');
  });

  it('shows no mismatch error when the exact phrase is typed', () => {
    const finish = vi.fn().mockResolvedValue(null);
    const markup = renderBody(
      {
        kind: 'ready',
        consequence: <Consequence impact={ALLOW} />,
        confirmation: confirmationFor(ALLOW, finish),
      },
      null,
      'ALLOW ORIGINAL DOWNLOADS',
    );

    expect(markup).not.toContain(messages['confirm.mismatch']);
    expect(markup).not.toContain('aria-invalid="true"');
  });

  it('surfaces a stale sign-in refusal as an alert', () => {
    const finish = vi.fn().mockResolvedValue(null);
    const markup = renderBody(
      {
        kind: 'ready',
        consequence: <Consequence impact={ALLOW} />,
        confirmation: confirmationFor(ALLOW, finish),
      },
      STALE_FAILURE,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain(STALE_FAILURE.body);
  });
});

describe('InstallationDownloadControls', () => {
  const section = {
    load: { kind: 'loading' as const },
    failure: null,
    reload: () => undefined,
    reviewDownload: () => Promise.reject(new Error('not called')),
    applyDownload: () => Promise.resolve(null),
  } as InstallationSettingsSection;

  it('names the current default in words and offers only the opposite change (when denied)', () => {
    const markup = renderToStaticMarkup(
      <InstallationDownloadControls
        settings={{ downloadPolicy: 'deny', revision: 3, inheritingRoomCount: 4 }}
        section={section}
        onStatus={() => undefined}
      />,
    );
    expect(markup).toContain(messages['installation.download.denied']);
    expect(markup).toContain(messages['installation.download.allow']);
    expect(markup).not.toContain(messages['installation.download.deny']);
    expect(markup).toContain('4 rooms inherit it now.');
  });

  it('names the current default in words and offers only the opposite change (when allowed)', () => {
    const markup = renderToStaticMarkup(
      <InstallationDownloadControls
        settings={{ downloadPolicy: 'allow', revision: 3, inheritingRoomCount: 2 }}
        section={section}
        onStatus={() => undefined}
      />,
    );
    expect(markup).toContain(messages['installation.download.allowed']);
    expect(markup).toContain(messages['installation.download.deny']);
    expect(markup).not.toContain(messages['installation.download.allow']);
    expect(markup).toContain('2 rooms inherit it now.');
  });
});
