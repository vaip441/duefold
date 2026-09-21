import { describe, expect, it } from 'vitest';
import {
  migrationStatus,
  presentUpdateObservation,
  type CheckObservation,
} from './deployment-status.ts';

describe('migrationStatus', () => {
  const registry = ['017_b', '001_a', '020_c'];

  it('is current when the ledger is the registry in order', () => {
    expect(migrationStatus(['001_a', '017_b', '020_c'], registry)).toStrictEqual({
      state: 'current',
      appliedCount: 3,
      expectedCount: 3,
      latestApplied: '020_c',
    });
  });

  it('is pending when the ledger is a strict prefix, as when an image is newer than its database', () => {
    expect(migrationStatus(['001_a'], registry)).toMatchObject({
      state: 'pending',
      appliedCount: 1,
      latestApplied: '001_a',
    });
    expect(migrationStatus([], registry)).toMatchObject({
      state: 'pending',
      latestApplied: null,
    });
  });

  it('is unrecognized when the ledger names something this image did not produce', () => {
    expect(migrationStatus(['001_a', '018_x'], registry).state).toBe('unrecognized');
    expect(migrationStatus(['001_a', '017_b', '020_c', '030_z'], registry).state).toBe(
      'unrecognized',
    );
  });
});

describe('presentUpdateObservation', () => {
  const offer: CheckObservation = {
    result: 'attention',
    code: 'UPDATE_AVAILABLE',
    evidenceAt: null,
    evidenceVersion: '1.5.0',
    observedAt: '2026-09-01T00:00:00.000Z',
    stale: false,
  };

  it('keeps an offer of a release newer than the running one', () => {
    expect(presentUpdateObservation(offer, '1.4.0')).toStrictEqual(offer);
  });

  it('reads an offer that has since been installed as current', () => {
    expect(presentUpdateObservation(offer, '1.5.0')).toStrictEqual({
      ...offer,
      result: 'pass',
      code: 'UPDATE_CURRENT',
      evidenceVersion: null,
    });
    expect(
      presentUpdateObservation(
        { ...offer, result: 'fail', code: 'SECURITY_ADVISORY' },
        '1.6.0',
      ),
    ).toMatchObject({ result: 'pass', code: 'UPDATE_CURRENT' });
  });

  it('leaves an observation that offers nothing alone', () => {
    const unverified: CheckObservation = {
      ...offer,
      result: 'fail',
      code: 'UPDATE_MANIFEST_UNVERIFIED',
      evidenceVersion: null,
    };
    expect(presentUpdateObservation(unverified, '9.9.9')).toStrictEqual(unverified);
  });
});
