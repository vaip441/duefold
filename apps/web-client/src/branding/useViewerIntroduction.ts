import { useEffect, useState } from 'react';
import { composedBrowserEntries } from 'virtual:duefold/browser-entries';
import type { ViewerIntroductionSlot } from '../contract.ts';

function slot(): ViewerIntroductionSlot | null {
  for (const entry of composedBrowserEntries) {
    const candidate = entry.contribution.viewerIntroduction;
    if (candidate !== undefined) return candidate;
  }
  return null;
}

export type ViewerIntroductionLoad =
  | { readonly kind: 'idle' | 'loading' }
  | { readonly kind: 'loaded'; readonly value: string }
  | { readonly kind: 'failed' };

/** Optional branding contribution; secure-core builds resolve to an empty value. */
export function useViewerIntroduction(enabled: boolean): ViewerIntroductionLoad {
  const [load, setLoad] = useState<ViewerIntroductionLoad>({ kind: 'idle' });
  useEffect(() => {
    if (!enabled) {
      setLoad({ kind: 'idle' });
      return;
    }
    const contribution = slot();
    if (contribution === null) {
      setLoad({ kind: 'loaded', value: '' });
      return;
    }
    setLoad({ kind: 'loading' });
    const controller = new AbortController();
    contribution.load(controller.signal).then(
      (value) => {
        setLoad({ kind: 'loaded', value });
      },
      () => {
        if (!controller.signal.aborted) setLoad({ kind: 'failed' });
      },
    );
    return () => {
      controller.abort();
    };
  }, [enabled]);
  return load;
}
