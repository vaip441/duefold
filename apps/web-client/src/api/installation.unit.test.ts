import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyInstallationDownload,
  loadInstallationSettings,
  reviewInstallationDownload,
  type InstallationDownloadChange,
  type InstallationDownloadImpact,
} from './installation.ts';

function stub(body: unknown, status = 200): void {
  vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ALLOW: InstallationDownloadImpact = {
  currentPolicy: 'deny',
  proposedPolicy: 'allow',
  inheritingRoomCount: 4,
  affectedDocumentCount: 12,
  requiresFreshAuthentication: true,
  expectedRevision: 3,
  confirmation: 'ALLOW ORIGINAL DOWNLOADS',
};

const DENY: InstallationDownloadImpact = {
  currentPolicy: 'allow',
  proposedPolicy: 'deny',
  inheritingRoomCount: 4,
  affectedDocumentCount: 12,
  requiresFreshAuthentication: false,
  expectedRevision: 3,
  confirmation: null,
};

describe('loadInstallationSettings', () => {
  it('reads valid installation settings', async () => {
    stub({ settings: { downloadPolicy: 'deny', revision: 3, inheritingRoomCount: 4 } });
    expect(await loadInstallationSettings()).toStrictEqual({
      downloadPolicy: 'deny',
      revision: 3,
      inheritingRoomCount: 4,
    });
  });

  it('passes abort signal when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          settings: { downloadPolicy: 'allow', revision: 1, inheritingRoomCount: 0 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await loadInstallationSettings(controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/installation',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it.each([
    ['not a record', 'not-a-record'],
    ['missing settings', {}],
    ['settings is not a record', { settings: 'invalid' }],
    ['missing downloadPolicy', { settings: { revision: 1, inheritingRoomCount: 0 } }],
    [
      'unknown downloadPolicy',
      { settings: { downloadPolicy: 'sometimes', revision: 1, inheritingRoomCount: 0 } },
    ],
    ['missing revision', { settings: { downloadPolicy: 'deny', inheritingRoomCount: 0 } }],
    [
      'string revision',
      { settings: { downloadPolicy: 'deny', revision: '1', inheritingRoomCount: 0 } },
    ],
    [
      'fractional revision',
      { settings: { downloadPolicy: 'deny', revision: 1.5, inheritingRoomCount: 0 } },
    ],
    [
      'zero revision',
      { settings: { downloadPolicy: 'deny', revision: 0, inheritingRoomCount: 0 } },
    ],
    [
      'negative revision',
      { settings: { downloadPolicy: 'deny', revision: -1, inheritingRoomCount: 0 } },
    ],
    ['missing inheritingRoomCount', { settings: { downloadPolicy: 'deny', revision: 1 } }],
    [
      'string inheritingRoomCount',
      { settings: { downloadPolicy: 'deny', revision: 1, inheritingRoomCount: '0' } },
    ],
    [
      'fractional inheritingRoomCount',
      { settings: { downloadPolicy: 'deny', revision: 1, inheritingRoomCount: 1.5 } },
    ],
    [
      'negative inheritingRoomCount',
      { settings: { downloadPolicy: 'deny', revision: 1, inheritingRoomCount: -1 } },
    ],
  ])('fails closed on %s', async (_label, body) => {
    stub(body);
    await expect(loadInstallationSettings()).rejects.toMatchObject({
      failure: 'unavailable',
    });
  });
});

describe('reviewInstallationDownload', () => {
  it('reads an allowing review with its phrase, and a denying one without', async () => {
    stub({ impact: ALLOW });
    expect(await reviewInstallationDownload('allow')).toStrictEqual(ALLOW);

    stub({ impact: DENY });
    expect(await reviewInstallationDownload('deny')).toStrictEqual(DENY);
  });

  it.each([
    ['not a record', 'invalid'],
    ['missing impact', {}],
    ['impact is not a record', { impact: 'invalid' }],
    ['an allowing review with no phrase', { ...ALLOW, confirmation: null }],
    ['an allowing review with empty phrase', { ...ALLOW, confirmation: '' }],
    [
      'an allowing review that needs no sign-in',
      { ...ALLOW, requiresFreshAuthentication: false },
    ],
    ['a denying review with a phrase', { ...DENY, confirmation: 'DENY DOWNLOADS' }],
    [
      'a denying review that needs fresh sign-in',
      { ...DENY, requiresFreshAuthentication: true },
    ],
    ['a proposed policy it does not know', { ...ALLOW, proposedPolicy: 'sometimes' }],
    ['a current policy it does not know', { ...ALLOW, currentPolicy: 'sometimes' }],
    ['missing expectedRevision', { ...ALLOW, expectedRevision: undefined }],
    ['fractional expectedRevision', { ...ALLOW, expectedRevision: 2.5 }],
    ['zero expectedRevision', { ...ALLOW, expectedRevision: 0 }],
    ['negative expectedRevision', { ...ALLOW, expectedRevision: -1 }],
    ['missing inheritingRoomCount', { ...ALLOW, inheritingRoomCount: undefined }],
    ['fractional inheritingRoomCount', { ...ALLOW, inheritingRoomCount: 3.5 }],
    ['negative inheritingRoomCount', { ...ALLOW, inheritingRoomCount: -1 }],
    ['missing affectedDocumentCount', { ...ALLOW, affectedDocumentCount: undefined }],
    ['fractional affectedDocumentCount', { ...ALLOW, affectedDocumentCount: 1.5 }],
    ['negative affectedDocumentCount', { ...ALLOW, affectedDocumentCount: -1 }],
    [
      'missing requiresFreshAuthentication',
      { ...ALLOW, requiresFreshAuthentication: undefined },
    ],
    [
      'non-boolean requiresFreshAuthentication',
      { ...ALLOW, requiresFreshAuthentication: 'true' },
    ],
  ])('fails closed on %s', async (_label, impact) => {
    stub({ impact });
    await expect(reviewInstallationDownload('allow')).rejects.toMatchObject({
      failure: 'unavailable',
    });
  });
});

describe('applyInstallationDownload', () => {
  it('sends an allowing change with its phrase and verifies revision', async () => {
    vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ revision: 4 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const change: InstallationDownloadChange = {
      policy: 'allow',
      expectedRevision: 3,
      confirmation: 'ALLOW ORIGINAL DOWNLOADS',
    };
    await applyInstallationDownload(change);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/installation/download-policy',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'apply',
          policy: 'allow',
          expectedRevision: 3,
          confirmation: 'ALLOW ORIGINAL DOWNLOADS',
        }),
      }),
    );
  });

  it('sends a denying change with no confirmation field and verifies revision', async () => {
    vi.stubGlobal('document', { cookie: '__Host-duefold_csrf=token' });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ revision: 4 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const change: InstallationDownloadChange = {
      policy: 'deny',
      expectedRevision: 3,
    };
    await applyInstallationDownload(change);

    const callBody = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(callBody).toStrictEqual({
      action: 'apply',
      policy: 'deny',
      expectedRevision: 3,
    });
    expect('confirmation' in callBody).toBe(false);
  });

  it.each([
    ['not a record', 'invalid'],
    ['missing revision', {}],
    ['fractional revision', { revision: 3.5 }],
    ['zero revision', { revision: 0 }],
    ['negative revision', { revision: -1 }],
  ])('fails closed on malformed response: %s', async (_label, responseBody) => {
    stub(responseBody);
    await expect(
      applyInstallationDownload({ policy: 'deny', expectedRevision: 3 }),
    ).rejects.toMatchObject({
      failure: 'unavailable',
    });
  });
});
