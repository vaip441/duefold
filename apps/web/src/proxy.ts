import { StartupRefusal } from '@duefold/shared/process-errors';

export type TrustProxyOption =
  false | string | string[] | ((address: string, hop: number) => boolean);

/** Parses explicit proxy IP/CIDR values and never permits trust-all or hop-only
 * trust. A hop count cannot prove that the immediate peer is the deployment's
 * proxy when the origin is reachable directly. */
export function parseTrustedProxies(raw: string | undefined): TrustProxyOption {
  if (raw === undefined || raw.trim() === '' || raw === 'false') return false;
  if (raw === 'true') throw new StartupRefusal('DUEFOLD_TRUSTED_PROXIES_TRUST_ALL_FORBIDDEN');
  if (/^[1-9][0-9]*$/u.test(raw))
    throw new StartupRefusal('DUEFOLD_TRUSTED_PROXIES_HOP_COUNT_FORBIDDEN');
  const parts = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  const [first] = parts;
  if (first === undefined) throw new StartupRefusal('DUEFOLD_TRUSTED_PROXIES_EMPTY');
  return parts.length === 1 ? first : parts;
}

/** Trusts only the immediate peer, so `request.ip` is the right-most
 * X-Forwarded-For entry: the one the platform edge appended. Safe only where that
 * edge is the sole ingress; a client reaching the container directly could forge
 * it. A numeric Fastify `trustProxy` is not used because Fastify 5 fails it
 * closed. */
function trustPlatformEdge(_address: string, hop: number): boolean {
  return hop === 0;
}

/** Requires the client-address source to be stated exactly once. Left unset behind a
 * proxy, every request shares the proxy's address, so the public per-network limits on
 * sign-in codes and OIDC begin become one installation-wide bucket any caller can
 * exhaust. `DUEFOLD_TRUSTED_PROXIES=false` states that clients connect directly. */
export function resolveProxyTrust(
  trustedProxies: string | undefined,
  trustedEdgeHops: string | undefined,
): TrustProxyOption {
  const proxiesSet = trustedProxies !== undefined && trustedProxies.trim() !== '';
  const edgeSet = trustedEdgeHops !== undefined && trustedEdgeHops !== '';
  if (!proxiesSet && !edgeSet)
    throw new StartupRefusal('DUEFOLD_CLIENT_ADDRESS_SOURCE_REQUIRED');
  if (proxiesSet && edgeSet)
    throw new StartupRefusal('DUEFOLD_TRUSTED_EDGE_HOPS_WITH_TRUSTED_PROXIES');
  if (proxiesSet) return parseTrustedProxies(trustedProxies);
  if (trustedEdgeHops !== '1') throw new StartupRefusal('DUEFOLD_TRUSTED_EDGE_HOPS_INVALID');
  return trustPlatformEdge;
}
