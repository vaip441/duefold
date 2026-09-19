export type GlobalRole = 'owner' | 'admin' | 'member';
export type RoomRole = 'manager' | 'contributor';
export interface MemberIdentity {
  readonly kind: 'member';
  readonly id: string;
  readonly globalRole: GlobalRole;
  readonly oidcAuthenticatedAt?: Date;
  readonly roomRoles: Readonly<Record<string, RoomRole>>;
}
export interface ViewerIdentity {
  readonly kind: 'viewer';
  readonly id: string;
  /** The authenticated server-side session; never accepted from request data. */
  readonly sessionId?: string;
  /** Digest of the presented session secret, resolved by the isolated
   * authenticator pool and never accepted from request data. Protected SQL
   * derives viewer/session identity from this proof instead of trusting IDs. */
  readonly sessionProof?: string;
}
export type PrincipalIdentity = MemberIdentity | ViewerIdentity;
export type Authority =
  'installation.manage' | 'owner.transfer' | 'room.manage' | 'room.contribute';
export interface MemberAuthorization {
  readonly globalRole: GlobalRole;
  readonly roomRole?: RoomRole;
  readonly oidcAuthenticatedAt?: Date;
}
export function hasFreshOidc(authenticatedAt: Date | undefined, now: Date): boolean {
  return (
    authenticatedAt !== undefined &&
    authenticatedAt.getTime() <= now.getTime() &&
    now.getTime() - authenticatedAt.getTime() <= 15 * 60_000
  );
}
export function authorizeMember(
  input: MemberAuthorization,
  authority: Authority,
  now: Date,
): boolean {
  switch (authority) {
    case 'owner.transfer':
      return input.globalRole === 'owner' && hasFreshOidc(input.oidcAuthenticatedAt, now);
    case 'installation.manage':
      return input.globalRole === 'owner' || input.globalRole === 'admin';
    case 'room.manage':
      return (
        input.globalRole === 'owner' ||
        input.globalRole === 'admin' ||
        input.roomRole === 'manager'
      );
    case 'room.contribute':
      return (
        input.globalRole === 'owner' ||
        input.globalRole === 'admin' ||
        input.roomRole === 'manager' ||
        input.roomRole === 'contributor'
      );
  }
}
export function canViewAudit(
  input: MemberAuthorization,
  scope: 'installation' | 'room' | 'content-status',
): boolean {
  if (scope === 'installation')
    return input.globalRole === 'owner' || input.globalRole === 'admin';
  if (scope === 'room')
    return (
      input.globalRole === 'owner' ||
      input.globalRole === 'admin' ||
      input.roomRole === 'manager'
    );
  return (
    input.globalRole === 'owner' ||
    input.globalRole === 'admin' ||
    input.roomRole === 'manager' ||
    input.roomRole === 'contributor'
  );
}
