/**
 * Copy for the branding module's browser surface.
 *
 * This catalogue lives in the module rather than in the application's, because
 * the application's catalogue is in every bundle. A branding key there would
 * leave the label of an omitted module's tab in a minimal build — composition
 * state disclosed as product copy, and the tab's absence proven only by whatever
 * code happened not to read the key.
 *
 * Substitution comes from the application's one formatter, so `{name}` cannot
 * come to mean two different things.
 */

import { formatMessage, type MessageValues } from '@duefold/web-client/module-api';

const messages = {
  'section.tab': 'Branding',
  heading: 'Branding',
  loading: 'Loading branding',
  organizationName: 'Organization name',
  accentColor: 'Accent colour',
  'accentColor.help':
    'Used for links and the primary action. Duefold checks it stays readable in both light and dark themes.',
  'accentColor.contrast':
    'That colour is too light or too dark to stay readable. Choose a stronger colour.',
  'accentColor.invalid': 'Enter a colour as six hex digits, for example #006b5e.',
  senderDisplayName: 'Email sender name',
  'senderDisplayName.help':
    'Shown as the sender of invitation and sign-in code emails. Until you set one, emails use the organization name.',
  roomIntroduction: 'Room introduction',
  'roomIntroduction.help': 'Plain text shown to readers beside every room they open.',
  supportContact: 'Support contact',
  'supportContact.help':
    'An email address or an https link. Leave empty to show no support contact.',
  'supportContact.invalid': 'Enter an email address or an https link, or leave it empty.',
  save: 'Save branding',
  'save.pending': 'Saving\u2026',
  saved: 'Branding saved.',
  note: 'Duefold accepts a name, one accent colour, a sender name, an introduction, and a support contact. Custom styles, fonts, and scripts are not accepted.',
  logo: 'Organization logo',
  'logo.help':
    'PNG, JPEG, or WebP. The header shows it beside your organization name unless it already includes the name.',
  'logo.includesName': 'This logo already includes our name',
  'logo.includesName.help':
    'Tick this for a wordmark logo. The name is then left out of the header, and the logo stands for it.',
  'logo.remove': 'Remove logo',
  squareMark: 'Square mark (favicon)',
  'squareMark.help': '1:1 square icon used in browser tabs and mobile shortcuts.',
  'squareMark.remove': 'Remove square mark',
  'upload.pending': 'Uploading and checking image\u2026',
  'upload.failed':
    'Image could not be processed. Confirm it is a valid PNG, JPEG, or WebP and try again.',
} as const;

export type BrandingMessageKey = keyof typeof messages;

export function brandingCopy(key: BrandingMessageKey, values?: MessageValues): string {
  return formatMessage(messages[key], values);
}
