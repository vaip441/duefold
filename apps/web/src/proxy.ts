export type TrustProxyOption = false | string | string[];

/** Parses explicit proxy IP/CIDR values and never permits trust-all or hop-only
 * trust. A hop count cannot prove that the immediate peer is the deployment's
 * proxy when the origin is reachable directly. */
export function parseTrustedProxies(raw: string | undefined): TrustProxyOption {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') throw new Error('DUEFOLD_TRUSTED_PROXIES_TRUST_ALL_FORBIDDEN');
  if (/^[1-9][0-9]*$/u.test(raw))
    throw new Error('DUEFOLD_TRUSTED_PROXIES_HOP_COUNT_FORBIDDEN');
  const parts = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (parts.length === 0) return false;
  const first = parts[0];
  if (first === undefined) return false;
  return parts.length === 1 ? first : parts;
}
