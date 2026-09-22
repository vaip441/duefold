/**
 * Every `pg` pool the product opens, with the one listener a pool must have.
 *
 * `pg` emits `error` on the pool when a connection dies while it is idle, which is what a
 * database restart looks like from the application's side. An unlistened emitter raises an
 * uncaught exception, and the process failure handler then exits the service, so one restart
 * of PostgreSQL ends every in-flight request for every user rather than costing the one
 * connection that died. A pool recovers on its own once the listener exists: the dead
 * connection is discarded and the next caller is served by a fresh one.
 *
 * The listener records a code, never the error, because §20.3 forbids telemetry carrying
 * configuration and a `pg` error carries the connection parameters.
 */
import { Pool, type PoolConfig } from 'pg';
import { allowlistedTelemetry } from './redact.ts';
import type { SafeProcessSink } from './process-errors.ts';

export interface ResilientPoolOptions extends PoolConfig {
  /** Names the pool in telemetry so an operator can tell which credential lost a connection. */
  readonly role: string;
  readonly sink?: SafeProcessSink;
}

export function createResilientPool(options: ResilientPoolOptions): Pool {
  const { role, sink = process.stderr, ...config } = options;
  const pool = new Pool(config);
  pool.on('error', (error: unknown) => {
    sink.write(
      `${JSON.stringify(
        allowlistedTelemetry({
          event: 'database.connection.lost',
          level: 'warn',
          code:
            typeof error === 'object' && error !== null && 'code' in error
              ? String(error.code)
              : 'UNKNOWN',
          role,
        }),
      )}\n`,
    );
  });
  return pool;
}
