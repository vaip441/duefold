import type { ColumnType, Generated } from 'kysely';

export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type JsonObject = Readonly<Record<string, unknown>>;

export interface OrganizationTable {
  singleton: boolean;
  id: string;
  name: string;
  created_at: Generated<Timestamp>;
}
export interface MemberTable {
  id: string;
  email_key: string;
  email_display: string;
  oidc_issuer: string;
  oidc_subject: string;
  global_role: 'owner' | 'admin' | 'member';
  state: 'invited' | 'active' | 'disabled';
  revision: Generated<number>;
  created_at: Generated<Timestamp>;
}
export interface ViewerTable {
  id: string;
  email_key: string;
  email_display: string;
  state: 'active' | 'revoked' | 'anonymized';
  session_family_id: string;
  revision: Generated<number>;
  created_at: Generated<Timestamp>;
}
export interface InvitationTable {
  id: string;
  kind: 'member' | 'viewer';
  email_key: string;
  email_display: string;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: Timestamp;
  created_at: Generated<Timestamp>;
}
export interface OidcTransactionTable {
  state_digest: string;
  nonce: string;
  code_verifier: string;
  expires_at: Timestamp;
  created_at: Generated<Timestamp>;
}
export interface OtpChallengeTable {
  id: string;
  email_key: string;
  viewer_id: string | null;
  digest: string | null;
  state: 'awaiting_delivery' | 'pending' | 'consumed' | 'invalidated' | 'expired' | 'locked';
  failed_attempts: Generated<number>;
  network_period: string;
  network_hmac: string;
  browser_category: 'chromium' | 'firefox' | 'safari' | 'other';
  os_category: 'windows' | 'macos' | 'linux' | 'ios' | 'android' | 'other';
  device_category: 'desktop' | 'mobile' | 'tablet' | 'other';
  expires_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}
export interface SessionTable {
  id: string;
  secret_digest: string;
  csrf_digest: string;
  principal_kind: 'member' | 'viewer';
  member_id: string | null;
  viewer_id: string | null;
  family_id: string;
  oidc_authenticated_at: Timestamp | null;
  state: 'active' | 'rotated' | 'revoked' | 'expired';
  idle_expires_at: Timestamp;
  absolute_expires_at: Timestamp;
  last_seen_at: Generated<Timestamp>;
  created_at: Generated<Timestamp>;
}
export interface RoomAssignmentTable {
  id: string;
  room_id: string;
  member_id: string;
  room_role: 'manager' | 'contributor';
  state: 'active' | 'revoked';
  created_at: Generated<Timestamp>;
}
export interface AuditEventTable {
  sequence: Generated<string>;
  id: string;
  event_type: string;
  occurred_at: Generated<Timestamp>;
  actor_kind: 'member' | 'viewer' | 'system' | 'operator';
  actor_id: string | null;
  subject_id: string | null;
  room_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  result: 'success' | 'denied' | 'failure';
  reason_code: string;
  correlation_id: string;
  detail: JsonObject;
}
export interface MutationKeyTable {
  key: string;
  operation: string;
  result: JsonObject;
  created_at: Generated<Timestamp>;
}
export interface JobQueueTable {
  id: string;
  job_type: string;
  idempotency_key: string;
  payload: JsonObject;
  state: 'pending' | 'running' | 'succeeded' | 'failed';
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  available_at: Generated<Timestamp>;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Timestamp | null;
  last_error_code: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface SecurityDatabase {
  organization: OrganizationTable;
  member: MemberTable;
  viewer: ViewerTable;
  invitation: InvitationTable;
  oidc_transaction: OidcTransactionTable;
  otp_challenge: OtpChallengeTable;
  session: SessionTable;
  room_assignment: RoomAssignmentTable;
  audit_event: AuditEventTable;
  mutation_key: MutationKeyTable;
  job_queue: JobQueueTable;
}
