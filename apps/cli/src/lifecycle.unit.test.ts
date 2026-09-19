import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deploymentPlan, restoreDrillOutcome, verifyReleaseManifest } from './lifecycle.ts';
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
