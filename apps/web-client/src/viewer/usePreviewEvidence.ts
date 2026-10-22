/**
 * Preview evidence lifecycle.
 *
 * One activity per viewer/session/version, a 60-second heartbeat that beats ONLY
 * while the tab is visible, and a close on unload or after two minutes of
 * inactivity.
 *
 * The visibility rule is the reason this is a hook rather than a bare interval.
 * A heartbeat from a hidden tab would record a viewer as present while the
 * document sat behind another window, which is evidence of something that did not
 * happen. `document.visibilityState` gates every beat, and the timer is torn down
 * and rebuilt across visibility changes so a backgrounded tab contributes
 * nothing.
 *
 * An ended activity is not lost access. The server ends one two minutes after the
 * last heartbeat, so a background tab comes back to an ended activity; tabs of one
 * session share one activity row, so closing one tab ends it for the others; and
 * this hook ends it after inactivity. Opening again reactivates the same row
 * without a second start event, so every page opens the activity before it is
 * delivered, and only a refused open means the version changed or access ended.
 *
 * What this deliberately does NOT do: measure dwell time, compute a completion
 * percentage, score reading, or claim proof of reading;
 * none of those quantities is derived even in local state. The only thing
 * tracked is WHICH pages were displayed, which the server records as a page-range
 * summary when each page is delivered; nothing here reports a duration.
 */

import { useEffect, useState } from 'react';
import { ApiError, beginPreview, closePreview, heartbeatPreview } from '../api/client.ts';

const HEARTBEAT_MS = 60_000;
const INACTIVITY_MS = 120_000;

export interface PreviewTarget {
  readonly roomId: string;
  readonly documentId: string;
  readonly versionId: string;
}

export interface PreviewEvidenceInput {
  /** Null while no document is open; the hook then does nothing. */
  readonly target: PreviewTarget | null;
  /** The server refused to open the activity: the published version changed or access ended. */
  readonly onRefused: () => void;
  /** The session (`unauthenticated`) or the grant (`denied`) no longer authorizes reading. */
  readonly onRejected: (failure: AccessLoss) => void;
}

export type AccessLoss = Extract<ApiError['failure'], 'unauthenticated' | 'denied'>;

function accessLost(error: unknown): error is ApiError & { readonly failure: AccessLoss } {
  return (
    error instanceof ApiError &&
    (error.failure === 'unauthenticated' || error.failure === 'denied')
  );
}

export function trackPreviewActivity({
  target,
  onRefused,
  onRejected,
}: PreviewEvidenceInput & { readonly target: PreviewTarget }): {
  /** Opens the activity, reactivating it if it ended, and resolves its id. */
  readonly open: () => Promise<string>;
  readonly stop: () => void;
} {
  let lastInteraction = Date.now();
  let stopped = false;
  // A begin answering after stop would leave an activity no one closes.
  const opens = new AbortController();
  // Null before the first page opens the activity and once this hook has ended it.
  let activityId: string | null = null;
  // Set when this hook ended the activity or could not reopen it, so the next
  // interaction or return to view reopens it once rather than on every scroll event.
  let ended = false;
  let opening: Promise<string> | null = null;
  let timer: number | undefined;

  const open = (): Promise<string> => {
    opening ??= beginPreview(target, opens.signal)
      .then(
        (activity) => {
          if (!stopped) {
            activityId = activity.activityId;
            ended = false;
          }
          return activity.activityId;
        },
        (error: unknown) => {
          if (!stopped && error instanceof ApiError && error.failure === 'not-found')
            onRefused();
          else if (!stopped && accessLost(error)) onRejected(error.failure);
          throw error;
        },
      )
      .finally(() => {
        opening = null;
      });
    return opening;
  };

  const reopen = (): void => {
    ended = false;
    void open().catch((error: unknown) => {
      // A refusal has already been reported; after any other failure the next
      // interaction or return to the tab tries again.
      if (stopped || accessLost(error)) return;
      if (error instanceof ApiError && error.failure === 'not-found') return;
      ended = true;
    });
  };

  const finish = (status: 'closed' | 'inactive'): void => {
    if (activityId === null) return;
    // Failure here is silent by design: the server also finalizes an activity
    // from its own inactivity job, so a lost close is recovered server-side
    // rather than retried from a page that may be unloading.
    void closePreview(activityId, status).catch(() => undefined);
    activityId = null;
    ended = true;
  };

  const beat = (): void => {
    const current = activityId;
    if (current === null || document.visibilityState !== 'visible') return;
    if (Date.now() - lastInteraction >= INACTIVITY_MS) {
      finish('inactive');
      return;
    }
    heartbeatPreview(current).then(
      (accepted) => {
        if (accepted || stopped || activityId !== current) return;
        activityId = null;
        reopen();
      },
      (error: unknown) => {
        if (stopped || activityId !== current) return;
        /*
         * A rejected heartbeat REQUEST is not the same as a refused heartbeat.
         * Discarding it silently let a revoked viewer keep reading while the
         * server had already stopped accepting evidence. Access loss stops the
         * surface; a transient transport error leaves the interval running so
         * the next beat can recover.
         */
        if (accessLost(error)) onRejected(error.failure);
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
    if (document.visibilityState !== 'visible') {
      stopTimer();
      return;
    }
    lastInteraction = Date.now();
    if (ended) reopen();
    startTimer();
  };

  const onInteraction = (): void => {
    lastInteraction = Date.now();
    if (ended) reopen();
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

  return {
    open,
    stop: () => {
      stopped = true;
      opens.abort();
      stopTimer();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('keydown', onInteraction);
      window.removeEventListener('pointerdown', onInteraction);
      window.removeEventListener('scroll', onInteraction);
      finish('closed');
    },
  };
}

/** The open document's activity opener, which the page source awaits before each page. */
export function usePreviewEvidence({
  target,
  onRefused,
  onRejected,
}: PreviewEvidenceInput): (() => Promise<string>) | null {
  const [open, setOpen] = useState<(() => Promise<string>) | null>(null);
  const roomId = target?.roomId;
  const documentId = target?.documentId;
  const versionId = target?.versionId;

  useEffect(() => {
    if (roomId === undefined || documentId === undefined || versionId === undefined) return;
    const activity = trackPreviewActivity({
      target: { roomId, documentId, versionId },
      onRefused,
      onRejected,
    });
    setOpen(() => activity.open);
    return () => {
      activity.stop();
      setOpen(null);
    };
  }, [roomId, documentId, versionId, onRefused, onRejected]);

  return open;
}
