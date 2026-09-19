import type { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { MemberIdentity } from '../../core-security/src/authorization.ts';
import { hasFreshOidc } from '../../core-security/src/authorization.ts';

export type ExportPreset = 'room-index-audit' | 'participant-access' | 'selected-documents';
export interface ExportPreflight {
  readonly piiCategories: readonly string[];
  readonly fileCount: number;
  readonly estimatedSize: number;
  readonly retentionEffect: string;
  readonly originalsIncluded: boolean;
}
export interface ExportStorage {
  streamSource(key: string): Promise<AsyncIterable<Uint8Array>>;
  putStream(input: {
    readonly key: string;
    readonly stream: AsyncIterable<Uint8Array>;
    readonly contentType: 'application/json' | 'application/zip';
  }): Promise<number>;
  streamExport(key: string, size: number): Promise<AsyncIterable<Uint8Array>>;
  delete(key: string): Promise<void>;
}
function selection(preset: ExportPreset, selectedDocumentIds: readonly string[]): string[] {
  if (preset === 'selected-documents') {
    if (selectedDocumentIds.length < 1 || selectedDocumentIds.length > 1_000)
      throw new Error('EXPORT_SELECTION_INVALID');
  } else if (selectedDocumentIds.length !== 0) throw new Error('EXPORT_SELECTION_INVALID');
  return [...selectedDocumentIds];
}
function crc32Update(crc: number, bytes: Uint8Array): number {
  let next = crc;
  for (const value of bytes) {
    next ^= value;
    for (let bit = 0; bit < 8; bit += 1)
      next = (next & 1) === 0 ? next >>> 1 : 0xedb88320 ^ (next >>> 1);
  }
  return next;
}
export interface ZipEntry {
  readonly name: string;
  /*
   * A FACTORY, not an open stream. Awaiting storage.streamSource while building
   * the entry list opened every source before the archive consumed the first --
   * up to the 1,000-document selection limit of concurrent provider response
   * bodies, exhausting sockets and provider concurrency even though no bytes were
   * buffered. The factory is invoked only when that entry is reached, so exactly
   * one source is open at a time.
   */
  readonly open: () => Promise<AsyncIterable<Uint8Array>> | AsyncIterable<Uint8Array>;
}
function one(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (sent) return Promise.resolve({ done: true, value: undefined });
          sent = true;
          return Promise.resolve({ done: false, value: bytes });
        },
      };
    },
  };
}
export async function* streamingZip(entries: readonly ZipEntry[]): AsyncGenerator<Uint8Array> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length < 1 || name.length > 255 || /[\\/\0]/u.test(entry.name))
      throw new Error('EXPORT_ZIP_NAME_INVALID');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0808, 6); // UTF-8 and trailing data descriptor.
    header.writeUInt16LE(name.length, 26);
    yield header;
    yield name;
    let crc = 0xffffffff;
    let size = 0;
    for await (const bytes of await entry.open()) {
      size += bytes.byteLength;
      if (size > 0xffffffff) throw new Error('EXPORT_ZIP_ENTRY_LIMIT_EXCEEDED');
      crc = crc32Update(crc, bytes);
      yield bytes;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor;
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0808, 8);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(size, 20);
    directory.writeUInt32LE(size, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + size + descriptor.length;
  }
  const centralOffset = offset;
  for (const bytes of central) {
    yield bytes;
    offset += bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralOffset, 12);
  end.writeUInt32LE(centralOffset, 16);
  yield end;
}
interface SelectedExportDocument {
  readonly documentId: string;
  readonly title: string;
  readonly objectKey?: string;
}
function selectedRows(value: unknown): readonly SelectedExportDocument[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('EXPORT_PAYLOAD_INVALID');
  const documents = (value as Readonly<Record<string, unknown>>)['documents'];
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > 1_000)
    throw new Error('EXPORT_PAYLOAD_INVALID');
  return documents.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      throw new Error('EXPORT_PAYLOAD_INVALID');
    const record = entry as Readonly<Record<string, unknown>>;
    const documentId = record['documentId'];
    const title = record['title'];
    const objectKey = record['objectKey'];
    if (
      typeof documentId !== 'string' ||
      !/^[A-Za-z0-9_-]{32}$/u.test(documentId) ||
      typeof title !== 'string' ||
      (objectKey !== undefined && objectKey !== null && typeof objectKey !== 'string')
    )
      throw new Error('EXPORT_PAYLOAD_INVALID');
    return { documentId, title, ...(typeof objectKey === 'string' ? { objectKey } : {}) };
  });
}
function selectedDocumentsZip(
  payload: unknown,
  includeOriginals: boolean,
  storage: ExportStorage,
): AsyncIterable<Uint8Array> {
  const documents = selectedRows(payload);
  const manifest = documents.map(({ documentId, title }) => ({ documentId, title }));
  const entries: ZipEntry[] = [
    {
      name: 'manifest.json',
      open: () => one(Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8')),
    },
  ];
  if (includeOriginals) {
    for (const [index, document] of documents.entries()) {
      const objectKey = document.objectKey;
      if (objectKey === undefined) throw new Error('EXPORT_ORIGINAL_UNAVAILABLE');
      entries.push({
        name: `${String(index + 1).padStart(4, '0')}-${document.documentId}.bin`,
        open: () => storage.streamSource(objectKey),
      });
    }
  }
  return streamingZip(entries);
}

export async function preflightExport(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly preset: ExportPreset;
  readonly selectedDocumentIds: readonly string[];
  readonly includeOriginals: boolean;
}): Promise<ExportPreflight> {
  const result = await input.pool.query<{ export_preflight: ExportPreflight }>(
    'SELECT export_preflight($1,$2,$3,$4,$5)',
    [
      input.identity.id,
      input.roomId,
      input.preset,
      selection(input.preset, input.selectedDocumentIds),
      input.includeOriginals,
    ],
  );
  const impact = result.rows[0]?.export_preflight;
  if (impact === undefined) throw new Error('EXPORT_PREFLIGHT_UNAVAILABLE');
  return impact;
}
export async function requestExport(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly roomId: string;
  readonly preset: ExportPreset;
  readonly selectedDocumentIds: readonly string[];
  readonly includeOriginals: boolean;
  readonly now?: Date;
}): Promise<{ readonly exportId: string; readonly preflight: ExportPreflight }> {
  const now = input.now ?? new Date();
  if (!hasFreshOidc(input.identity.oidcAuthenticatedAt, now))
    throw new Error('FRESH_OIDC_REQUIRED');
  const exportId = createOpaqueId();
  const objectKey = `exports/${createOpaqueId()}/${createOpaqueId()}`;
  const contentType =
    input.preset === 'selected-documents' ? 'application/zip' : 'application/json';
  const selected = selection(input.preset, input.selectedDocumentIds);
  const created = await input.pool.query<{ create_export_request: ExportPreflight }>(
    'SELECT create_export_request($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
    [
      exportId,
      input.identity.id,
      input.roomId,
      input.preset,
      selected,
      input.includeOriginals,
      input.identity.oidcAuthenticatedAt ?? null,
      objectKey,
      contentType,
      createOpaqueId(),
      createOpaqueId(),
      createCorrelationId(),
    ],
  );
  const preflight = created.rows[0]?.create_export_request;
  if (preflight === undefined) throw new Error('EXPORT_CREATE_FAILED');
  return { exportId, preflight };
}

