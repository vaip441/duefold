import { describe, expect, it } from 'vitest';
import { normalizeSafeHttpsLink } from './safe-links.ts';
import { parseSingleRange } from './downloads.ts';
import {
  monthlyNetworkCorrelation,
  composeWatermarkPage,
  parseTextLayer,
} from './protected-delivery.ts';
import { sandboxProgram, type SandboxProgram } from './processing/sandbox.ts';
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
  it('runs at most two watermark compositions at once and queues the rest', async () => {
    const program = sandboxProgram(process.execPath, [
      '-e',
      'const start=Date.now();setTimeout(()=>process.stdout.write(start+","+Date.now()),300)',
    ]);
    const intervals = (
      await Promise.all(
        Array.from({ length: 6 }, () =>
          composeWatermarkPage({
            program,
            source: Buffer.from('image-bytes'),
            viewerEmail: 'viewer@example.com',
            accessDateUtc: '2026-03-01',
            roomName: 'Published room',
          }),
        ),
      )
    ).map((output) => Buffer.from(output).toString('utf8').split(',').map(Number));
    const overlapping = intervals.map(
      ([start = 0]) =>
        intervals.filter(([from = 0, to = 0]) => from <= start && start < to).length,
    );
    expect(Math.max(...overlapping)).toBe(2);
  });
  it('gives a failed composition slot to the next queued page', async () => {
    const page = (program: SandboxProgram) =>
      composeWatermarkPage({
        program,
        source: Buffer.from('image-bytes'),
        viewerEmail: 'viewer@example.com',
        accessDateUtc: '2026-03-01',
        roomName: 'Published room',
      });
    const failing = sandboxProgram(process.execPath, ['-e', 'process.exit(1)']);
    await Promise.all([
      expect(page(failing)).rejects.toThrow('SANDBOX_CHILD_FAILED'),
      expect(page(failing)).rejects.toThrow('SANDBOX_CHILD_FAILED'),
    ]);
    // A leaked slot leaves this page queued forever, so the test timeout fails it.
    await expect(
      page(sandboxProgram(process.execPath, ['-e', 'process.stdout.write("composed")'])),
    ).resolves.toEqual(Buffer.from('composed'));
  });
  it('accepts legitimate international HTTPS domains and binds display to navigation', () => {
    const link = normalizeSafeHttpsLink('https://münchen.example/Größe?q=1');
    expect(link).toEqual({
      href: 'https://xn--mnchen-3ya.example/Gr%C3%B6%C3%9Fe?q=1',
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
      href: 'https://xn--mnchen-3ya.example/path',
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
    expect(parseTextLayer(layer).map((item) => item.text)).toEqual(legitimate);
    for (const unsafe of ['<script>alert(1)</script>', '<img src=x>', '<video>'])
      expect(parseTextLayer([{ text: unsafe, x: 0, y: 0, width: 1, height: 1 }])).toEqual([]);
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
