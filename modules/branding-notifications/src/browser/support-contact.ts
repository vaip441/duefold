/**
 * Browser contribution of `branding-notifications`.
 *
 * This is the module's only browser code. It arrives through the generated
 * registry (`.duefold/generated/browser-entries.ts`) and the build-time Vite
 * plugin that turns that registry into literal static imports. When the module
 * is omitted from the composition manifest, nothing names this file, so it
 * cannot enter the bundle graph — it is absent rather than inert.
 *
 * It renders the operator-configured support contact on unauthenticated
 * surfaces. Absence of the module, an unconfigured value, and a failed request
 * are deliberately indistinguishable: all three render nothing.
 */

import type { BrowserContribution, SupportContactSlot } from '@duefold/web-client/module-api';

interface SupportContactPayload {
  readonly supportContact: { readonly kind: 'email' | 'url'; readonly value: string } | null;
}

function parsePayload(value: unknown): SupportContactPayload {
  if (typeof value !== 'object' || value === null) return { supportContact: null };
  const contact = (value as { supportContact?: unknown }).supportContact;
  if (typeof contact !== 'object' || contact === null) return { supportContact: null };
  const record = contact as { kind?: unknown; value?: unknown };
  if (
    (record.kind !== 'email' && record.kind !== 'url') ||
    typeof record.value !== 'string' ||
    record.value === ''
  )
    return { supportContact: null };
  return { supportContact: { kind: record.kind, value: record.value } };
}

const slot: SupportContactSlot = {
  async load(signal) {
    const response = await fetch('/api/branding/support-contact', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      signal,
    });
    if (!response.ok) return null;
    return parsePayload(await response.json()).supportContact;
  },
};

export const contribution: BrowserContribution = { supportContact: slot };
