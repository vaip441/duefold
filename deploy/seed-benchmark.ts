/**
 * Generates reference benchmark fixtures for performance qualification.
 *
 * Populates:
 *   - 1 published room with a 5-level folder tree
 *   - N documents (default 10,000) with ready versions and published entries
 *   - V viewers (default 100) with active room memberships and access grants
 *   - V active sessions issued for k6 load generation
 *   - M audit events (default 1,000,000) inserted in batches
 *
 * Emits `viewer-tokens.json` for consumption by `deploy/k6/viewer-steady-state.js`.
 *
 * Usage:
 *   node deploy/seed-benchmark.ts [--documents 10000] [--audit-events 1000000] [--viewers 100] [--out ./deploy/k6/viewer-tokens.json]
 *   Or scaled down for fast test-run:
 *   node deploy/seed-benchmark.ts --documents 50 --audit-events 200 --viewers 10
 */

import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createCorrelationId, createOpaqueId } from '../packages/shared/src/ids.ts';
import {
  createWorkerStorage,
  workerStorageConfig,
} from '../modules/rooms-documents/src/storage/s3-compatible.ts';

interface SeedOptions {
  readonly documents: number;
  readonly auditEvents: number;
  readonly viewers: number;
  readonly outPath: string;
}

function parseArgs(): SeedOptions {
  const args = process.argv.slice(2);
  let documents = 10_000;
  let auditEvents = 1_000_000;
  let viewers = 100;
  let outPath = 'deploy/k6/viewer-tokens.json';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--documents' && next !== undefined) {
      documents = Math.max(1, Number.parseInt(next, 10));
      i += 1;
    } else if (arg === '--audit-events' && next !== undefined) {
      auditEvents = Math.max(0, Number.parseInt(next, 10));
      i += 1;
    } else if (arg === '--viewers' && next !== undefined) {
      viewers = Math.max(1, Number.parseInt(next, 10));
      i += 1;
    } else if (arg === '--out' && next !== undefined) {
      outPath = next;
      i += 1;
    }
  }

  return { documents, auditEvents, viewers, outPath };
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface ViewerToken {
  readonly viewerId: string;
  readonly secret: string;
  readonly csrfToken: string;
  readonly deniedRoomId: string;
  readonly deniedDocumentId: string;
}

const BENCHMARK_PAGE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name}_REQUIRED`);
  return value;
}

function booleanEnvironment(name: string): boolean {
  const value = process.env[name];
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name}_REQUIRED`);
}

