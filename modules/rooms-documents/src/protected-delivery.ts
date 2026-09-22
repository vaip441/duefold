import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import type { CoarseClient } from '../../core-security/src/auth/otp.ts';
import { networkCorrelation } from '../../core-security/src/auth/otp.ts';
import type { ViewerIdentity } from '../../core-security/src/authorization.ts';
import { createCorrelationId, createOpaqueId } from '@duefold/shared/ids';
import type { DeliveryStorage } from './storage/s3-compatible.ts';
import { invokeSandboxed, type SandboxProgram } from './processing/sandbox.ts';
import type { SandboxIsolation } from './processing/preflight.ts';
import { normalizeSafeHttpsLink, type SafeHttpsLink } from './safe-links.ts';

const WATERMARK_LIMITS = {
  timeoutMilliseconds: 30_000,
  maximumOutputBytes: 262_144_000,
  maximumInputBytes: 262_144_000,
  maximumTemporaryBytes: 524_288_000,
} as const;

function sessionProof(identity: ViewerIdentity): string {
  if (identity.sessionProof === undefined) throw new Error('VIEWER_SESSION_PROOF_REQUIRED');
  return identity.sessionProof;
}
function rowRequired<T>(row: T | undefined, code: string): T {
  if (row === undefined) throw new Error(code);
  return row;
}

export interface TextItem {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly link?: SafeHttpsLink;
}
export interface ProtectedTextLayer {
  readonly versionId: string;
  readonly accessibleLabel: string;
  readonly items: readonly TextItem[];
}

function finiteCoordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 32_768
    ? value
    : undefined;
}
function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > 10_000) return undefined;
  let forbidden = false;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && point < 32 && point !== 9 && point !== 10 && point !== 13) {
      forbidden = true;
      break;
    }
  }
  if (forbidden || /<(?:[A-Za-z][^>]*|\/[^>]*|![^>]*|\?[^>]*)(?:>|$)/su.test(value))
    return undefined;
  return value;
}
function parseTextLayer(value: unknown): readonly TextItem[] {
  if (!Array.isArray(value) || value.length > 100_000) return [];
  const items: TextItem[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const record = entry as Readonly<Record<string, unknown>>;
    const text = safeText(record['text']);
    const x = finiteCoordinate(record['x']);
    const y = finiteCoordinate(record['y']);
    const width = finiteCoordinate(record['width']);
    const height = finiteCoordinate(record['height']);
    if (
      text === undefined ||
      x === undefined ||
      y === undefined ||
      width === undefined ||
      height === undefined
    )
      return [];
    const link = normalizeSafeHttpsLink(record['link']);
    items.push({ text, x, y, width, height, ...(link === undefined ? {} : { link }) });
  }
  return items;
}

export function parseTextLayerForTesting(value: unknown): readonly TextItem[] {
  return parseTextLayer(value);
}

export function resolveInterstitialTarget(value: unknown): SafeHttpsLink {
  const normalized = normalizeSafeHttpsLink(value);
  if (normalized === undefined) throw new Error('EXTERNAL_LINK_UNSAFE');
  return normalized;
}

export async function readProtectedTextLayer(input: {
  readonly pool: Pool;
  readonly identity: ViewerIdentity;
  readonly roomId: string;
  readonly documentId: string;
  readonly pageNumber: number;
}): Promise<ProtectedTextLayer> {
  const result = await input.pool.query<{
    version_id: string;
    accessible_label: string;
    text_layer: unknown;
  }>('SELECT * FROM read_protected_text_layer($1,$2,$3,$4)', [
    sessionProof(input.identity),
    input.roomId,
    input.documentId,
    input.pageNumber,
  ]);
  const row = rowRequired(result.rows[0], 'PROTECTED_PAGE_UNAVAILABLE');
  return {
    versionId: row.version_id,
    accessibleLabel: row.accessible_label,
    items: parseTextLayer(row.text_layer),
  };
}

interface WatermarkSource {
  readonly cache_id: string;
  readonly version_id: string;
  readonly source_object_key: string;
  readonly media_type: 'image/png' | 'image/webp';
  readonly viewer_email: string;
  readonly room_name: string;
  readonly access_date: Date;
}

export async function composeWatermarkPage(input: {
  readonly program: SandboxProgram;
  readonly source: Uint8Array;
  readonly viewerEmail: string;
  readonly accessDateUtc: string;
  readonly roomName: string;
  readonly isolation?: SandboxIsolation;
}): Promise<Uint8Array> {
  const envelope = Buffer.from(
    JSON.stringify({
      watermark: {
        email: input.viewerEmail,
        accessDateUtc: input.accessDateUtc,
        roomName: input.roomName,
      },
      imageBase64: Buffer.from(input.source).toString('base64'),
    }),
    'utf8',
  );
  return invokeSandboxed({
    program: input.program,
    arguments: ['watermark-page', '--stdin-envelope'],
    input: envelope,
    limits: WATERMARK_LIMITS,
    ...(input.isolation === undefined || input.isolation.mode === 'namespaced'
      ? {}
      : { mode: input.isolation.mode, identities: input.isolation.identities }),
  });
}

