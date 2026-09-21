/**
 * One read a section owns: loading until it answers, then the value or its presented
 * failure. Reloading drops the answer on screen before asking again, so nothing built from a
 * superseded answer stays pressable. `loader` must be stable — a module-level function.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { presentFailure, type PresentedFailure } from './failures.ts';
import type { Load } from './state.ts';

export interface LoadedSection<T> {
  readonly load: Load<T>;
  /** The presented cause of a failed load, for choosing its recovery. */
  readonly failure: PresentedFailure | null;
  readonly reload: () => void;
}

interface Read<T> {
  readonly key: number;
  readonly load: Load<T>;
  readonly failure: PresentedFailure | null;
}

/**
 * Answers the read for the active request key, or loading if keys do not match.
 *
 * Discards late-arriving responses from superseded requests so a response arriving after
 * the operator navigated away or asked again cannot populate the wrong surface.
 */
export function readForSection<T>(read: Read<T> | null, expectedKey: number): Load<T> {
  return read !== null && read.key === expectedKey ? read.load : { kind: 'loading' };
}

export function useLoad<T>(loader: (signal: AbortSignal) => Promise<T>): LoadedSection<T> {
  const [token, setToken] = useState(0);
  const [read, setRead] = useState<Read<T> | null>(null);

  /*
   * The request key is the whole guard. A read is kept only while it is still the one asked
   * for, and the abort signal ends the request itself, so no separate mounted flag is needed.
   */
  const activeToken = useRef(token);
  activeToken.current = token;

  useEffect(() => {
    const key = token;
    const controller = new AbortController();
    loader(controller.signal).then(
      (value) => {
        if (controller.signal.aborted || activeToken.current !== key) return;
        setRead({ key, load: { kind: 'ready', value }, failure: null });
      },
      (error: unknown) => {
        if (controller.signal.aborted || activeToken.current !== key) return;
        const presented = presentFailure(error);
        setRead({ key, load: { kind: 'failed', failure: presented.body }, failure: presented });
      },
    );
    return () => {
      controller.abort();
    };
  }, [loader, token]);

  const reload = useCallback(() => {
    setRead(null);
    setToken((current) => current + 1);
  }, []);

  const load = readForSection(read, token);
  const currentFailure = read !== null && read.key === token ? read.failure : null;

  return { load, failure: currentFailure, reload };
}
