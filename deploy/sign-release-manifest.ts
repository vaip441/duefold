import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  manifestPayload,
  verifyReleaseManifest,
  type ReleaseManifest,
  type ReleaseManifestPayload,
} from '../apps/cli/src/lifecycle.ts';

export function createSignedManifest(
  payload: ReleaseManifestPayload,
  privateKeyPem: string,
): ReleaseManifest {
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, manifestPayload(payload), privateKey).toString('base64url');
  const manifest: ReleaseManifest = { ...payload, signature };
  verifyReleaseManifest(
    JSON.stringify(manifest),
    createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }),
  );
  return manifest;
}

export async function runSigner(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { values } = parseArgs({
    args: [...arguments_],
    options: {
      version: { type: 'string' },
      'web-digest': { type: 'string' },
      'worker-digest': { type: 'string' },
      'security-advisory': { type: 'boolean', default: false },
      'key-file': { type: 'string' },
      output: { type: 'string', default: 'release-manifest.json' },
    },
    strict: true,
    allowPositionals: false,
  });
  const key =
    values['key-file'] === undefined
      ? (environment['RELEASE_SIGNING_PRIVATE_KEY'] ?? '')
      : await readFile(values['key-file'], 'utf8');
  if (
    values.version === undefined ||
    values['web-digest'] === undefined ||
    values['worker-digest'] === undefined ||
    key === ''
  )
    throw new Error(
      'usage: sign-release-manifest --version <tag> --web-digest <sha256:...> --worker-digest <sha256:...> [--key-file <path>] [--output <file>]',
    );
  const manifest = createSignedManifest(
    {
      version: values.version,
      webImageDigest: values['web-digest'],
      workerImageDigest: values['worker-digest'],
      securityAdvisory: values['security-advisory'],
    },
    key,
  );
  await writeFile(values.output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

if (process.argv[1]?.endsWith('sign-release-manifest.ts'))
  void runSigner(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