export async function createWatermarkedPage(input: {
  readonly pool: Pool;
  readonly storage: DeliveryStorage;
  readonly watermarkProgram: SandboxProgram;
  readonly identity: ViewerIdentity;
  readonly roomId: string;
  readonly documentId: string;
  readonly pageNumber: number;
  readonly isolation?: SandboxIsolation;
}): Promise<{ readonly cacheId: string; readonly expiresAt: Date }> {
  const reusable = (
    await input.pool.query<{ cache_id: string; expires_at: Date }>(
      'SELECT * FROM find_active_watermark_cache($1,$2,$3,$4)',
      [sessionProof(input.identity), input.roomId, input.documentId, input.pageNumber],
    )
  ).rows[0];
  if (reusable !== undefined)
    return { cacheId: reusable.cache_id, expiresAt: reusable.expires_at };
  const cacheId = createOpaqueId();
  const objectKey = `watermarks/${createOpaqueId()}/${createOpaqueId()}`;
  const selected = (
    await input.pool.query<WatermarkSource & { readonly expires_at: Date }>(
      'SELECT * FROM begin_watermark_cache($1,$2,$3,$4,$5,$6)',
      [
        cacheId,
        sessionProof(input.identity),
        input.roomId,
        input.documentId,
        input.pageNumber,
        objectKey,
      ],
    )
  ).rows[0];
  if (selected === undefined) throw new Error('PROTECTED_PAGE_UNAVAILABLE');
  try {
    const source = await input.storage.getObjectBytes(selected.source_object_key);
    const bytes = await composeWatermarkPage({
      program: input.watermarkProgram,
      source,
      viewerEmail: selected.viewer_email,
      accessDateUtc: selected.access_date.toISOString().slice(0, 10),
      roomName: selected.room_name,
      ...(input.isolation === undefined ? {} : { isolation: input.isolation }),
    });
    await input.storage.putWatermark({
      key: objectKey,
      bytes,
      contentType: selected.media_type,
    });
    const activated = await input.pool.query<{ ok: boolean }>(
      'SELECT finish_watermark_cache($1,$2) ok',
      [cacheId, sessionProof(input.identity)],
    );
    if (activated.rows[0]?.ok !== true) {
      await input.storage.deleteObject(objectKey);
      throw new Error('PROTECTED_PAGE_UNAVAILABLE');
    }
    return { cacheId, expiresAt: selected.expires_at };
  } catch (error) {
    await input.storage.deleteObject(objectKey).catch(() => undefined);
    throw error;
  }
}

export async function deliverWatermarkedPage(input: {
  readonly pool: Pool;
  readonly storage: DeliveryStorage;
  readonly identity: ViewerIdentity;
  readonly cacheId: string;
  readonly activityId: string;
}): Promise<{ readonly bytes: Uint8Array; readonly mediaType: 'image/png' | 'image/webp' }> {
  const selected = (
    await input.pool.query<{
      object_key: string;
      media_type: 'image/png' | 'image/webp';
      page_number: number;
    }>('SELECT * FROM authorize_watermark_delivery($1,$2,$3)', [
      input.cacheId,
      sessionProof(input.identity),
      input.activityId,
    ])
  ).rows[0];
  if (selected === undefined) throw new Error('PROTECTED_PAGE_UNAVAILABLE');
  const bytes = await input.storage.getObjectBytes(selected.object_key);
  return { bytes, mediaType: selected.media_type };
}

export async function beginPreview(input: {
  readonly pool: Pool;
  readonly identity: ViewerIdentity;
  readonly roomId: string;
  readonly documentId: string;
  readonly versionId: string;
  readonly normalizedIp: string;
  readonly now: Date;
  readonly networkKey: string;
  readonly client: CoarseClient;
}): Promise<{ readonly activityId: string; readonly correlationId: string }> {
  const network = monthlyNetworkCorrelation({
    ip: input.normalizedIp,
    periodDate: input.now,
    rootKey: input.networkKey,
  });
  const id = createOpaqueId();
  const correlationId = createCorrelationId();
  const result = await input.pool.query<{ id: string | null }>(
    'SELECT begin_preview_activity($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) id',
    [
      id,
      sessionProof(input.identity),
      input.roomId,
      input.documentId,
      input.versionId,
      correlationId,
      network.period,
      network.hmac,
      input.client.browser,
      input.client.os,
      input.client.device,
      createOpaqueId(),
    ],
  );
  const activityId = result.rows[0]?.id;
  if (activityId === undefined || activityId === null)
    throw new Error('PROTECTED_PAGE_UNAVAILABLE');
  return { activityId, correlationId };
}

export async function heartbeatPreview(input: {
  readonly pool: Pool;
  readonly identity: ViewerIdentity;
  readonly activityId: string;
}): Promise<boolean> {
  const result = await input.pool.query<{ ok: boolean }>('SELECT heartbeat_preview($1,$2) ok', [
    input.activityId,
    sessionProof(input.identity),
  ]);
  return result.rows[0]?.ok === true;
}
export async function closePreview(input: {
  readonly pool: Pool;
  readonly identity: ViewerIdentity;
  readonly activityId: string;
  readonly status: 'closed' | 'inactive';
}): Promise<boolean> {
  const result = await input.pool.query<{ ok: boolean }>(
    'SELECT summarize_preview($1,$2,$3,$4) ok',
    [input.activityId, sessionProof(input.identity), input.status, createOpaqueId()],
  );
  return result.rows[0]?.ok === true;
}

export function monthlyNetworkCorrelation(input: {
  readonly ip: string;
  readonly periodDate: Date;
  readonly rootKey: string;
}): { readonly period: string; readonly hmac: string } {
  const period = input.periodDate.toISOString().slice(0, 7);
  const periodKey = createHmac('sha256', input.rootKey)
    .update(`duefold-network-period\0${period}`)
    .digest();
  return networkCorrelation(input.ip, input.periodDate, periodKey.toString('base64url'));
}
