import { describe, expect, it } from 'vitest';
import { normalizeSafeHttpsLink } from './safe-links.ts';
import { parseSingleRange } from './downloads.ts';
import {
  monthlyNetworkCorrelation,
  composeWatermarkPage,
  parseTextLayerForTesting,
} from './protected-delivery.ts';
import { sandboxProgram } from './processing/sandbox.ts';
import { fileURLToPath } from 'node:url';

describe('protected delivery security normalization', () => {
  it('composites watermark identity in the credential-free sandbox boundary', async () => {
    const fixture = fileURLToPath(
      new URL('../../../test/fixtures/processors/watermark-fixture.mjs', import.meta.url),
    );
    const output = await composeWatermarkPage({
      program: sandboxProgram(process.execPath, [fixture]),
      source: Buffer.from('image-bytes'),
      viewerEmail: 'viewer@example.com',
      accessDateUtc: '2026-03-01',
      roomName: 'Published room',
    });
    expect(Buffer.from(output).toString('utf8')).toBe(
      'image-bytes\nviewer@example.com|2026-03-01|Published room',
    );
  });
  it('accepts legitimate international HTTPS domains and binds display to navigation', () => {
    const link = normalizeSafeHttpsLink('https://münchen.example/Größe?q=1');
    expect(link).toEqual({
      interstitialPath:
        '/api/viewer/links/interstitial?target=https%3A%2F%2Fxn--mnchen-3ya.example%2FGr%25C3%25B6%25C3%259Fe%3Fq%3D1',
      normalizedDomain: 'münchen.example',
    });
    const target = new URL(`https://duefold.example${link?.interstitialPath}`).searchParams.get(
      'target',
    );
    expect(new URL(target ?? '').hostname).toBe('xn--mnchen-3ya.example');
  });
  it.each([
    'https://evil.example@good.example/',
    'https://user:secret@good.example/',
    'https://аpple.example/',
    'https://xn--pple-43d.example/',
    'https://good.example/\u0000evil',
    'https://good.example/\nevil',
    'https://good.example/ path',
    'http://good.example/',
    'javascript:alert(1)',
    'data:text/html,evil',
  ])('keeps structurally unsafe external link inert: %s', (value) => {
    expect(normalizeSafeHttpsLink(value)).toBeUndefined();
  });
  it('canonicalizes case from the exact navigated host', () => {
    expect(normalizeSafeHttpsLink('HTTPS://MÜNCHEN.EXAMPLE/path')).toEqual({
      interstitialPath:
        '/api/viewer/links/interstitial?target=https%3A%2F%2Fxn--mnchen-3ya.example%2Fpath',
      normalizedDomain: 'münchen.example',
    });
  });
  it('keeps legitimate multi-script positional text intact while unsafe markup stays inert', () => {
    const legitimate = [
      '財務報告：売上高、利益。',
      'تقرير مالي — الإيرادات والأرباح',
      'Re\u0301sume\u0301; “ordinary” punctuation… €42',
      'עברית: הכנסות ורווחים',
    ];
    const layer = legitimate.map((text, index) => ({
      text,
      x: index,
      y: index,
      width: 100,
      height: 20,
    }));
    expect(parseTextLayerForTesting(layer).map((item) => item.text)).toEqual(legitimate);
    for (const unsafe of ['<script>alert(1)</script>', '<img src=x>', '<video>'])
      expect(
        parseTextLayerForTesting([{ text: unsafe, x: 0, y: 0, width: 1, height: 1 }]),
      ).toEqual([]);
  });
  it('accepts only one bounded explicit byte range', () => {
    expect(parseSingleRange('bytes=0-9', 10)).toEqual({ start: 0, endInclusive: 9 });
    for (const value of [
      undefined,
      'bytes=-5',
      'bytes=0-',
      'bytes=0-1,4-5',
      'bytes=9-10',
      'bytes=2-1',
    ])
      expect(() => parseSingleRange(value, 10)).toThrow();
  });
  it('rotates network correlation across month boundaries without storing key material', () => {
    const first = monthlyNetworkCorrelation({
      ip: '2001:db8::1',
      periodDate: new Date('2026-01-31T23:59:59Z'),
      rootKey: 'root-secret-that-is-not-stored',
    });
    const second = monthlyNetworkCorrelation({
      ip: '2001:0db8:0:0:0:0:0:1',
      periodDate: new Date('2026-02-01T00:00:00Z'),
      rootKey: 'root-secret-that-is-not-stored',
    });
    expect(first.period).toBe('2026-01');
    expect(second.period).toBe('2026-02');
    expect(first.hmac).not.toBe(second.hmac);
    expect(JSON.stringify([first, second])).not.toContain('root-secret');
  });
});
