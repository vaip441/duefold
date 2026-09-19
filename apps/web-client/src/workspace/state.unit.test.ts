/**
 * Processing, export, and branding state logic.
 *
 * These cover the decisions that would either offer an action the server refuses
 * or withhold one it permits: a retry after the single manual attempt is spent, a
 * download on an export whose hour has passed, and an accent colour that fails
 * contrast in only one theme.
 */

import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  formatSize,
  presentExport,
  presentProcessing,
  validateAccent,
  validateSupportContact,
} from './state.ts';
import type { ExportRecord, ProcessingVersion } from '../api/client.ts';

function version(overrides: Partial<ProcessingVersion> = {}): ProcessingVersion {
  return {
    documentId: 'd'.repeat(32),
    versionId: 'v'.repeat(32),
    displayTitle: 'Investor model',
    state: 'quarantine',
    failureKind: null,
    failureCode: null,
    manualRetryCount: 0,
    retainedUntil: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function record(overrides: Partial<ExportRecord> = {}): ExportRecord {
  return {
    exportId: 'e'.repeat(32),
    preset: 'room-index-audit',
    includeOriginals: false,
    state: 'ready',
    sizeBytes: 2048,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T01:00:00.000Z',
    consumedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

describe('presentProcessing', () => {
  it('names quarantine as isolation rather than as generic progress', () => {
    const presented = presentProcessing(version({ state: 'quarantine' }));
    expect(presented.label).toBe('processing.state.quarantine');
    expect(presented.help).toBe('processing.state.quarantineHelp');
    expect(presented.canRetry).toBe(false);
  });

  it('offers retry exactly once for a failed conversion', () => {
    // Positive arm: a fresh failure can be retried.
    const first = presentProcessing(
      version({ state: 'processing_failed', manualRetryCount: 0 }),
    );
    expect(first.canRetry).toBe(true);
    expect(first.retryExhausted).toBe(false);

    // Negative arm: the same state with the attempt already spent.
    const spent = presentProcessing(
      version({ state: 'processing_failed', manualRetryCount: 1 }),
    );
    expect(spent.canRetry).toBe(false);
    expect(spent.retryExhausted).toBe(true);
  });

  it('never offers retry for a rejected or malware-quarantined file', () => {
    for (const state of ['rejected', 'malware_quarantined'])
      expect(presentProcessing(version({ state })).canRetry).toBe(false);
  });

  it('states malware plainly and still allows deleting the isolated source', () => {
    const presented = presentProcessing(version({ state: 'malware_quarantined' }));
    expect(presented.label).toBe('processing.state.malware_quarantined');
    expect(presented.tone).toBe('problem');
    expect(presented.canDeleteSource).toBe(true);
  });

  it('maps an unrecognized state to neutral copy rather than leaking the identifier', () => {
    const presented = presentProcessing(version({ state: 'some_future_state' }));
    expect(presented.label).toBe('processing.state.unknown');
    expect(presented.tone).toBe('neutral');
    expect(presented.canRetry).toBe(false);
    expect(presented.canDeleteSource).toBe(false);
  });
});

describe('presentExport', () => {
  const now = new Date('2026-01-01T00:30:00.000Z');

  it('allows a download for a live ready export and refuses one past its hour', () => {
    // Positive arm: inside the hour, unconsumed.
    expect(presentExport(record(), now).canDownload).toBe(true);
    // Negative arm: identical record, clock past the expiry.
    expect(presentExport(record(), new Date('2026-01-01T01:30:00.000Z')).canDownload).toBe(
      false,
    );
  });

  it('refuses a second download once consumed, and says why', () => {
    const consumed = presentExport(
      record({ state: 'consumed', consumedAt: '2026-01-01T00:10:00.000Z' }),
      now,
    );
    expect(consumed.canDownload).toBe(false);
    expect(consumed.consumed).toBe(true);
    expect(consumed.help).toBe('exports.state.consumedHelp');
  });

  it('offers no download while generating or after failure', () => {
    for (const state of ['generating', 'failed', 'deleted', 'expired'])
      expect(presentExport(record({ state }), now).canDownload).toBe(false);
  });
});

describe('formatSize', () => {
  it('scales units and never reports a negative or non-finite size', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2 kB');
    expect(formatSize(5_500_000)).toBe('5.5 MB');
    expect(formatSize(-1)).toBe('—');
    expect(formatSize(Number.NaN)).toBe('—');
  });
});

describe('validateAccent', () => {
  it('accepts a colour readable on both grounds and rejects one that fails either', () => {
    /*
     * Positive arm: a mid-tone accent clears 3:1 against BOTH the light and dark
     * grounds, which is what the server requires.
     *
     * Worth recording: the SHIPPED light accent #006b5e measures 5.78 on the light
     * ground but only 2.73 on the dark one, and Duefold handles that by shipping a
     * separate dark token (#5fc9b4) rather than one colour for both themes. A
     * single operator-chosen brand accent has no such pair, so it must survive
     * both grounds by itself -- which is a real constraint on what an operator can
     * pick, and the reason this check exists at the point of choice.
     */
    expect(validateAccent('#0a7d6d')).toBeNull();
    expect(validateAccent('#2f8f7f')).toBeNull();
    // Near-white fails against the light ground; near-black fails against dark.
    expect(validateAccent('#fefefe')).toBe('contrast');
    expect(validateAccent('#050505')).toBe('contrast');
    // A colour that passes on dark only is still refused.
    expect(validateAccent('#5fc9b4')).toBe('contrast');
  });

  it('rejects a malformed colour distinctly from a contrast failure', () => {
    expect(validateAccent('006b5e')).toBe('format');
    expect(validateAccent('#06b5e')).toBe('format');
    expect(validateAccent('red')).toBe('format');
  });

  it('computes a symmetric contrast ratio against known values', () => {
    const ratio = contrastRatio('#ffffff', '#000000');
    expect(ratio).not.toBeNull();
    expect(ratio ?? 0).toBeCloseTo(21, 0);
    expect(contrastRatio('#000000', '#ffffff') ?? 0).toBeCloseTo(21, 0);
    expect(contrastRatio('nonsense', '#000000')).toBeNull();
  });
});

describe('validateSupportContact', () => {
  it('accepts an email, an https URL, and empty, since the field is optional', () => {
    expect(validateSupportContact('help@example.com')).toBe(true);
    expect(validateSupportContact('https://example.com/support')).toBe(true);
    expect(validateSupportContact('')).toBe(true);
    expect(validateSupportContact('   ')).toBe(true);
  });

  it('rejects hostile schemes and control characters', () => {
    // The value renders on unauthenticated surfaces, so these must never pass.
    for (const hostile of [
      'javascript:alert(1)',
      'data:text/html,<script>',
      'http://example.com',
      'https://user:pass@example.com',
      'help@example.com\nBcc: attacker@example.com',
    ])
      expect(validateSupportContact(hostile), hostile).toBe(false);
  });
});
