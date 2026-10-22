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
  /** Digest of the presented session secret, resolved by the isolated
   * authenticator pool and never accepted from request data. Protected SQL
   * derives viewer/session identity from this proof instead of trusting IDs. */
  readonly sessionProof?: string;
}
export function sessionProof(identity: ViewerIdentity): string {
  if (identity.sessionProof === undefined) throw new Error('VIEWER_SESSION_PROOF_REQUIRED');
  return identity.sessionProof;
}
export type PrincipalIdentity = MemberIdentity | ViewerIdentity;
export function hasFreshOidc(authenticatedAt: Date | undefined, now: Date): boolean {
  return (
    authenticatedAt !== undefined &&
    authenticatedAt.getTime() <= now.getTime() &&
    now.getTime() - authenticatedAt.getTime() <= 15 * 60_000
  );
}
