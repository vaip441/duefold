import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deploymentPlan,
  restoreDrillOutcome,
  updateObservation,
  verifyReleaseManifest,
} from './lifecycle.ts';
import { viewerEvidenceReference } from '../../../modules/rooms-documents/src/jobs/room-purge.ts';

describe('CLI lifecycle pure contracts', () => {
  it('derives stable room-scoped references from independent worker-only key material', () => {
    const key = Buffer.alloc(32, 7).toString('base64url');
    const room = 'R'.repeat(32);
    const viewer = 'V'.repeat(32);
    const first = viewerEvidenceReference({ key, roomId: room, viewerId: viewer });
    expect(first).toMatch(/^vref_[a-f0-9]{64}$/u);
    expect(viewerEvidenceReference({ key, roomId: room, viewerId: viewer })).toBe(first);
    expect(viewerEvidenceReference({ key, roomId: 'S'.repeat(32), viewerId: viewer })).not.toBe(
      first,
    );
    expect(
      viewerEvidenceReference({
        key: Buffer.alloc(32, 8).toString('base64url'),
        roomId: room,
        viewerId: viewer,
      }),
    ).not.toBe(first);
  });

  it('never treats an undetermined or failed executed restore check as passed', () => {
    expect(restoreDrillOutcome([{ status: 'passed', detail: 'executed' }])).toBe('passed');
    expect(
      restoreDrillOutcome([
        { status: 'passed', detail: 'executed' },
        { status: 'undetermined', detail: 'provider unavailable' },
      ]),
    ).toBe('undetermined');
    expect(
      restoreDrillOutcome([
        { status: 'undetermined', detail: 'provider unavailable' },
        { status: 'failed', detail: 'authorization isolation failed' },
      ]),
    ).toBe('failed');
  });

  it('verifies an offline signed release manifest and refuses mutation', () => {
    const keys = generateKeyPairSync('ed25519');
    const payload = {
      version: '1.0.1',
      webImageDigest: `sha256:${'a'.repeat(64)}`,
      workerImageDigest: `sha256:${'b'.repeat(64)}`,
      securityAdvisory: false,
    };
    const signature = sign(
      null,
      Buffer.from(JSON.stringify(payload)),
      keys.privateKey,
    ).toString('base64url');
    const raw = JSON.stringify({ ...payload, signature });
    expect(
      verifyReleaseManifest(raw, keys.publicKey.export({ format: 'pem', type: 'spki' })),
    ).toMatchObject(payload);
    expect(() =>
      verifyReleaseManifest(
        JSON.stringify({ ...payload, version: '1.0.2', signature }),
        keys.publicKey.export({ format: 'pem', type: 'spki' }),
      ),
    ).toThrow('UPDATE_MANIFEST_SIGNATURE_INVALID');
  });

  it('ships the Ed25519 release public key where the upgrade guide points', () => {
    // docs/self-hosting.md verifies releases against this path inside the image.
    const key = createPublicKey(
      readFileSync(new URL('../release-signing-public.pem', import.meta.url), 'utf8'),
    );
    expect(key.asymmetricKeyType).toBe('ed25519');
  });
  it('emits plans rather than claiming upgrade or recovery success', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    const plan = deploymentPlan('upgrade', digest);
    expect(plan['action']).toBe('upgrade');
    expect(plan['operatorInitiated']).toBe(true);
    expect(plan['claim']).toBe(
      'This is an operator plan, not evidence that an upgrade, rollback, or recovery succeeded.',
    );
    expect(deploymentPlan('rollback', digest)).toMatchObject({ action: 'rollback' });
    expect(() => deploymentPlan('upgrade', 'latest')).toThrow('TARGET_DIGEST_INVALID');
  });
});

describe('updateObservation', () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' });
  const signed = (version: string, securityAdvisory = false): string => {
    const payload = {
      version,
      webImageDigest: `sha256:${'a'.repeat(64)}`,
      workerImageDigest: `sha256:${'b'.repeat(64)}`,
      securityAdvisory,
    };
    const signature = sign(
      null,
      Buffer.from(JSON.stringify(payload)),
      keys.privateKey,
    ).toString('base64url');
    return JSON.stringify({ ...payload, signature });
  };

  it('is current when the manifest offers this release or an older one', () => {
    expect(updateObservation(signed('1.4.0'), publicKey, '1.4.0')).toStrictEqual({
      code: 'UPDATE_CURRENT',
      offeredVersion: null,
    });
    expect(updateObservation(signed('1.3.9'), publicKey, '1.4.0').code).toBe('UPDATE_CURRENT');
  });

  it('names a newer release', () => {
    expect(updateObservation(signed('1.5.0'), publicKey, '1.4.0')).toStrictEqual({
      code: 'UPDATE_AVAILABLE',
      offeredVersion: '1.5.0',
    });
  });

  it('marks a newer release that carries a security advisory', () => {
    expect(updateObservation(signed('1.5.0', true), publicKey, '1.4.0')).toStrictEqual({
      code: 'SECURITY_ADVISORY',
      offeredVersion: '1.5.0',
    });
  });

  it('records a tampered or unreadable manifest as unverified rather than trusting it', () => {
    const original = JSON.parse(signed('1.5.0')) as Record<string, unknown>;
    const tampered = JSON.stringify({ ...original, version: '9.0.0' });
    expect(updateObservation(tampered, publicKey, '1.4.0')).toStrictEqual({
      code: 'UPDATE_MANIFEST_UNVERIFIED',
      offeredVersion: null,
    });
    expect(updateObservation('not a manifest', publicKey, '1.4.0').code).toBe(
      'UPDATE_MANIFEST_UNVERIFIED',
    );
  });

  it('does not order a release it cannot read', () => {
    expect(updateObservation(signed('2.0.0-rc.1'), publicKey, '1.4.0')).toStrictEqual({
      code: 'UPDATE_VERSION_UNRECOGNIZED',
      offeredVersion: null,
    });
  });
});
