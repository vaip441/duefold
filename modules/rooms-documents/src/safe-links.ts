import { domainToASCII, domainToUnicode } from 'node:url';

export interface SafeHttpsLink {
  readonly interstitialPath: string;
  readonly normalizedDomain: string;
}

const FORBIDDEN_RAW = /[\p{Cc}\p{Cf}\p{Z}]/u;
function unicodeScripts(label: string): ReadonlySet<string> {
  const scripts = new Set<string>();
  for (const character of label) {
    if (/^[\p{ASCII}\p{Number}\p{Mark}-]$/u.test(character)) {
      if (/^[A-Za-z]$/u.test(character)) scripts.add('Latin');
      continue;
    }
    if (/^\p{Script=Latin}$/u.test(character)) scripts.add('Latin');
    else if (/^\p{Script=Greek}$/u.test(character)) scripts.add('Greek');
    else if (/^\p{Script=Cyrillic}$/u.test(character)) scripts.add('Cyrillic');
    else if (/^\p{Script=Han}$/u.test(character)) scripts.add('Han');
    else if (/^\p{Script=Hiragana}$/u.test(character)) scripts.add('Hiragana');
    else if (/^\p{Script=Katakana}$/u.test(character)) scripts.add('Katakana');
    else if (/^\p{Letter}$/u.test(character)) scripts.add('Other');
  }
  return scripts;
}
function homographRisk(hostname: string): boolean {
  return hostname.split('.').some((label) => {
    const scripts = unicodeScripts(label);
    // Japanese labels conventionally combine Han with kana. Other mixed-script
    // labels are rejected because they can render as an ASCII brand while
    // navigating to a different IDN (for example Cyrillic а + Latin pple).
    return (
      scripts.size > 1 &&
      ![...scripts].every((script) => ['Han', 'Hiragana', 'Katakana'].includes(script))
    );
  });
}

/**
 * Inverted-default external-link boundary. Only a structurally valid HTTPS URL
 * with no credentials, raw whitespace/control/format characters, or raw
 * punycode label is accepted. Unicode hostnames are normalized through the URL
 * parser, round-tripped through IDNA, and displayed from that exact canonical
 * ASCII hostname, so the warning cannot name one host while navigating to
 * another. Raw xn-- input is rejected because it can conceal a Unicode
 * homograph from the source review; legitimate international domains must be
 * supplied as Unicode and are accepted after the same round trip.
 */
export function normalizeSafeHttpsLink(value: unknown): SafeHttpsLink | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) return undefined;
  if (FORBIDDEN_RAW.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname === ''
  )
    return undefined;
  const ascii = domainToASCII(url.hostname).toLowerCase();
  const unicode = domainToUnicode(ascii).normalize('NFC').toLowerCase();
  if (
    ascii === '' ||
    unicode === '' ||
    domainToASCII(unicode).toLowerCase() !== ascii ||
    homographRisk(unicode)
  )
    return undefined;
  url.hostname = ascii;
  const href = url.toString();
  return {
    interstitialPath: `/api/viewer/links/interstitial?target=${encodeURIComponent(href)}`,
    normalizedDomain: unicode,
  };
}
