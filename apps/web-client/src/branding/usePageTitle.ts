/**
 * The browser title names the kind of view and the operating organization, so tabs
 * and assistive technology can tell views apart (WCAG 2.4.2).
 *
 * It takes a message key, never free text: browser history, synced history, and
 * session restore keep titles after sign-out or revocation, so a room or document
 * name must never reach one.
 */

import { useEffect } from 'react';
import { translate, type MessageKey } from '../i18n/translate.ts';
import { useBrand } from './useBrand.ts';

export function pageTitle(view: string, organization: string | null): string {
  return organization === null || view === organization ? view : `${view} · ${organization}`;
}

/** `null` leaves the title to the surface that renders one. */
export function usePageTitle(view: MessageKey | null): void {
  const { brand } = useBrand();
  // Until branding loads the organization is unknown, so the title names the view alone.
  const organization = brand === null ? null : brand.organizationName;
  useEffect(() => {
    if (view === null) return;
    document.title = pageTitle(translate(view), organization);
    return () => {
      document.title = translate('app.name');
    };
  }, [view, organization]);
}
