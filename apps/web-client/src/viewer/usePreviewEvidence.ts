/**
 * Preview evidence lifecycle.
 *
 * One activity per viewer/session/version, a 60-second heartbeat that beats ONLY
 * while the tab is visible, and exactly one close on unload or after two minutes
 * of inactivity.
 *
 * The visibility rule is the reason this is a hook rather than a bare interval.
 * A heartbeat from a hidden tab would record a viewer as present while the
 * document sat behind another window, which is evidence of something that did not
 * happen. `document.visibilityState` gates every beat, and the timer is torn down
 * and rebuilt across visibility changes so a backgrounded tab contributes
 * nothing.
 *
 * What this deliberately does NOT do: measure dwell time, compute a completion
 * percentage, score reading, or claim proof of reading;
 * none of those quantities is derived even in local state. The only thing
 * tracked is WHICH pages were displayed, which the server records as a page-range
 * summary; the client keeps the set solely so it can close the activity and never
 * reports a duration.
 */

import { useEffect, useRef } from 'react';
import { ApiError, closePreview, heartbeatPreview } from '../api/client.ts';

const HEARTBEAT_MS = 60_000;
const INACTIVITY_MS = 120_000;

export interface PreviewEvidenceInput {
  /** Null while no activity is open; the hook then does nothing. */
  readonly activityId: string | null;
  /** Called when the server reports the activity is no longer accepted. */
  readonly onRejected: () => void;
}

export function usePreviewEvidence({ activityId, onRejected }: PreviewEvidenceInput): void {
  // Held in a ref so the inactivity timer can be reset by interaction without
  // re-running the effect and restarting the heartbeat cadence.
  const lastInteraction = useRef<number>(Date.now());
  const closed = useRef(false);

  useEffect(() => {
    if (activityId === null) return;
    closed.current = false;
    lastInteraction.current = Date.now();
    let timer: number | undefined;

    const finish = (status: 'closed' | 'inactive'): void => {
      if (closed.current) return;
      closed.current = true;
      // Failure here is silent by design: the server also finalizes an activity
      // from its own inactivity job, so a lost close is recovered server-side
      // rather than retried from a page that may be unloading.
      void closePreview(activityId, status).catch(() => undefined);
    };

    const beat = (): void => {
      if (closed.current) return;
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastInteraction.current >= INACTIVITY_MS) {
        finish('inactive');
        return;
      }
      heartbeatPreview(activityId).then(
        (accepted) => {
          // A refused heartbeat means the session or grant no longer authorizes
          // this activity. The surface stops rather than continuing to render.
          if (!accepted) {
            closed.current = true;
            onRejected();
          }
        },
        (error: unknown) => {
          /*
           * A rejected heartbeat REQUEST is not the same as a refused heartbeat.
           * Discarding it silently let a revoked viewer keep reading while the
           * server had already stopped accepting evidence. Access loss stops the
           * surface; a transient transport error leaves the interval running so
           * the next beat can recover.
           */
          if (
            error instanceof ApiError &&
            (error.failure === 'unauthenticated' || error.failure === 'denied')
          ) {
            closed.current = true;
            onRejected();
          }
        },
      );
    };

    const startTimer = (): void => {
      if (timer !== undefined) return;
      timer = window.setInterval(beat, HEARTBEAT_MS);
    };
    const stopTimer = (): void => {
      if (timer === undefined) return;
      window.clearInterval(timer);
      timer = undefined;
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        lastInteraction.current = Date.now();
        startTimer();
      } else stopTimer();
    };

    const onInteraction = (): void => {
      lastInteraction.current = Date.now();
    };

    const onPageHide = (): void => {
      finish('closed');
    };

    if (document.visibilityState === 'visible') startTimer();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('keydown', onInteraction, { passive: true });
    window.addEventListener('pointerdown', onInteraction, { passive: true });
    window.addEventListener('scroll', onInteraction, { passive: true });

    return () => {
      stopTimer();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('keydown', onInteraction);
      window.removeEventListener('pointerdown', onInteraction);
      window.removeEventListener('scroll', onInteraction);
      finish('closed');
    };
  }, [activityId, onRejected]);
}
