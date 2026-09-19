import type { PrincipalIdentity } from '../../../modules/core-security/src/authorization.ts';

export type RouteAuthority =
  { readonly kind: 'public' } | { readonly kind: 'member' } | { readonly kind: 'viewer' };

/** Exhaustive authority decision; adding an audience cannot silently default-allow. */
export function routeAuthorized(
  authority: RouteAuthority,
  principal: PrincipalIdentity | null,
): boolean {
  switch (authority.kind) {
    case 'public':
      return true;
    case 'member':
      return principal?.kind === 'member';
    case 'viewer':
      return principal?.kind === 'viewer';
    default: {
      const exhaustive: never = authority;
      return exhaustive;
    }
  }
}
