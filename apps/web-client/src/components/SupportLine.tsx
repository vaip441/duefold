/** Operator-configured support line from the root-loaded public brand. */

import type { SupportContact } from '../contract.ts';
import { translate } from '../i18n/translate.ts';

export function SupportLine({
  contact,
}: {
  readonly contact: SupportContact | null;
}): React.ReactElement | null {
  if (contact === null) return null;
  const href = contact.kind === 'email' ? `mailto:${contact.value}` : contact.value;
  const label =
    contact.kind === 'email' ? translate('app.support.email') : translate('app.support.url');
  return (
    <a href={href} rel="noopener noreferrer">
      {label}
    </a>
  );
}
