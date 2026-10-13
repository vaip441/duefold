import { setTimeout as delay } from 'node:timers/promises';
import { allowlistedTelemetry, type StartupRefusalCode } from './redact.ts';

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

/** A startup refusal whose code, unlike any other thrown value, reaches the failure record. */
export class StartupRefusal extends Error {
  public override readonly name = 'StartupRefusal';
  public readonly code: StartupRefusalCode;
  public constructor(code: StartupRefusalCode) {
    super(code);
    this.code = code;
  }
}

/** Emits a fixed code only; the error object is deliberately not accepted. */
export function emitProcessFailure(
  service: ProcessService,
  sink: SafeProcessSink = process.stderr,
  stage?: ProcessFailureOptions['stage'],
  code: StartupRefusalCode | 'PROCESS_FAILED' = 'PROCESS_FAILED',
): void {
  sink.write(
    `${JSON.stringify(
      allowlistedTelemetry({
        event: 'process.failure',
        level: 'error',
        code,
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
): (cause?: unknown) => void {
  let terminating = false;
  const terminate = (cause?: unknown): void => {
    if (terminating) return;
    terminating = true;
    emitProcessFailure(
      service,
      options.sink,
      options.stage,
      cause instanceof StartupRefusal ? cause.code : 'PROCESS_FAILED',
    );
    const timeout = options.closeTimeoutMilliseconds ?? 5_000;
    const close = options.close ?? (() => undefined);
    void exitAfterClose(close, timeout);
  };
  process.on('unhandledRejection', terminate);
  process.on('uncaughtException', terminate);
  return terminate;
}
