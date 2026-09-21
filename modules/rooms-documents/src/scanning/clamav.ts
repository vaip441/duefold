import { connect } from 'node:net';

export const MAX_SIGNATURE_AGE_MILLISECONDS = 24 * 60 * 60 * 1_000;

/** Whether signatures built at `signatureDate` are young enough to scan with. */
export function signaturesCurrent(
  signatureDate: Date,
  now: Date,
  maximumAgeMilliseconds: number = MAX_SIGNATURE_AGE_MILLISECONDS,
): boolean {
  const age = now.getTime() - signatureDate.getTime();
  return age >= 0 && age <= maximumAgeMilliseconds;
}
export interface ClamAvClientOptions {
  readonly socket: Readonly<{ host: string; port: number }>;
  readonly timeoutMilliseconds: number;
  readonly maximumSignatureAgeMilliseconds?: number;
  readonly now?: () => Date;
}
export interface CleanScan {
  readonly result: 'clean';
  readonly signatureVersion: string;
  readonly signatureDate: Date;
}
export interface MalwareScan {
  readonly result: 'malware';
  readonly signatureVersion: string;
  readonly signatureDate: Date;
}
export type ScanResult = CleanScan | MalwareScan;

function responseLine(bytes: Buffer): string {
  const nul = bytes.indexOf(0);
  const line = bytes.subarray(0, nul < 0 ? bytes.length : nul).toString('utf8');
  if (line.includes('\n') || line.length > 1024) throw new Error('SCANNER_RESPONSE_MALFORMED');
  return line;
}
async function command(options: ClamAvClientOptions, request: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(options.socket);
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === undefined) {
        try {
          resolve(responseLine(Buffer.concat(chunks)));
        } catch (caught) {
          reject(caught instanceof Error ? caught : new Error('SCANNER_RESPONSE_MALFORMED'));
        }
      } else reject(error);
    };
    const timer = setTimeout(() => {
      finish(new Error('SCANNER_TIMEOUT'));
    }, options.timeoutMilliseconds);
    socket.once('error', () => {
      finish(new Error('SCANNER_UNAVAILABLE'));
    });
    socket.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 1024) finish(new Error('SCANNER_RESPONSE_MALFORMED'));
      else chunks.push(chunk);
    });
    socket.once('end', () => {
      finish();
    });
    socket.once('connect', () => socket.end(request));
  });
}
/**
 * Parses a clamd VERSION reply into the signature version and its build date.
 *
 * The separator after the product name is a SPACE, not a slash: clamd answers
 * `ClamAV 1.5.4/28129/Mon Sep 14 06:24:19 2026`. An earlier pattern required
 * `ClamAV/`, which no clamd build emits, so every readiness check and every scan
 * failed closed as SCANNER_RESPONSE_MALFORMED and no upload could be published.
 * The test double reproduced the wrong shape, so the suite agreed with the bug;
 * it now speaks the real format.
 *
 * The slash variant is still accepted, because `clamd --version` and some
 * distribution wrappers print `ClamAV/1.5.4/...`. Accepting both costs nothing,
 * and failing closed on either is an outage.
 */
function version(line: string): { readonly signatureVersion: string; readonly date: Date } {
  const match = /^ClamAV[ /][^/\s]+\/([^/\s]+)\/(.+)$/u.exec(line);
  const signatureVersion = match?.[1];
  const rawDate = match?.[2];
  if (signatureVersion === undefined || rawDate === undefined)
    throw new Error('SCANNER_RESPONSE_MALFORMED');
  const date = new Date(rawDate);
  if (!Number.isFinite(date.getTime())) throw new Error('SCANNER_RESPONSE_MALFORMED');
  return { signatureVersion, date };
}

/** Real ClamAV zINSTREAM protocol client. Scanner errors and stale signatures fail closed. */
export function createClamAvClient(options: ClamAvClientOptions) {
  /** The signatures clamd reports, without judging their age. */
  async function readSignatures(): Promise<{
    readonly signatureVersion: string;
    readonly signatureDate: Date;
  }> {
    const result = version(await command(options, Buffer.from('zVERSION\0')));
    return { signatureVersion: result.signatureVersion, signatureDate: result.date };
  }
  async function checkReady(): Promise<{
    readonly signatureVersion: string;
    readonly signatureDate: Date;
  }> {
    const signatures = await readSignatures();
    const now = (options.now ?? (() => new Date()))();
    if (
      !signaturesCurrent(
        signatures.signatureDate,
        now,
        options.maximumSignatureAgeMilliseconds ?? MAX_SIGNATURE_AGE_MILLISECONDS,
      )
    )
      throw new Error('SCANNER_SIGNATURES_STALE');
    return signatures;
  }
  const scan = async (bytes: Uint8Array): Promise<ScanResult> => {
    const versionResult = await checkReady();
    const parts: Buffer[] = [Buffer.from('zINSTREAM\0')];
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      const chunk = bytes.subarray(offset, offset + 64 * 1024);
      const size = Buffer.alloc(4);
      size.writeUInt32BE(chunk.length);
      parts.push(size, Buffer.from(chunk));
    }
    parts.push(Buffer.alloc(4));
    const result = await command(options, Buffer.concat(parts));
    if (result === 'stream: OK')
      return {
        result: 'clean',
        signatureVersion: versionResult.signatureVersion,
        signatureDate: versionResult.signatureDate,
      };
    if (/^stream: .+ FOUND$/u.test(result))
      return {
        result: 'malware',
        signatureVersion: versionResult.signatureVersion,
        signatureDate: versionResult.signatureDate,
      };
    if (/^stream: .+ ERROR$/u.test(result)) throw new Error('SCANNER_SCAN_ERROR');
    throw new Error('SCANNER_RESPONSE_MALFORMED');
  };
  return { checkReady, readSignatures, scan };
}
export type ClamAvClient = ReturnType<typeof createClamAvClient>;

/** Exported so a test can pin the exact wire format clamd emits, independently of
 * the socket double. A double is free to be wrong; a real reply is not. */
export const parseVersionLineForTesting = version;
