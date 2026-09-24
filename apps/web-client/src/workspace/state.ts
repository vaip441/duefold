/**
 * Processing, export, and branding state logic, kept pure and testable.
 *
 * Two constraints drive this file. The server's state vocabulary is internal, so
 * nothing here renders a raw state string; every value maps to copy, and an
 * unrecognized value maps to a neutral in-progress label rather than leaking the
 * identifier. And retry availability is derived from what the SERVER reported —
 * the state and the retry count it returned — never from a local guess about
 * whether a retry might work.
 */

import type { ExportRecord, ProcessingVersion } from '../api/client.ts';
import type { MessageKey } from '../i18n/translate.ts';
import type { StateTone } from './state-tone.ts';

/**
 * One asynchronous section's load state.
 *
 * `failed` is a distinct state rather than `ready` with an empty value. Collapsing
 * the two made a refused load render as "nothing is here", which represents
 * inaccessible data as absent -- the substitution that previously hid revocation.
 */
export type Load<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'failed'; readonly failure: string | null };

const PROCESSING_LABEL: Readonly<Record<string, MessageKey>> = {
  quarantine: 'processing.state.quarantine',
  source_validated: 'processing.state.source_validated',
  ready_for_review: 'processing.state.ready_for_review',
  rejected: 'processing.state.rejected',
  malware_quarantined: 'processing.state.malware_quarantined',
  processing_failed: 'processing.state.processing_failed',
  failed_source_deletion_pending: 'processing.state.failed_source_deletion_pending',
  malware_source_deletion_pending: 'processing.state.malware_source_deletion_pending',
  failed_source_deleted: 'processing.state.failed_source_deleted',
  malware_source_deleted: 'processing.state.malware_source_deleted',
};

const PROCESSING_HELP: Readonly<Record<string, MessageKey>> = {
  quarantine: 'processing.state.quarantineHelp',
  rejected: 'processing.state.rejectedHelp',
  malware_quarantined: 'processing.state.malwareHelp',
  processing_failed: 'processing.state.processingFailedHelp',
};

const PROCESSING_TONE: Readonly<Record<string, StateTone>> = {
  quarantine: 'neutral',
  source_validated: 'neutral',
  ready_for_review: 'ready',
  rejected: 'problem',
  malware_quarantined: 'problem',
  processing_failed: 'caution',
  failed_source_deletion_pending: 'neutral',
  malware_source_deletion_pending: 'neutral',
  failed_source_deleted: 'neutral',
  malware_source_deleted: 'neutral',
};

export interface ProcessingPresentation {
  readonly label: MessageKey;
  readonly help: MessageKey | null;
  readonly tone: StateTone;
  /** The server allows exactly one manual retry, and only after a failure. */
  readonly canRetry: boolean;
  readonly retryExhausted: boolean;
  readonly canDeleteSource: boolean;
}

export function presentProcessing(version: ProcessingVersion): ProcessingPresentation {
  const label = PROCESSING_LABEL[version.state] ?? 'processing.state.unknown';
  const help = PROCESSING_HELP[version.state] ?? null;
  const failedConversion = version.state === 'processing_failed';
  return {
    label,
    help,
    tone: PROCESSING_TONE[version.state] ?? 'neutral',
    canRetry: failedConversion && version.manualRetryCount === 0,
    retryExhausted: failedConversion && version.manualRetryCount > 0,
    /*
     * Deletion is offered for the states the server accepts it for. Malware is
     * included deliberately: the isolated source can be removed, and the audit
     * record of the detection survives regardless.
     */
    canDeleteSource:
      version.state === 'rejected' ||
      version.state === 'processing_failed' ||
      version.state === 'malware_quarantined',
  };
}

const EXPORT_LABEL: Readonly<Record<string, MessageKey>> = {
  generating: 'exports.state.generating',
  ready: 'exports.state.ready',
  consumed: 'exports.state.consumed',
  expired: 'exports.state.expired',
  deletion_pending: 'exports.state.deletion_pending',
  deleted: 'exports.state.deleted',
  failed: 'exports.state.failed',
};

export interface ExportPresentation {
  readonly label: MessageKey;
  readonly help: MessageKey | null;
  /**
   * Whether a download may be attempted. `ready` alone is not enough: an export
   * whose hour has elapsed is refused server-side, so offering the control would
   * present an action that cannot succeed.
   */
  readonly canDownload: boolean;
  readonly consumed: boolean;
}

export function presentExport(record: ExportRecord, now: Date): ExportPresentation {
  const expiresAt = new Date(record.expiresAt);
  const live = !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > now.getTime();
  return {
    label: EXPORT_LABEL[record.state] ?? 'exports.state.unknown',
    help: record.state === 'consumed' ? 'exports.state.consumedHelp' : null,
    canDownload: record.state === 'ready' && record.consumedAt === null && live,
    consumed: record.consumedAt !== null,
  };
}

/** Rounded byte size for a preflight summary. Never implies exactness. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${String(rounded)} ${units[unit] ?? 'B'}`;
}

const LIGHT_GROUND = '#f2f3f1';
const DARK_GROUND = '#161a18';
const MINIMUM_ACCENT_CONTRAST = 3;

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number | null {
  const match = /^#([0-9a-f]{6})$/iu.exec(hex);
  const digits = match?.[1];
  if (digits === undefined) return null;
  const [r = 0, g = 0, b = 0] = [
    digits.slice(0, 2),
    digits.slice(2, 4),
    digits.slice(4, 6),
  ].map((part) => channel(Number.parseInt(part, 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(first: string, second: string): number | null {
  const a = luminance(first);
  const b = luminance(second);
  if (a === null || b === null) return null;
  const [high = 0, low = 0] = [a, b].sort((left, right) => right - left);
  return (high + 0.05) / (low + 0.05);
}

export type AccentProblem = 'format' | 'contrast';

/**
 * Checks an accent colour against both theme grounds.
 *
 * This mirrors the server's rule rather than replacing it: the server validates
 * the same thing and is authoritative. Doing it here means a member sees the
 * problem while choosing the colour instead of after saving.
 */
export function validateAccent(value: string): AccentProblem | null {
  if (!/^#[0-9a-f]{6}$/iu.test(value)) return 'format';
  const light = contrastRatio(value, LIGHT_GROUND);
  const dark = contrastRatio(value, DARK_GROUND);
  if (light === null || dark === null) return 'format';
  return light < MINIMUM_ACCENT_CONTRAST || dark < MINIMUM_ACCENT_CONTRAST ? 'contrast' : null;
}

/** Mirrors the server's support-contact rule: email, https, or empty. */
export function validateSupportContact(raw: string): boolean {
  const value = raw.trim();
  if (value === '') return true;
  if (Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 31))
    return false;
  if (value.includes('@') && !value.includes('/') && !value.includes(':'))
    return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(value);
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}
