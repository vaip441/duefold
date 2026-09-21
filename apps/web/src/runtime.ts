import type * as oidc from 'openid-client';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { Clock } from '@duefold/shared/clock';
import type { CoarseClient } from '../../../modules/core-security/src/auth/otp.ts';
import type { PrincipalIdentity } from '../../../modules/core-security/src/authorization.ts';
import type { SessionPolicy } from '../../../modules/core-security/src/sessions.ts';
import type {
  WebStorage,
  DeliveryStorage,
} from '../../../modules/rooms-documents/src/storage/s3-compatible.ts';
import type { SandboxProgram } from '../../../modules/rooms-documents/src/processing/sandbox.ts';
import type { SandboxIsolation } from '../../../modules/rooms-documents/src/processing/preflight.ts';
import type { DeploymentFacts } from '../../../modules/core-security/src/deployment-status.ts';

export interface WebRuntime {
  readonly pool: Pool;
  /** What this process was built from, for the status surface. */
  readonly deployment: DeploymentFacts;
  /** Isolated authentication-evidence/session-lifecycle credential. It has no
   * protected-content privileges; `pool` cannot mint sessions. */
  readonly authPool: Pool;
  readonly oidc: oidc.Configuration;
  readonly oidcRedirectUri: string;
  readonly ownerAllowlist: readonly string[];
  readonly organizationName: string;
  readonly afterAuthenticationPath: string;
  readonly otpDigestKey: string;
  readonly networkHmacKey: string;
  readonly sessionPolicy: SessionPolicy;
  readonly clock: Clock;
  readonly storage: WebStorage;
  readonly deliveryStorage: DeliveryStorage;
  /** Absent in production until a qualified credential-free watermark adapter
   * is explicitly configured. Protected-page creation fails closed without it. */
  readonly watermarkProgram?: SandboxProgram;
  /** Absent means the namespaced boundary. Set only when the deployment has
   * explicitly acknowledged a host without namespace support. */
  readonly sandboxIsolation?: SandboxIsolation;
  classifyClient(request: FastifyRequest): CoarseClient;
  deliverOtp(input: {
    readonly emailDisplay: string;
    readonly code: string;
    readonly challengeId: string;
  }): Promise<void>;
  revokeSession(sessionId: string, principal: PrincipalIdentity): Promise<void>;
}
