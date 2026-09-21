import { describe, expect, it } from 'vitest';
import { scannerObservation } from './status-observe.ts';

const now = new Date('2026-09-21T12:00:00Z');
const reporting = (signatureDate: Date) => ({
  readSignatures: () => Promise.resolve({ signatureVersion: '28129', signatureDate }),
});

describe('scannerObservation', () => {
  it('reports current signatures with their build time', async () => {
    const built = new Date('2026-09-21T06:00:00Z');
    expect(await scannerObservation(reporting(built), now)).toStrictEqual({
      check: 'scanner',
      code: 'SIGNATURES_CURRENT',
      signaturesBuiltAt: built,
    });
  });

  it('reports signatures older than a day as stale, and keeps the build time', async () => {
    const built = new Date('2026-09-19T12:00:00Z');
    expect(await scannerObservation(reporting(built), now)).toStrictEqual({
      check: 'scanner',
      code: 'SIGNATURES_STALE',
      signaturesBuiltAt: built,
    });
  });

  it('treats a build time in the future as stale, as scanning does', async () => {
    const built = new Date('2026-09-21T13:00:00Z');
    expect((await scannerObservation(reporting(built), now)).code).toBe('SIGNATURES_STALE');
  });

  it('reports a scanner it could not ask without inventing a build time', async () => {
    expect(
      await scannerObservation(
        { readSignatures: () => Promise.reject(new Error('ECONNREFUSED')) },
        now,
      ),
    ).toStrictEqual({ check: 'scanner', code: 'SCANNER_UNAVAILABLE', signaturesBuiltAt: null });
  });
});
