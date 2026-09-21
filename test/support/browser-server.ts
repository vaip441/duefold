/**
 * Browser-test server harness.
 *
 * Starts the REAL Fastify app with the REAL built browser client and a real
 * PostgreSQL database, so the browser tests exercise the shipped request path
 * rather than a mock. Cookies are `Secure`, so the harness listens over HTTPS on
 * a loopback certificate generated at start; without TLS the browser would
 * silently drop the session and CSRF cookies and every flow would fail for the
 * wrong reason.
 *
 * OTP codes are captured from the delivery job rather than read from the
 * database, which is exactly how a viewer receives them: the test knows the code
 * only because the mailer was called.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import * as oidc from 'openid-client';
import { generatedMigrations } from '../../.duefold/generated/migrations.ts';
import { buildTestWebApp } from './web-runtime.ts';
import { createSessionAuthenticator } from '../../apps/web/src/authenticate.ts';
import { loadStaticClient } from '../../apps/web/src/static-client.ts';
import { migrate } from '../../modules/core-security/src/db/migrate.ts';
import { createHandler as createOtpDeliveryHandler } from '../../modules/core-security/src/jobs/otp-delivery.ts';
import { JobRunner } from '../../apps/worker/src/runner.ts';
import { systemClock } from '@duefold/shared/clock';
import { createOpaqueId, createCorrelationId } from '@duefold/shared/ids';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  issueSession,
} from '../../modules/core-security/src/sessions.ts';
import type { WebRuntime } from '../../apps/web/src/runtime.ts';
import type {
  WebStorage,
  DeliveryStorage,
} from '../../modules/rooms-documents/src/storage/s3-compatible.ts';
import { sandboxProgram } from '../../modules/rooms-documents/src/processing/sandbox.ts';

const CLIENT_DIST = fileURLToPath(new URL('../../apps/web-client/dist', import.meta.url));

const unusedStorage: WebStorage = {
  checksumSupport: false,
  checkReady: () => Promise.reject(new Error('unused storage')),
  createMultipart: () => Promise.reject(new Error('unused storage')),
  presignPart: () => Promise.reject(new Error('unused storage')),
  completeMultipart: () => Promise.reject(new Error('unused storage')),
  abortMultipart: () => Promise.reject(new Error('unused storage')),
  headObject: () => Promise.reject(new Error('unused storage')),
  deleteObject: () => Promise.reject(new Error('unused storage')),
};

/**
 * In-memory delivery storage for the browser harness.
 *
 * The viewer reading room needs page bytes to exist, so these calls are served
 * from a map rather than rejected. Derivative keys resolve to a real 1x1 PNG, or
 * to the supplied page image, so the browser has something decodable to render; originals resolve to
 * deterministic filler of the seeded size so range requests and resume behave
 * like the real thing.
 *
 * This is a STORAGE double only. Authorization, publication evidence, grants,
 * expiry, and preview evidence are all the real server paths, so a test that
 * passes here has actually been authorized.
 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);

function harnessDeliveryStorage(pageImage: Uint8Array = PNG_1X1): DeliveryStorage {
  const watermarks = new Map<string, Uint8Array>();
  const objectBytes = (key: string, length: number): Uint8Array => {
    if (key.startsWith('derivatives/')) return new Uint8Array(pageImage);
    // Deterministic filler: byte i is (i % 251), so a wrong range is detectable.
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) bytes[index] = index % 251;
    return bytes;
  };
  return {
    getObjectBytes: (key, range) => {
      const stored = watermarks.get(key);
      if (stored !== undefined) return Promise.resolve(stored);
      const whole = objectBytes(key, 2048);
      if (range === undefined) return Promise.resolve(whole);
      return Promise.resolve(whole.slice(range.start, range.endInclusive + 1));
    },
    streamObjectRange: (key, range) => {
      const whole = objectBytes(key, 2048);
      const slice = whole.slice(range.start, range.endInclusive + 1);
      /*
       * The contract is an AsyncIterable. Building it from an array's iterator
       * rather than an async generator keeps this a real async iterable without a
       * generator that never awaits.
       */
      const chunks: readonly Uint8Array[] = [slice];
      const iterable: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            next: () => {
              const chunk = chunks[index];
              index += 1;
              return Promise.resolve(
                chunk === undefined
                  ? { value: new Uint8Array(), done: true }
                  : { value: chunk, done: false },
              );
            },
          };
        },
      };
      return Promise.resolve(iterable);
    },
    putWatermark: (input) => {
      watermarks.set(input.key, input.bytes);
      return Promise.resolve();
    },
    putExport: (input) => {
      watermarks.set(input.key, input.bytes);
      return Promise.resolve();
    },
    deleteObject: (key) => {
      watermarks.delete(key);
      return Promise.resolve();
    },
  };
}

