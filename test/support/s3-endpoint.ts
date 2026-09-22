import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { createOpaqueId } from '@duefold/shared/ids';

interface Upload {
  readonly key: string;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly parts: Map<number, { readonly bytes: Buffer; readonly etag: string }>;
}
interface Stored {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly metadata: Readonly<Record<string, string>>;
}
export interface S3TestEndpoint {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  close(): Promise<void>;
}
function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}
function signingKey(secret: string, date: string, region: string): Buffer {
  const dated = hmac(`AWS4${secret}`, date);
  const regional = hmac(dated, region);
  const service = hmac(regional, 's3');
  return hmac(service, 'aws4_request');
}
function canonicalQuery(parameters: URLSearchParams, excludeSignature: boolean): string {
  const values: [string, string][] = [];
  for (const [key, value] of parameters.entries()) {
    if (excludeSignature && key === 'X-Amz-Signature') continue;
    values.push([encodeURIComponent(key), encodeURIComponent(value)]);
  }
  return values
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey)
        return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
      return leftKey < rightKey ? -1 : 1;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}
function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
function presignValid(
  request: IncomingMessage,
  url: URL,
  accessKeyId: string,
  secretAccessKey: string,
): boolean {
  const algorithm = url.searchParams.get('X-Amz-Algorithm');
  const credential = url.searchParams.get('X-Amz-Credential');
  const amzDate = url.searchParams.get('X-Amz-Date');
  const expires = url.searchParams.get('X-Amz-Expires');
  const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders');
  const signature = url.searchParams.get('X-Amz-Signature');
  if (
    algorithm !== 'AWS4-HMAC-SHA256' ||
    credential === null ||
    amzDate === null ||
    expires === null ||
    signedHeaders === null ||
    signature === null
  )
    return false;
  const credentialParts = credential.split('/');
  if (credentialParts.length !== 5 || credentialParts[0] !== accessKeyId) return false;
  const [date, region, service, terminal] = credentialParts.slice(1);
  if (
    date === undefined ||
    region === undefined ||
    service !== 's3' ||
    terminal !== 'aws4_request'
  )
    return false;
  const issued = Date.UTC(
    Number(amzDate.slice(0, 4)),
    Number(amzDate.slice(4, 6)) - 1,
    Number(amzDate.slice(6, 8)),
    Number(amzDate.slice(9, 11)),
    Number(amzDate.slice(11, 13)),
    Number(amzDate.slice(13, 15)),
  );
  const expirySeconds = Number(expires);
  if (
    !Number.isFinite(issued) ||
    !Number.isInteger(expirySeconds) ||
    Date.now() > issued + expirySeconds * 1_000
  )
    return false;
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((name) => {
      const value = name === 'host' ? request.headers.host : header(request, name);
      return `${name}:${value?.trim().replaceAll(/\s+/gu, ' ') ?? ''}\n`;
    })
    .join('');
  const canonicalRequest = [
    request.method ?? '',
    url.pathname,
    canonicalQuery(url.searchParams, true),
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const expected = createHmac('sha256', signingKey(secretAccessKey, date, region))
    .update(stringToSign)
    .digest('hex');
  return safeEqual(expected, signature);
}
function authorizationValid(
  request: IncomingMessage,
  url: URL,
  accessKeyId: string,
  secretAccessKey: string,
): boolean {
  const authorization = header(request, 'authorization');
  const amzDate = header(request, 'x-amz-date');
  const payloadHash = header(request, 'x-amz-content-sha256');
  if (authorization === undefined || amzDate === undefined || payloadHash === undefined)
    return false;
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/u.exec(
      authorization,
    );
  if (match?.[1] !== accessKeyId) return false;
  const scope = match[2];
  const signedHeaders = match[3];
  const signature = match[4];
  if (scope === undefined || signedHeaders === undefined || signature === undefined)
    return false;
  const [date, region, service, terminal] = scope.split('/');
  if (
    date === undefined ||
    region === undefined ||
    service !== 's3' ||
    terminal !== 'aws4_request'
  )
    return false;
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((name) => {
      const value = name === 'host' ? request.headers.host : header(request, name);
      return `${name}:${value?.trim().replaceAll(/\s+/gu, ' ') ?? ''}\n`;
    })
    .join('');
  const canonicalRequest = [
    request.method ?? '',
    url.pathname,
    canonicalQuery(url.searchParams, false),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const expected = createHmac('sha256', signingKey(secretAccessKey, date, region))
    .update(stringToSign)
    .digest('hex');
  return safeEqual(expected, signature);
}
function authorized(
  request: IncomingMessage,
  url: URL,
  accessKeyId: string,
  secret: string,
): boolean {
  if (url.searchParams.has('X-Amz-Signature'))
    return presignValid(request, url, accessKeyId, secret);
  return authorizationValid(request, url, accessKeyId, secret);
}
async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request)
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk));
  return Buffer.concat(chunks);
}
function xml(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, { 'content-type': 'application/xml' });
  response.end(value);
}
function keyFrom(url: URL, bucket: string): string | undefined {
  const prefix = `/${bucket}/`;
  return url.pathname.startsWith(prefix)
    ? decodeURIComponent(url.pathname.slice(prefix.length))
    : undefined;
}

export interface S3TestEndpointOptions {
  /** What `GetBucketVersioning` answers. A bucket with versioning enabled by default. */
  readonly versioning?: 'Enabled' | 'Suspended' | 'absent' | 'not-implemented';
  /**
   * Injects a storage fault before the endpoint answers, so a caller's timeout and retry
   * behaviour can be exercised against something that really does not answer.
   *
   * `stall` accepts the request and never responds; `reset` destroys the socket mid-request.
   * Returning undefined answers normally. The default injects nothing.
   */
  readonly fault?: (request: IncomingMessage) => 'stall' | 'reset' | undefined;
}

