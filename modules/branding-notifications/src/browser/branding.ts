/**
 * Browser contribution of `branding-notifications` for custom brand overrides.
 *
 * Arrives through the generated registry and build-time plugin. When the module
 * is omitted, this file is absent from the bundle.
 */

import type {
  BrowserContribution,
  BrandingSlot,
  EffectiveBrand,
  SupportContact,
  ViewerIntroductionSlot,
} from '@duefold/web-client/module-api';

interface PublicBrandingPayload {
  readonly organizationName?: unknown;
  readonly accentColor?: unknown;
  readonly hasLogo?: unknown;
  readonly hasSquareMark?: unknown;
  readonly logoIncludesName?: unknown;
  readonly supportContact?: unknown;
}

function parseSupportContact(contact: unknown): SupportContact | null {
  if (typeof contact !== 'object' || contact === null) return null;
  const record = contact as { kind?: unknown; value?: unknown };
  if (
    (record.kind !== 'email' && record.kind !== 'url') ||
    typeof record.value !== 'string' ||
    record.value === ''
  )
    return null;
  return { kind: record.kind, value: record.value };
}

function parsePayload(value: unknown): EffectiveBrand | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as PublicBrandingPayload;
  const orgName = typeof raw.organizationName === 'string' ? raw.organizationName.trim() : '';
  const accent =
    typeof raw.accentColor === 'string' && /^#[0-9A-Fa-f]{6}$/u.test(raw.accentColor)
      ? raw.accentColor
      : '#006b5e';
  const hasLogo = raw.hasLogo === true;
  const hasSquare = raw.hasSquareMark === true;

  return {
    organizationName: orgName === '' ? 'Duefold' : orgName,
    accentColor: accent,
    logoUrl: hasLogo ? '/api/branding/assets/logo' : null,
    logoIncludesName: raw.logoIncludesName === true,
    squareMarkUrl: hasSquare ? '/api/branding/assets/square-mark' : null,
    supportContact: parseSupportContact(raw.supportContact),
  };
}

const slot: BrandingSlot = {
  async load(signal) {
    const response = await fetch('/api/branding/public', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal,
    });
    if (!response.ok) return null;
    return parsePayload(await response.json());
  },
};

const viewerIntroduction: ViewerIntroductionSlot = {
  async load(signal) {
    const response = await fetch('/api/viewer/branding/introduction', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal,
    });
    if (!response.ok) throw new Error('VIEWER_INTRODUCTION_UNAVAILABLE');
    const payload = (await response.json()) as { roomIntroduction?: unknown };
    if (typeof payload.roomIntroduction !== 'string')
      throw new Error('VIEWER_INTRODUCTION_INVALID');
    return payload.roomIntroduction;
  },
};

export const contribution: BrowserContribution = {
  branding: slot,
  viewerIntroduction,
};