/** Self-signed loopback certificate, so `Secure` cookies are accepted. */
function loopbackTls(): { key: string; cert: string } {
  const directory = mkdtempSync(resolve(tmpdir(), 'duefold-tls-'));
  const keyPath = resolve(directory, 'key.pem');
  const certPath = resolve(directory, 'cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ]);
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
}

export interface TestServer {
  readonly baseUrl: string;
  /** Resolves the code the delivery job passed to the mailer for this address. */
  deliveredCode(email: string): Promise<string>;
  /**
   * Sets the public support contact.
   *
   * It lives in the database, not in server options: PostgreSQL is its
   * only source so there could not be two definitions of one concept.
   */
  setSupportContact(value: string): Promise<void>;
  /** Seeds an active viewer with a live invitation. */
  inviteViewer(email: string): Promise<void>;
  /**
   * Seeds an active member with a real server-issued session and returns the
   * cookies a browser would hold.
   *
   * Member sign-in is OIDC, which cannot run against a live identity provider in
   * this harness. Rather than stubbing the client's view of authentication — which
   * would let the workspace render on a session the server never issued, and prove
   * nothing about authorization — this issues a genuine session through the same
   * `issueSession` path the OIDC callback uses. Every request the workspace makes
   * is then authorized by the real authenticator.
   */
  signInMember(input: {
    readonly globalRole?: 'owner' | 'admin' | 'member';
    readonly roomTitle?: string;
    readonly roomRole?: 'manager' | 'contributor';
    /**
     * Seeds a real viewer membership plus a real grant, so the participants
     * surface has a populated positive arm rather than only an empty state.
     */
    readonly withParticipant?: {
      readonly email: string;
      /** When 'expired', the grant is real but already lapsed. */
      readonly grant?: 'active' | 'expired' | 'none';
    };
    /** Seeds document versions in the given processing states. */
    readonly withProcessing?: readonly {
      readonly title: string;
      readonly state: 'quarantine' | 'processing_failed' | 'rejected' | 'malware_quarantined';
      readonly manualRetryCount?: number;
    }[];
    /**
     * Seeds colleagues and a pending invitation, so the Members surface has a populated
     * table rather than only an empty state.
     *
     * Every row is created through the audited SECURITY DEFINER functions the product
     * uses — `invite_member` for the invitation, `apply_room_assignments` for staffing —
     * so the fixture exercises the same eligibility rules a real administrator does and a
     * passing test says something about what the server actually permits.
     */
    readonly withColleagues?: {
      /** Additional provisioned members, optionally staffed into `roomTitle`. */
      readonly members?: readonly {
        readonly globalRole: 'admin' | 'member';
        readonly state?: 'active' | 'disabled';
        readonly staffAs?: 'manager' | 'contributor';
      }[];
      /** A real pending invitation, which has no member row and holds nothing. */
      readonly invitation?: { readonly intendedRole: 'admin' | 'member' };
      /** Extra rooms, so the register and the staffing dialog have several to choose. */
      readonly extraRooms?: readonly string[];
    };
  }): Promise<{
    readonly cookies: readonly { name: string; value: string; url: string }[];
    readonly memberId: string;
    readonly roomId: string | null;
    /** Seeded colleagues, in the order requested. */
    readonly colleagueIds: readonly string[];
  }>;
  /**
   * Seeds an active viewer holding a real grant on a published room containing one
   * readable document, and returns the cookies a browser would hold.
   *
   * The session is issued through the same `issueSession` path OTP verification
   * uses, and the grant, publication, and processed version are all real rows, so
   * every request the reading room makes is authorized by the real authorizer. A
   * harness that stubbed the client's view of access would render the surface while
   * proving nothing about who may read what.
   */
  signInViewer(input?: {
    readonly roomTitle?: string;
    readonly documentTitle?: string;
    readonly downloadPolicy?: 'allow' | 'deny';
    /** When false, no grant is created: the viewer should reach nothing. */
    readonly granted?: boolean;
  }): Promise<{
    readonly cookies: readonly { name: string; value: string; url: string }[];
    readonly viewerId: string;
    readonly roomId: string;
    readonly documentId: string;
  }>;
  readonly migrationPool: Pool;
  close(): Promise<void>;
}

function databaseUrl(name: string, fallbackUser: string, fallbackPassword: string): string {
  return (
    process.env[name] ??
    `postgresql://${fallbackUser}:${fallbackPassword}@127.0.0.1:5432/duefold_test`
  );
}

export async function startTestServer(
  options: {
    /** Page image served for every derivative; the README screenshots pass a synthetic page. */
    readonly pageImage?: Uint8Array;
    /** Use the production sandboxed compositor, required by screenshot evidence. */
    readonly realWatermark?: boolean;
  } = {},
): Promise<TestServer> {
  const imageMagick = ['/usr/bin/magick', '/usr/bin/convert'].find(existsSync);
  const watermarkProgram =
    options.realWatermark === true
      ? imageMagick === undefined
        ? (() => {
            throw new Error('README_SCREENSHOT_IMAGEMAGICK_MISSING');
          })()
        : sandboxProgram(process.execPath, [
            fileURLToPath(
              new URL(
                '../../modules/rooms-documents/src/processing/watermark-adapter.ts',
                import.meta.url,
              ),
            ),
            imageMagick,
          ])
      : sandboxProgram(process.execPath, [
          fileURLToPath(new URL('../fixtures/watermark-compositor.ts', import.meta.url)),
        ]);
  const bootstrapPool = new Pool({
    host: '/var/run/postgresql',
    database: 'duefold_test',
  });
  const migrationPool = new Pool({
    connectionString: databaseUrl(
      'DUEFOLD_TEST_MIGRATION_DATABASE_URL',
      'duefold_migration',
      'duefold_local_migration',
    ),
  });
  const runtimePool = new Pool({
    connectionString: databaseUrl(
      'DUEFOLD_TEST_DATABASE_URL',
      'duefold_runtime',
      'duefold_local_runtime',
    ),
  });
  const authPool = new Pool({
    connectionString: databaseUrl(
      'DUEFOLD_TEST_AUTH_DATABASE_URL',
      'duefold_authenticator',
      'duefold_local_authenticator',
    ),
  });
  const workerPool = new Pool({
    connectionString: databaseUrl(
      'DUEFOLD_TEST_WORKER_DATABASE_URL',
      'duefold_worker',
      'duefold_local_worker',
    ),
  });

  await bootstrapPool.query(
    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; ALTER SCHEMA public OWNER TO duefold_migration;',
  );
  await migrate(migrationPool, generatedMigrations);
  // The schema requires one organization AND exactly one active Owner, so both
  // are seeded in one transaction. The Owner exists because the installation
  // must have one; the browser tests do not sign in as it, because member
  // sign-in requires a live identity provider.
  const seed = await migrationPool.connect();
  try {
    await seed.query('BEGIN');
    await seed.query("INSERT INTO organization (id,name) VALUES ($1,'Northwind Capital')", [
      createOpaqueId(),
    ]);
    await seed.query(
      `INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
       VALUES ($1,'owner@example.com','owner@example.com','https://issuer.invalid','browser-owner','owner','active')`,
      [createOpaqueId()],
    );
    await seed.query('COMMIT');
  } catch (error) {
    await seed.query('ROLLBACK');
    throw error;
  } finally {
    seed.release();
  }

  const otpDigestKey = Buffer.alloc(32, 7).toString('base64url');
  const codes = new Map<string, string>();
  const deliveryHandler = createOtpDeliveryHandler({
    pool: workerPool,
    otpDigestKey,
    clock: systemClock,
    mailer: {
      deliver: (message) => {
        codes.set(message.emailDisplay.toLowerCase(), message.code);
        return Promise.resolve();
      },
      close: () => undefined,
    },
  });
  const runner = new JobRunner(workerPool, new Map([['auth.otp.deliver', deliveryHandler]]));

  const oidcConfig = new oidc.Configuration(
    {
      issuer: 'https://issuer.invalid',
      authorization_endpoint: 'https://issuer.invalid/authorize',
      token_endpoint: 'https://issuer.invalid/token',
      jwks_uri: 'https://issuer.invalid/jwks',
    },
    'duefold-browser-test',
  );

  const runtime: WebRuntime = {
    pool: runtimePool,
    authPool,
    oidc: oidcConfig,
    oidcRedirectUri: 'https://127.0.0.1/api/auth/oidc/callback',
    ownerAllowlist: ['owner@example.com'],
    organizationName: 'Northwind Capital',
    afterAuthenticationPath: '/',
    otpDigestKey,
    networkHmacKey: Buffer.alloc(32, 9).toString('base64url'),
    sessionPolicy: { idleMinutes: 30, absoluteHours: 12 },
    clock: systemClock,
    storage: unusedStorage,
    deliveryStorage: harnessDeliveryStorage(options.pageImage),
    /*
     * A real spawn of a fixture that speaks the production argv and envelope
     * contract (`watermark-page --stdin-envelope`) and asserts the three required
     * marks are present. Pointing this at a bare interpreter would let a
     * regression that stops attributing pages pass unnoticed.
     */
    watermarkProgram,
    classifyClient: () => ({ browser: 'chromium', os: 'linux', device: 'desktop' }),
    deliverOtp: () => Promise.resolve(),
    revokeSession: async (sessionId) => {
      await authPool.query(
        "UPDATE session SET state = 'revoked' WHERE id = $1 AND state = 'active'",
        [sessionId],
      );
      await authPool.query(
        `INSERT INTO audit_event (id,event_type,actor_kind,subject_id,result,reason_code,correlation_id)
         VALUES ($1,'session.revoked','system',$2,'success','SIGN_OUT',$3)`,
        [createOpaqueId(), sessionId, `corr_${createOpaqueId()}`],
      );
    },
  };

  const tls = loopbackTls();
  const app = await buildTestWebApp({
    runtime,
    authenticate: createSessionAuthenticator(authPool, runtime.sessionPolicy),
    staticClient: await loadStaticClient(CLIENT_DIST),
    https: tls,
    // See close() below: the browser holds keep-alive sockets past the last test.
    forceCloseConnections: true,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string')
    throw new Error('test server did not bind a port');

  return {
    baseUrl: `https://127.0.0.1:${address.port}`,
    async setSupportContact(value) {
      await migrationPool.query(
        `INSERT INTO branding_configuration (singleton,support_contact_kind,support_contact)
         VALUES (true,'email',$1)
         ON CONFLICT (singleton) DO UPDATE
           SET support_contact_kind='email', support_contact=EXCLUDED.support_contact`,
        [value],
      );
    },
    async deliveredCode(email) {
      const key = email.toLowerCase();
      for (let attempt = 0; attempt < 40 && !codes.has(key); attempt += 1) {
        await runner.runOne();
        if (!codes.has(key)) await new Promise((done) => setTimeout(done, 25));
      }
      const code = codes.get(key);
      if (code === undefined) throw new Error(`no OTP delivered for ${email}`);
      codes.delete(key);
      return code;
    },
    async inviteViewer(email) {
      await migrationPool.query(
        `INSERT INTO viewer (id,email_key,email_display,session_family_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (email_key) DO NOTHING`,
        [createOpaqueId(), email.toLowerCase(), email, createOpaqueId()],
      );
      await migrationPool.query(
        `INSERT INTO invitation (id,kind,email_key,email_display,state,expires_at)
         VALUES ($1,'viewer',$2,$3,'pending',transaction_timestamp() + interval '7 days')`,
        [createOpaqueId(), email.toLowerCase(), email],
      );
    },
    async signInMember(input) {
      const memberId = createOpaqueId();
      const local = `m${memberId.slice(0, 10).toLowerCase()}`;
      const globalRole = input.globalRole ?? 'member';
      const client = await migrationPool.connect();
      try {
        await client.query('BEGIN');
        /*
         * An existing active Owner is DEMOTED first when this member will be one.
         *
         * `one_active_owner` is a partial unique index: exactly one active Owner per
         * installation (§4.1), which is the invariant, not a fixture inconvenience. Several
         * cases in a file each need an Owner session, so rather than relaxing the rule the
         * previous holder becomes an Admin — the same end state `transfer_ownership`
         * produces. Demoting before inserting keeps the index satisfied at every moment,
         * because a partial unique index is checked per statement and not at commit.
         */
        if (globalRole === 'owner')
          await client.query(
            "UPDATE member SET global_role='admin' WHERE global_role='owner' AND state='active'",
          );
        await client.query(
          `INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
           VALUES ($1,$2,$2,'https://issuer.example',$1,$3,'active')`,
          [memberId, `${local}@member.invalid`, globalRole],
        );
        // Exactly one organization and one active Owner. The row is
        // inserted only when this harness is seeding its first member.
        await client.query(
          `INSERT INTO organization (id,name)
           SELECT $1,'Workspace browser' WHERE NOT EXISTS (SELECT 1 FROM organization)`,
          [createOpaqueId()],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      let roomId: string | null = null;
      if (input.roomTitle !== undefined) {
        roomId = createOpaqueId();
        // Room creation requires owner/admin, so it is performed by a seeded owner
        // rather than by relaxing the server's rule for the test.
        const ownerId = createOpaqueId();
        const ownerLocal = `o${ownerId.slice(0, 10).toLowerCase()}`;
        await migrationPool.query(
          `INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
           VALUES ($1,$2,$2,'https://issuer.example',$1,'admin','active')`,
          [ownerId, `${ownerLocal}@member.invalid`],
        );
        await runtimePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
          roomId,
          input.roomTitle,
          '',
          ownerId,
          createOpaqueId(),
          createCorrelationId(),
        ]);
        if (input.roomRole !== undefined)
          /*
           * Staffed through the audited function, not by inserting the row.
           * `duefold_runtime` holds SELECT alone on `room_assignment`, because a
           * credential that could grant a room privilege with no administrator check
           * and no audit row would make that boundary bypassable. Seeding the way the
           * product does also means this fixture exercises the same eligibility rules
           * a real staffing action does.
           */
          await runtimePool.query(
            'SELECT apply_room_assignments($1,$2::jsonb,$3::jsonb,$4,$5,$6)',
            [
              memberId,
              JSON.stringify([{ roomId, roomRole: input.roomRole }]),
              '[]',
              ownerId,
              createOpaqueId(),
              createCorrelationId(),
            ],
          );

        /*
         * A real viewer membership and a real grant, created through the same
         * SECURITY DEFINER functions the product uses. Seeding grant rows directly
         * would bypass the authorization the participants reader depends on, and a
         * passing test would prove nothing about what a Manager can actually see.
         */
        if (input.withParticipant !== undefined) {
          const participantEmail = input.withParticipant.email;
          const viewerId = createOpaqueId();
          await migrationPool.query(
            `INSERT INTO viewer (id,email_key,email_display,session_family_id)
             VALUES ($1,$2,$3,$4) ON CONFLICT (email_key) DO NOTHING`,
            [viewerId, participantEmail.toLowerCase(), participantEmail, createOpaqueId()],
          );
          const seededViewerId =
            (
              await migrationPool.query<{ id: string }>(
                'SELECT id FROM viewer WHERE email_key=$1',
                [participantEmail.toLowerCase()],
              )
            ).rows[0]?.id ?? viewerId;
          const roomRevision = async (): Promise<number> =>
            (
              await migrationPool.query<{ revision: number }>(
                'SELECT revision FROM room WHERE id=$1',
                [roomId],
              )
            ).rows[0]?.revision ?? 1;
          await runtimePool.query('SELECT add_viewer_to_room($1,$2,$3,$4,$5,$6,$7)', [
            createOpaqueId(),
            seededViewerId,
            roomId,
            ownerId,
            await roomRevision(),
            createOpaqueId(),
            createCorrelationId(),
          ]);
          const mode = input.withParticipant.grant ?? 'active';
          if (mode !== 'none') {
            /*
             * An EXPIRED grant is created by applying a live one and then moving its
             * expiry into the past, because the apply path refuses a past expiry
             * outright. This produces the real lapsed row the reader reports with
             * `effective: false`.
             */
            const expiry = new Date(Date.now() + 86_400_000);
            const grantArgs = [
              ownerId,
              roomId,
              'grant',
              createOpaqueId(),
              'viewer',
              seededViewerId,
              null,
              'room',
              null,
              null,
              expiry,
            ];
            const impact = (
              await runtimePool.query<{
                dry_run_grant_change: { confirmation: string };
              }>('SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', grantArgs)
            ).rows[0]?.dry_run_grant_change;
            if (impact === undefined) throw new Error('GRANT_IMPACT_ABSENT');
            await runtimePool.query(
              'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
              [
                ...grantArgs,
                await roomRevision(),
                systemClock.now(),
                impact.confirmation,
                createOpaqueId(),
                createCorrelationId(),
              ],
            );
            if (mode === 'expired')
              await migrationPool.query(
                `UPDATE access_grant SET expires_at = transaction_timestamp() - interval '1 day'
                 WHERE room_id=$1 AND viewer_id=$2`,
                [roomId, seededViewerId],
              );
          }
        }

        /*
         * Document versions in real processing states. The state machine in 003
         * only permits quarantine -> {failed states}, so each row is inserted at
         * quarantine and transitioned, rather than inserted directly into a
         * terminal state the trigger would reject.
         */
        for (const seedVersion of input.withProcessing ?? []) {
          const documentId = createOpaqueId();
          const versionId = createOpaqueId();
          await migrationPool.query(
            'INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,$3,$4)',
            [documentId, roomId, seedVersion.title, ownerId],
          );
          await migrationPool.query(
            `INSERT INTO document_version(id,document_id,original_filename,object_key,
             declared_media_type,size_bytes,sha256,state)
             VALUES($1,$2,'private-source.pdf',$3,'application/pdf',2048,$4,'quarantine')`,
            [
              versionId,
              documentId,
              `quarantine/${createOpaqueId()}/${createOpaqueId()}`,
              'b'.repeat(64),
            ],
          );
          if (seedVersion.state !== 'quarantine') {
            const failureKind =
              seedVersion.state === 'malware_quarantined'
                ? 'malware'
                : seedVersion.state === 'rejected'
                  ? 'deterministic'
                  : 'transient';
            await migrationPool.query(
              `UPDATE document_version SET state=$2,failure_kind=$3,failure_code=$4,
                 retained_until=transaction_timestamp() + interval '30 days'
               WHERE id=$1`,
              [versionId, seedVersion.state, failureKind, 'SEEDED'],
            );
            if ((seedVersion.manualRetryCount ?? 0) > 0)
              await migrationPool.query(
                `UPDATE document_version SET state='quarantine',manual_retry_count=1,
                   failure_kind=NULL,failure_code=NULL,retained_until=NULL WHERE id=$1`,
                [versionId],
              );
            if ((seedVersion.manualRetryCount ?? 0) > 0)
              await migrationPool.query(
                `UPDATE document_version SET state='processing_failed',failure_kind='transient',
                   failure_code='SEEDED',retained_until=transaction_timestamp() + interval '30 days'
                 WHERE id=$1`,
                [versionId],
              );
          }
          await migrationPool.query(
            `INSERT INTO working_structure_entry(id,room_id,folder_id,document_id,parent_folder_id,display_name,order_key)
             VALUES($1,$2,NULL,$3,NULL,$4,$5)`,
            [createOpaqueId(), roomId, documentId, seedVersion.title, Date.now() % 100000],
          );
        }
      }

      /*
       * Colleagues, a pending invitation, and extra rooms for the Members surface.
       *
       * Seeded through the audited functions rather than by inserting rows: migration 017
       * leaves `duefold_runtime` with no INSERT on `invitation` and SELECT alone on
       * `room_assignment`, so a fixture that wrote them directly would be exercising a
       * privilege the product does not have. The acting administrator is a seeded Owner,
       * because these functions authorize their caller.
       */
      const colleagueIds: string[] = [];
      if (input.withColleagues !== undefined) {
        /*
         * The ACTING administrator is this member when they are an Owner or Admin, because
         * these functions authorize their caller and `one_active_owner` admits only one
         * active Owner. A separate seeding Owner would collide with it.
         */
        const seedOwnerId =
          globalRole === 'owner' || globalRole === 'admin' ? memberId : createOpaqueId();
        if (seedOwnerId !== memberId) {
          const seedOwnerLocal = `a${seedOwnerId.slice(0, 10).toLowerCase()}`;
          await migrationPool.query(
            `INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
             VALUES ($1,$2,$2,'https://issuer.example',$1,'admin','active')`,
            [seedOwnerId, `${seedOwnerLocal}@member.invalid`],
          );
        }

        for (const room of input.withColleagues.extraRooms ?? [])
          await runtimePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
            createOpaqueId(),
            room,
            '',
            seedOwnerId,
            createOpaqueId(),
            createCorrelationId(),
          ]);

        for (const colleague of input.withColleagues.members ?? []) {
          const colleagueId = createOpaqueId();
          const colleagueLocal = `c${colleagueId.slice(0, 10).toLowerCase()}`;
          await migrationPool.query(
            `INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
             VALUES ($1,$2,$2,'https://issuer.example',$1,$3,'active')`,
            [colleagueId, `${colleagueLocal}@member.invalid`, colleague.globalRole],
          );
          /* Staffed while still active and a plain Member, which is the only state
             `apply_room_assignments` accepts as a target. */
          if (colleague.staffAs !== undefined && roomId !== null)
            await runtimePool.query(
              'SELECT apply_room_assignments($1,$2::jsonb,$3::jsonb,$4,$5,$6)',
              [
                colleagueId,
                JSON.stringify([{ roomId, roomRole: colleague.staffAs }]),
                '[]',
                seedOwnerId,
                createOpaqueId(),
                createCorrelationId(),
              ],
            );
          /* Disabled last, so staffing above ran against an eligible target. */
          if (colleague.state === 'disabled')
            await runtimePool.query('SELECT set_member_state($1,$2,$3,$4,$5,$6)', [
              colleagueId,
              'disabled',
              seedOwnerId,
              1,
              createOpaqueId(),
              createCorrelationId(),
            ]);
          colleagueIds.push(colleagueId);
        }

        if (input.withColleagues.invitation !== undefined) {
          const invitedId = createOpaqueId();
          const invitedLocal = `i${invitedId.slice(0, 10).toLowerCase()}`;
          await runtimePool.query('SELECT invite_member($1,$2,$3,$4,$5,$6,$7,$8)', [
            invitedId,
            `${invitedLocal}@member.invalid`,
            `${invitedLocal}@member.invalid`,
            input.withColleagues.invitation.intendedRole,
            seedOwnerId,
            createOpaqueId(),
            createOpaqueId(),
            createCorrelationId(),
          ]);
        }
      }

      const session = await issueSession(
        authPool,
        // oidcAuthenticatedAt is what the fresh-OIDC gate on publication reads, so
        // it is set to now: a stale value would make every publish attempt fail for
        // the wrong reason.
        { kind: 'member', id: memberId, oidcAuthenticatedAt: systemClock.now() },
        'oidc',
        systemClock,
        runtime.sessionPolicy,
      );
      return {
        memberId,
        roomId,
        colleagueIds,
        cookies: [
          {
            name: SESSION_COOKIE,
            value: session.secret,
            url: `https://127.0.0.1:${address.port}`,
          },
          {
            name: CSRF_COOKIE,
            value: session.csrfToken,
            url: `https://127.0.0.1:${address.port}`,
          },
        ],
      };
    },
    async signInViewer(input = {}) {
      const granted = input.granted ?? true;
      const viewerId = createOpaqueId();
      const roomId = createOpaqueId();
      const documentId = createOpaqueId();
      const versionId = createOpaqueId();
      const folderEntryId = createOpaqueId();
      const documentEntryId = createOpaqueId();
      const jobId = createOpaqueId();
      const leaseToken = createOpaqueId();
      const managerId = createOpaqueId();
      const managerLocal = `v${managerId.slice(0, 10).toLowerCase()}`;
      const local = `r${viewerId.slice(0, 10).toLowerCase()}`;
      const email = `${local}@viewer.invalid`;
      const audit = (): readonly string[] => [createOpaqueId(), createCorrelationId()];

      const client = await migrationPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO member (id,email_key,email_display,oidc_issuer,oidc_subject,global_role,state)
           VALUES ($1,$2,$2,'https://issuer.example',$1,'admin','active')`,
          [managerId, `${managerLocal}@member.invalid`],
        );
        await client.query(
          `INSERT INTO organization (id,name)
           SELECT $1,'Viewer browser' WHERE NOT EXISTS (SELECT 1 FROM organization)`,
          [createOpaqueId()],
        );
        await client.query(
          `INSERT INTO viewer (id,email_key,email_display,session_family_id)
           VALUES ($1,$2,$3,$4)`,
          [viewerId, email, email, createOpaqueId()],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      await runtimePool.query('SELECT create_room($1,$2,$3,$4,$5,$6)', [
        roomId,
        input.roomTitle ?? 'Series B diligence',
        '',
        managerId,
        ...audit(),
      ]);
      await migrationPool.query(
        'INSERT INTO document(id,room_id,display_title,created_by) VALUES($1,$2,$3,$4)',
        [documentId, roomId, input.documentTitle ?? 'Investor model', managerId],
      );
      // The structure entry references a real folder row in the same room; the
      // integrity trigger rejects an entry whose folder does not exist there.
      await migrationPool.query('INSERT INTO folder(id,room_id,created_by) VALUES($1,$2,$3)', [
        folderEntryId,
        roomId,
        managerId,
      ]);
      /*
       * A readable version needs real processing evidence: publication is gated on
       * a clean scan with a matching signature version AND a verified derivative.
       * Seeding a bare `ready_for_review` row would be the forged-evidence path the
       * security kernel exists to refuse.
       */
      await migrationPool.query(
        `INSERT INTO job_queue(id,job_type,idempotency_key,payload,state,attempts,lease_owner,lease_token,lease_expires_at)
         VALUES($1,'document.source.validate',$2,jsonb_build_object('versionId',$3::text),'running',1,$4,$5,
           transaction_timestamp()+interval '1 hour')`,
        [jobId, createOpaqueId(), versionId, createOpaqueId(), leaseToken],
      );
      await migrationPool.query(
        `INSERT INTO document_version(id,document_id,original_filename,object_key,declared_media_type,
         detected_media_type,size_bytes,sha256,state,scan_signature_version)
         VALUES($1,$2,'model.pdf',$3,'application/pdf','application/pdf',2048,$4,'ready_for_review','1')`,
        [
          versionId,
          documentId,
          `quarantine/${createOpaqueId()}/${createOpaqueId()}`,
          'a'.repeat(64),
        ],
      );
      await migrationPool.query(
        `INSERT INTO document_scan_evidence(version_id,job_id,lease_token,signature_version,signatures_published_at)
         VALUES($1,$2,$3,'1',transaction_timestamp())`,
        [versionId, jobId, leaseToken],
      );
      for (const page of [1, 2])
        await migrationPool.query(
          `INSERT INTO document_derivative(id,version_id,page_number,object_key,media_type,size_bytes,sha256,width,height,accessible_label,text_layer)
           VALUES($1,$2,$3,$4,'image/png',256,$5,1200,1600,$6,$7::jsonb)`,
          [
            createOpaqueId(),
            versionId,
            page,
            `derivatives/${createOpaqueId()}/${createOpaqueId()}`,
            String(page).repeat(64).slice(0, 64),
            `Page ${String(page)}`,
            /*
             * The column holds the positioned-run ARRAY itself, not an object
             * wrapping it: a check constraint enforces `jsonb_typeof = 'array'`.
             */
            JSON.stringify([
              {
                text: page === 1 ? 'Revenue grew to 4.2M in 2026' : 'Appendix and résumé',
                x: 0.1,
                y: 0.1,
                width: 0.6,
                height: 0.03,
              },
            ]),
          ],
        );
      await migrationPool.query(
        `INSERT INTO working_structure_entry(id,room_id,folder_id,document_id,parent_folder_id,display_name,order_key)
         VALUES($1,$2,$1,NULL,NULL,'Financials',1000),
           ($3,$2,NULL,$4,$1,$5,2000)`,
        [
          folderEntryId,
          roomId,
          documentEntryId,
          documentId,
          input.documentTitle ?? 'Investor model',
        ],
      );
      await migrationPool.query(
        `INSERT INTO published_structure_entry(room_id,entry_id,resource_kind,resource_id,parent_folder_id,display_name,description,order_key,source_revision,published_version_id)
         VALUES($1,$2,'folder',$2,NULL,'Financials','',1000,1,NULL),
           ($1,$3,'document',$4,$2,$5,'',2000,1,$6)`,
        [
          roomId,
          folderEntryId,
          documentEntryId,
          documentId,
          input.documentTitle ?? 'Investor model',
          versionId,
        ],
      );
      await migrationPool.query(
        "UPDATE room SET state='published', published_revision=1 WHERE id=$1",
        [roomId],
      );
      await migrationPool.query(
        "UPDATE branding_configuration SET room_introduction='Materials prepared for your review.'",
      );
      if (input.downloadPolicy === 'allow') {
        const revision = (
          await migrationPool.query<{ revision: number }>(
            'SELECT revision FROM document WHERE id=$1',
            [documentId],
          )
        ).rows[0]?.revision;
        await runtimePool.query('SELECT set_document_download_policy($1,$2,$3,$4,$5,$6)', [
          managerId,
          documentId,
          'allow',
          revision ?? 1,
          ...audit(),
        ]);
      }

      if (granted) {
        await runtimePool.query('SELECT add_viewer_to_room($1,$2,$3,$4,$5,$6,$7)', [
          createOpaqueId(),
          viewerId,
          roomId,
          managerId,
          1,
          ...audit(),
        ]);
        const grantArgs = [
          managerId,
          roomId,
          'grant',
          createOpaqueId(),
          'viewer',
          viewerId,
          null,
          'room',
          null,
          null,
          null,
        ];
        const impact = (
          await runtimePool.query<{
            dry_run_grant_change: { confirmation: string };
          }>('SELECT dry_run_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', grantArgs)
        ).rows[0]?.dry_run_grant_change;
        if (impact === undefined) throw new Error('GRANT_IMPACT_ABSENT');
        const revision = (
          await migrationPool.query<{ revision: number }>(
            'SELECT revision FROM room WHERE id=$1',
            [roomId],
          )
        ).rows[0]?.revision;
        await runtimePool.query(
          'SELECT apply_grant_change($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
          [...grantArgs, revision ?? 1, systemClock.now(), impact.confirmation, ...audit()],
        );
      }

      const session = await issueSession(
        authPool,
        { kind: 'viewer', id: viewerId },
        'otp',
        systemClock,
        runtime.sessionPolicy,
      );
      return {
        viewerId,
        roomId,
        documentId,
        cookies: [
          {
            name: SESSION_COOKIE,
            value: session.secret,
            url: `https://127.0.0.1:${address.port}`,
          },
          {
            name: CSRF_COOKIE,
            value: session.csrfToken,
            url: `https://127.0.0.1:${address.port}`,
          },
        ],
      };
    },
    migrationPool,
    async close() {
      /*
       * Firefox keeps HTTPS keep-alive sockets open after the last assertion, and
       * `app.close()` waits for every connection to drain, so teardown exceeded the
       * 30s afterAll budget in roughly half of runs. The failure surfaced against
       * whichever test happened to be last, which made it look like an unrelated
       * flake in that test rather than a teardown problem.
       *
       * `forceCloseConnections` is a SERVER option, not a close() argument, so it
       * is set where the harness app is built. It is correct for a harness: no
       * in-flight request is worth draining once the suite is over.
       */
      await app.close();
      await authPool.end();
      await runtimePool.end();
      await workerPool.end();
      await migrationPool.end();
      await bootstrapPool.end();
    },
  };
}

export {};
