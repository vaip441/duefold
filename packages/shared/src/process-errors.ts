import { setTimeout as delay } from 'node:timers/promises';
import { allowlistedTelemetry } from './redact.ts';

export type ProcessService = 'web' | 'worker' | 'cli';
export interface SafeProcessSink {
  write(chunk: string): boolean;
}
export interface ProcessFailureOptions {
  readonly sink?: SafeProcessSink;
  readonly close?: () => void | Promise<void>;
  readonly closeTimeoutMilliseconds?: number;
  readonly stage?: () => 'config' | 'oidc' | 'database' | 'application' | 'listen';
}

/** Emits a fixed code only; the error object is deliberately not accepted. */
export function emitProcessFailure(
  service: ProcessService,
  sink: SafeProcessSink = process.stderr,
  stage?: ProcessFailureOptions['stage'],
): void {
  sink.write(
    `${JSON.stringify(
      allowlistedTelemetry({
        event: 'process.failure',
        level: 'error',
        code: 'PROCESS_FAILED',
        service,
        ...(stage === undefined ? {} : { stage: stage() }),
      }),
    )}\n`,
  );
}

const exitAfterClose = async (
  close: () => void | Promise<void>,
  timeout: number,
): Promise<never> => {
  await Promise.race([Promise.resolve().then(close), delay(timeout)]).catch(() => undefined);
  process.exit(1);
};

/** Emits one safe record, attempts only the supplied bounded close, then exits. */
export function installProcessFailureHandlers(
  service: ProcessService,
  options: ProcessFailureOptions = {},
): () => void {
  let terminating = false;
  const terminate = (): void => {
    if (terminating) return;
    terminating = true;
    emitProcessFailure(service, options.sink, options.stage);
    const timeout = options.closeTimeoutMilliseconds ?? 5_000;
    const close = options.close ?? (() => undefined);
    void exitAfterClose(close, timeout);
  };
  process.on('unhandledRejection', terminate);
  process.on('uncaughtException', terminate);
  return terminate;
}