async function main(): Promise<void> {
  const options = parseArgs();
  const migrationUrl =
    process.env['DUEFOLD_MIGRATION_DATABASE_URL'] ??
    process.env['DUEFOLD_TEST_MIGRATION_DATABASE_URL'] ??
    'postgresql://duefold_migration:duefold_local_migration@127.0.0.1:5432/duefold_test';
  const authUrl =
    process.env['DUEFOLD_AUTH_DATABASE_URL'] ??
    process.env['DUEFOLD_TEST_AUTH_DATABASE_URL'] ??
    'postgresql://duefold_authenticator:duefold_local_authenticator@127.0.0.1:5432/duefold_test';

  const migrationPool = new Pool({ connectionString: migrationUrl });
  const authPool = new Pool({ connectionString: authUrl });
  const workerStorage = createWorkerStorage(
    workerStorageConfig({
      endpoint: requiredEnvironment('DUEFOLD_STORAGE_ENDPOINT'),
      region: requiredEnvironment('DUEFOLD_STORAGE_REGION'),
      bucket: requiredEnvironment('DUEFOLD_STORAGE_BUCKET'),
      credentials: {
        accessKeyId: requiredEnvironment('DUEFOLD_STORAGE_WORKER_ACCESS_KEY_ID'),
        secretAccessKey: requiredEnvironment('DUEFOLD_STORAGE_WORKER_SECRET_ACCESS_KEY'),
      },
      pathStyle: booleanEnvironment('DUEFOLD_STORAGE_PATH_STYLE'),
      checksumSupport: booleanEnvironment('DUEFOLD_STORAGE_CHECKSUM_SUPPORT'),
    }),
  );
  const pageShaHex = sha256Hex(BENCHMARK_PAGE);
  const pageShaBase64 = createHash('sha256').update(BENCHMARK_PAGE).digest('base64');

  try {
    process.stdout.write(
      `Seeding benchmark corpus: ${options.documents} documents, ${options.auditEvents} audit events, ${options.viewers} viewers...\n`,
    );

    const client = await migrationPool.connect();
    let ownerId: string;
    let roomId: string;
    let deniedRoomId: string;
    let deniedDocumentId: string;

    try {
      await client.query('BEGIN');

      // 1. Ensure owner/manager first (enforce_exactly_one_owner is deferred to commit)
      const initialOwnerId = createOpaqueId();
      const memberRow = (
        await client.query<{ id: string }>(
          `INSERT INTO member (id, email_key, email_display, oidc_issuer, oidc_subject, global_role, state)
           VALUES ($1, 'bench-manager@example.com', 'bench-manager@example.com', 'https://issuer.example', $1, 'owner', 'active')
           ON CONFLICT (email_key) DO UPDATE SET state = 'active', global_role = 'owner'
           RETURNING id`,
          [initialOwnerId],
        )
      ).rows[0];
      ownerId = memberRow?.id ?? initialOwnerId;

      // 2. Ensure organization
      const orgId = createOpaqueId();
      await client.query(
        `INSERT INTO organization (singleton, id, name)
         VALUES (true, $1, 'Benchmark Org')
         ON CONFLICT (singleton) DO UPDATE SET name = EXCLUDED.name`,
        [orgId],
      );

      // 3. Create published room
      roomId = createOpaqueId();
      await client.query(
        `INSERT INTO room (id, title, state, published_revision, published_at, working_revision)
         VALUES ($1, 'Reference Benchmark Room', 'published', 1, statement_timestamp(), 1)`,
        [roomId],
      );

      // 4. Create 5-level folder tree
      let parentFolderId: string | null = null;
      for (let level = 1; level <= 5; level += 1) {
        const folderId = createOpaqueId();
        const entryId = createOpaqueId();
        await client.query(
          'INSERT INTO folder (id, room_id, created_by, description) VALUES ($1, $2, $3, $4)',
          [folderId, roomId, ownerId, `Level ${level} folder`],
        );
        await client.query(
          `INSERT INTO published_structure_entry
             (room_id, entry_id, resource_kind, resource_id, parent_folder_id, display_name, description, order_key, source_revision, published_version_id)
           VALUES ($1, $2, 'folder', $3, $4, $5, '', $6, 1, NULL)`,
          [roomId, entryId, folderId, parentFolderId, `Directory Level ${level}`, level * 100],
        );
        parentFolderId = folderId;
      }

      // A second published room is intentionally not granted to benchmark viewers.
      deniedRoomId = createOpaqueId();
      deniedDocumentId = createOpaqueId();
      const deniedVersionId = createOpaqueId();
      await client.query(
        `INSERT INTO room (id, title, state, published_revision, published_at, working_revision)
         VALUES ($1, 'Inaccessible Benchmark Room', 'published', 1, statement_timestamp(), 1)`,
        [deniedRoomId],
      );
      await client.query(
        `INSERT INTO document (id, room_id, display_title, created_by, description, revision, download_policy)
         VALUES ($1, $2, 'Inaccessible document', $3, '', 1, 'deny')`,
        [deniedDocumentId, deniedRoomId, ownerId],
      );
      await client.query(
        `INSERT INTO document_version (id, document_id, original_filename, object_key,
           declared_media_type, detected_media_type, size_bytes, sha256, processing_attempts,
           state, scan_signature_version, manual_retry_count, hidden_sheet_warning)
         VALUES ($1, $2, 'inaccessible.pdf', $3, 'application/pdf', 'application/pdf',
           2048, $4, 1, 'ready_for_review', '2026.1', 0, false)`,
        [
          deniedVersionId,
          deniedDocumentId,
          `quarantine/${createOpaqueId()}/${createOpaqueId()}`,
          sha256Hex('inaccessible-benchmark-content'),
        ],
      );
      await client.query('UPDATE document SET working_version_id=$1 WHERE id=$2', [
        deniedVersionId,
        deniedDocumentId,
      ]);
      await client.query(
        `INSERT INTO published_structure_entry
           (room_id, entry_id, resource_kind, resource_id, parent_folder_id, display_name,
            description, order_key, source_revision, published_version_id)
         VALUES ($1, $2, 'document', $3, NULL, 'Inaccessible document', '', 100, 1, $4)`,
        [deniedRoomId, createOpaqueId(), deniedDocumentId, deniedVersionId],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // 5. Bulk insert documents + versions + published structure entries in batches
    process.stdout.write(`Inserting ${options.documents} documents...\n`);
    const batchSize = 500;
    for (let offset = 0; offset < options.documents; offset += batchSize) {
      const count = Math.min(batchSize, options.documents - offset);
      const clientBatch = await migrationPool.connect();
      try {
        await clientBatch.query('BEGIN');
        const docRows: string[] = [];
        const verRows: string[] = [];
        const pubRows: string[] = [];
        const derivativeRows: string[] = [];
        const versionByDocument = new Map<string, string>();
        const derivativeUploads: (() => Promise<void>)[] = [];

        for (let i = 0; i < count; i += 1) {
          const docNum = offset + i + 1;
          const docId = createOpaqueId();
          const verId = createOpaqueId();
          const entryId = createOpaqueId();
          const sha = sha256Hex(`bench-content-${docNum}`);
          const objKey = `quarantine/${createOpaqueId()}/${createOpaqueId()}`;
          const derivativeKey = `derivatives/${createOpaqueId()}/${createOpaqueId()}`;
          const orderKey = (docNum * 10).toString();
          versionByDocument.set(docId, verId);

          docRows.push(
            `('${docId}', '${roomId}', 'Document ${docNum}', '${ownerId}', statement_timestamp(), 'Benchmark document ${docNum}', 1, NULL, 'allow')`,
          );
          verRows.push(
            `('${verId}', '${docId}', 'doc-${docNum}.pdf', '${objKey}', 'application/pdf', 'application/pdf', 2048, '${sha}', 1, 'ready_for_review', '2026.1', 0, false)`,
          );
          pubRows.push(
            `('${roomId}', '${entryId}', 'document', '${docId}', NULL, 'Document ${docNum}', 'Benchmark document ${docNum}', ${orderKey}, 1, '${verId}')`,
          );
          derivativeRows.push(
            `('${createOpaqueId()}', '${verId}', 1, '${derivativeKey}', 'image/png', ${BENCHMARK_PAGE.byteLength}, '${pageShaHex}', 1, 1, 'Page 1', '[]'::jsonb)`,
          );
          derivativeUploads.push(() =>
            workerStorage.putDerivative({
              key: derivativeKey,
              bytes: BENCHMARK_PAGE,
              contentType: 'image/png',
              sha256Base64: pageShaBase64,
            }),
          );
        }

        await clientBatch.query(
          `INSERT INTO document (id, room_id, display_title, created_by, created_at, description, revision, working_version_id, download_policy)
           VALUES ${docRows.join(',')}`,
        );
        await clientBatch.query(
          `INSERT INTO document_version (id, document_id, original_filename, object_key, declared_media_type, detected_media_type, size_bytes, sha256, processing_attempts, state, scan_signature_version, manual_retry_count, hidden_sheet_warning)
           VALUES ${verRows.join(',')}`,
        );
        await clientBatch.query(
          `INSERT INTO published_structure_entry (room_id, entry_id, resource_kind, resource_id, parent_folder_id, display_name, description, order_key, source_revision, published_version_id)
           VALUES ${pubRows.join(',')}`,
        );
        for (
          let uploadOffset = 0;
          uploadOffset < derivativeUploads.length;
          uploadOffset += 20
        ) {
          await Promise.all(
            derivativeUploads.slice(uploadOffset, uploadOffset + 20).map((upload) => upload()),
          );
        }
        await clientBatch.query(
          `INSERT INTO document_derivative
             (id, version_id, page_number, object_key, media_type, size_bytes, sha256,
              width, height, accessible_label, text_layer)
           VALUES ${derivativeRows.join(',')}`,
        );
        await clientBatch.query(
          `UPDATE document d SET working_version_id = values.version_id
           FROM (SELECT * FROM unnest($1::text[], $2::text[]) AS pair(document_id, version_id)) values
           WHERE d.id = values.document_id`,
          [[...versionByDocument.keys()], [...versionByDocument.values()]],
        );
        await clientBatch.query('COMMIT');
      } catch (error) {
        await clientBatch.query('ROLLBACK');
        throw error;
      } finally {
        clientBatch.release();
      }
    }

    // 6. Viewers, memberships, grants, and issued sessions
    process.stdout.write(`Seeding ${options.viewers} viewers and active sessions...\n`);
    const viewerTokens: ViewerToken[] = [];

    for (let v = 0; v < options.viewers; v += 1) {
      const viewerId = createOpaqueId();
      const familyId = createOpaqueId();
      const email = `bench-viewer-${v + 1}@example.com`;
      const grantId = createOpaqueId();

      const migClient = await migrationPool.connect();
      try {
        await migClient.query('BEGIN');
        const vRow = (
          await migClient.query<{ id: string; session_family_id: string }>(
            `INSERT INTO viewer (id, email_key, email_display, session_family_id, state)
             VALUES ($1, $2, $2, $3, 'active')
             ON CONFLICT (email_key) DO UPDATE SET state = 'active'
             RETURNING id, session_family_id`,
            [viewerId, email, familyId],
          )
        ).rows[0];
        const effectiveViewerId = vRow?.id ?? viewerId;
        const effectiveFamilyId = vRow?.session_family_id ?? familyId;

        const membershipId = createOpaqueId();
        await migClient.query(
          `INSERT INTO viewer_room_membership (id, viewer_id, room_id, state)
           VALUES ($1, $2, $3, 'active')
           ON CONFLICT (viewer_id, room_id) DO UPDATE SET state = 'active'`,
          [membershipId, effectiveViewerId, roomId],
        );
        await migClient.query(
          `INSERT INTO access_grant (id, room_id, grantee_kind, viewer_id, target_kind, created_by, expires_at)
           VALUES ($1, $2, 'viewer', $3, 'room', $4, statement_timestamp() + interval '30 days')`,
          [grantId, roomId, effectiveViewerId, ownerId],
        );
        await migClient.query('COMMIT');

        // Issue active session via auth pool
        const secret = randomBytes(32).toString('base64url');
        const secretDigest = sha256Hex(secret);
        const csrfToken = randomBytes(32).toString('base64url');
        const csrfDigest = sha256Hex(csrfToken);
        const sessionId = createOpaqueId();

        const authClient = await authPool.connect();
        try {
          await authClient.query('BEGIN');
          await authClient.query(
            `INSERT INTO session (
               id, secret_digest, csrf_digest, principal_kind, viewer_id, family_id,
               idle_expires_at, absolute_expires_at, state
             ) VALUES (
               $1, $2, $3, 'viewer', $4, $5,
               statement_timestamp() + interval '4 hours',
               statement_timestamp() + interval '12 hours',
               'active'
             )`,
            [sessionId, secretDigest, csrfDigest, effectiveViewerId, effectiveFamilyId],
          );
          await authClient.query('COMMIT');
          viewerTokens.push({
            viewerId: effectiveViewerId,
            secret,
            csrfToken,
            deniedRoomId,
            deniedDocumentId,
          });
        } catch (error) {
          await authClient.query('ROLLBACK');
          throw error;
        } finally {
          authClient.release();
        }
      } catch (error) {
        await migClient.query('ROLLBACK');
        throw error;
      } finally {
        migClient.release();
      }
    }

    // 7. Bulk insert audit events in batches
    if (options.auditEvents > 0) {
      process.stdout.write(`Inserting ${options.auditEvents} audit events...\n`);
      const auditBatchSize = 2_000;
      for (let offset = 0; offset < options.auditEvents; offset += auditBatchSize) {
        const count = Math.min(auditBatchSize, options.auditEvents - offset);
        const rows: string[] = [];
        for (let j = 0; j < count; j += 1) {
          const id = createOpaqueId();
          const corr = createCorrelationId();
          rows.push(
            `('${id}', 'preview.page', 'viewer', '${viewerTokens[j % viewerTokens.length]?.viewerId}', '${roomId}', 'document', 'success', 'OK', '${corr}', '{}'::jsonb)`,
          );
        }

        const client = await migrationPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO audit_event (id, event_type, actor_kind, actor_id, room_id, resource_type, result, reason_code, correlation_id, detail)
             VALUES ${rows.join(',')}`,
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
    }

    // 8. Save token file
    await writeFile(options.outPath, `${JSON.stringify(viewerTokens, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `Benchmark seeding complete: ${viewerTokens.length} tokens written to ${options.outPath}.\n`,
    );
  } finally {
    await migrationPool.end();
    await authPool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Seeding failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