export async function generateExportJob(input: {
  readonly pool: Pool;
  readonly storage: ExportStorage;
  readonly exportId: string;
  readonly jobId: string;
  readonly leaseOwner: string;
  readonly leaseToken: string;
}): Promise<void> {
  const payload = await input.pool.query<{ read_export_job_payload: unknown }>(
    'SELECT read_export_job_payload($1,$2,$3,$4)',
    [input.exportId, input.jobId, input.leaseOwner, input.leaseToken],
  );
  const document = payload.rows[0]?.read_export_job_payload;
  if (document === null || document === undefined) throw new Error('EXPORT_PAYLOAD_FORBIDDEN');
  const record = document as Readonly<Record<string, unknown>>;
  const preset = record['preset'];
  const includeOriginals = record['originalsIncluded'] === true;
  const contentType = preset === 'selected-documents' ? 'application/zip' : 'application/json';
  const stream =
    preset === 'selected-documents'
      ? selectedDocumentsZip(document, includeOriginals, input.storage)
      : one(Buffer.from(`${JSON.stringify(document)}\n`, 'utf8'));
  const objectKey = record['exportObjectKey'];
  if (typeof objectKey !== 'string') throw new Error('EXPORT_PAYLOAD_INVALID');
  let size: number;
  try {
    size = await input.storage.putStream({ key: objectKey, stream, contentType });
  } catch (error) {
    throw new Error('EXPORT_STORAGE_FAILED', { cause: error });
  }
  const marked = await input.pool.query<{ mark_export_job_ready: boolean }>(
    'SELECT mark_export_job_ready($1,$2,$3,$4,$5)',
    [input.exportId, input.jobId, input.leaseOwner, input.leaseToken, size],
  );
  if (marked.rows[0]?.mark_export_job_ready !== true) {
    await input.storage.delete(objectKey);
    throw new Error('EXPORT_READY_FAILED');
  }
}
export async function downloadExportOnce(input: {
  readonly pool: Pool;
  readonly storage: ExportStorage;
  readonly identity: MemberIdentity;
  readonly exportId: string;
}): Promise<{
  readonly stream: AsyncIterable<Uint8Array>;
  readonly contentType: string;
  readonly size: number;
}> {
  const claimed = await input.pool.query<{
    object_key: string;
    content_type: string;
    size_bytes: string;
  }>('SELECT * FROM claim_export_download($1,$2,$3,$4,$5)', [
    input.exportId,
    input.identity.id,
    input.identity.oidcAuthenticatedAt ?? null,
    createOpaqueId(),
    createCorrelationId(),
  ]);
  const row = claimed.rows[0];
  if (row === undefined) throw new Error('EXPORT_DOWNLOAD_FORBIDDEN');
  const stream = await input.storage.streamExport(row.object_key, Number(row.size_bytes));
  // The one-shot claim happens before streaming. Physical deletion/finalization
  // is intentionally deferred to export.cleanup so storage is never deleted
  // before Fastify has consumed the backpressured stream.
  return { stream, contentType: row.content_type, size: Number(row.size_bytes) };
}