export async function startS3TestEndpoint(
  options: S3TestEndpointOptions = {},
): Promise<S3TestEndpoint> {
  const versioning = options.versioning ?? 'Enabled';
  const bucket = 'duefold-test';
  const accessKeyId = 'test-access-key';
  const secretAccessKey = 'test-secret-key-which-is-long-enough';
  const uploads = new Map<string, Upload>();
  const objects = new Map<string, Stored>();
  const server: Server = createServer((request, response) => {
    void (async () => {
      const injected = options.fault?.(request);
      if (injected === 'stall') return;
      if (injected === 'reset') {
        request.destroy();
        response.destroy();
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (!authorized(request, url, accessKeyId, secretAccessKey)) {
        xml(response, 403, '<Error><Code>SignatureDoesNotMatch</Code></Error>');
        return;
      }
      if (request.method === 'GET' && url.searchParams.has('versioning')) {
        if (versioning === 'not-implemented') {
          xml(response, 501, '<Error><Code>NotImplemented</Code></Error>');
          return;
        }
        xml(
          response,
          200,
          versioning === 'absent'
            ? '<VersioningConfiguration></VersioningConfiguration>'
            : `<VersioningConfiguration><Status>${versioning}</Status></VersioningConfiguration>`,
        );
        return;
      }
      const key = keyFrom(url, bucket);
      if (key === undefined) {
        xml(response, 404, '<Error><Code>NoSuchBucket</Code></Error>');
        return;
      }
      if (request.method === 'POST' && url.searchParams.has('uploads')) {
        const uploadId = createOpaqueId();
        const metadata = Object.fromEntries(
          Object.entries(request.headers)
            .filter(
              ([name, value]) => name.startsWith('x-amz-meta-') && typeof value === 'string',
            )
            .map(([name, value]) => [name.slice('x-amz-meta-'.length), value as string]),
        );
        uploads.set(uploadId, {
          key,
          contentType: header(request, 'content-type') ?? 'application/octet-stream',
          metadata,
          parts: new Map(),
        });
        xml(
          response,
          200,
          `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        );
        return;
      }
      const uploadId = url.searchParams.get('uploadId');
      if (request.method === 'PUT' && uploadId !== null) {
        const upload = uploads.get(uploadId);
        const partNumber = Number(url.searchParams.get('partNumber'));
        if (upload?.key !== key || !Number.isInteger(partNumber)) {
          xml(response, 404, '<Error><Code>NoSuchUpload</Code></Error>');
          return;
        }
        const bytes = await body(request);
        const etag = `"${createHash('md5').update(bytes).digest('hex')}"`;
        upload.parts.set(partNumber, { bytes, etag });
        response.writeHead(200, { etag });
        response.end();
        return;
      }
      if (request.method === 'POST' && uploadId !== null) {
        const upload = uploads.get(uploadId);
        if (upload?.key !== key) {
          xml(response, 404, '<Error><Code>NoSuchUpload</Code></Error>');
          return;
        }
        const bytes = Buffer.concat(
          [...upload.parts.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, part]) => part.bytes),
        );
        objects.set(key, { bytes, contentType: upload.contentType, metadata: upload.metadata });
        uploads.delete(uploadId);
        xml(
          response,
          200,
          `<CompleteMultipartUploadResult><Location>private</Location><Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>"${createHash('md5').update(bytes).digest('hex')}"</ETag></CompleteMultipartUploadResult>`,
        );
        return;
      }
      if (request.method === 'DELETE' && uploadId !== null) {
        if (!uploads.delete(uploadId)) {
          xml(response, 404, '<Error><Code>NoSuchUpload</Code></Error>');
          return;
        }
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'PUT' && uploadId === null) {
        if (objects.has(key) && header(request, 'if-none-match') === '*') {
          xml(response, 412, '<Error><Code>PreconditionFailed</Code></Error>');
          return;
        }
        const bytes = await body(request);
        const metadata = Object.fromEntries(
          Object.entries(request.headers)
            .filter(
              ([name, value]) => name.startsWith('x-amz-meta-') && typeof value === 'string',
            )
            .map(([name, value]) => [name.slice('x-amz-meta-'.length), value as string]),
        );
        objects.set(key, {
          bytes,
          contentType: header(request, 'content-type') ?? 'application/octet-stream',
          metadata,
        });
        response.writeHead(200, { etag: `"${createHash('md5').update(bytes).digest('hex')}"` });
        response.end();
        return;
      }
      const object = objects.get(key);
      if (object === undefined) {
        xml(response, 404, '<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      if (request.method === 'HEAD') {
        response.writeHead(200, {
          'content-length': String(object.bytes.length),
          'content-type': object.contentType,
          ...Object.fromEntries(
            Object.entries(object.metadata).map(([name, value]) => [
              `x-amz-meta-${name}`,
              value,
            ]),
          ),
        });
        response.end();
        return;
      }
      if (request.method === 'GET') {
        response.writeHead(200, {
          'content-length': String(object.bytes.length),
          'content-type': object.contentType,
        });
        response.end(object.bytes);
        return;
      }
      if (request.method === 'DELETE') {
        objects.delete(key);
        response.writeHead(204);
        response.end();
        return;
      }
      xml(response, 405, '<Error><Code>MethodNotAllowed</Code></Error>');
    })().catch(() => {
      if (!response.headersSent)
        xml(response, 500, '<Error><Code>InternalError</Code></Error>');
      else response.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('test endpoint address missing');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    bucket,
    accessKeyId,
    secretAccessKey,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}
