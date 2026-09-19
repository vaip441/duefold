import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSignedManifest, runSigner } from './sign-release-manifest.ts';
import { verifyReleaseManifest } from '../apps/cli/src/lifecycle.ts';

const payload = {
  version: 'v1.0.0',
  webImageDigest: `sha256:${'a'.repeat(64)}`,
  workerImageDigest: `sha256:${'b'.repeat(64)}`,
  securityAdvisory: false,
};

describe('release manifest signer', () => {
  it('signs both image digests with the shared canonical payload', () => {
    const keys = generateKeyPairSync('ed25519');
    const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' });
    const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' });
    expect(
      verifyReleaseManifest(
        JSON.stringify(createSignedManifest(payload, privateKey)),
        publicKey,
      ),
    ).toMatchObject(payload);
  });

  it('requires signing key and both digests, and rejects unknown options', async () => {
    await expect(runSigner(['--version', 'v1.0.0'], {})).rejects.toThrow('usage:');
    await expect(runSigner(['--unknown'], {})).rejects.toThrow();
  });

  it('supports an explicit key file and output path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'duefold-signer-'));
    try {
      const keys = generateKeyPairSync('ed25519');
      const keyPath = join(directory, 'key.pem');
      const outputPath = join(directory, 'manifest.json');
      await writeFile(keyPath, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }));
      await runSigner([
        '--version',
        payload.version,
        '--web-digest',
        payload.webImageDigest,
        '--worker-digest',
        payload.workerImageDigest,
        '--key-file',
        keyPath,
        '--output',
        outputPath,
      ]);
      const manifest = JSON.parse(await readFile(outputPath, 'utf8')) as Record<
        string,
        unknown
      >;
      expect(manifest['webImageDigest']).toBe(payload.webImageDigest);
      expect(manifest['workerImageDigest']).toBe(payload.workerImageDigest);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
