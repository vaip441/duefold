/**
 * The reader's page toolbar: previous and next page, position, and page size.
 *
 * ArrowLeft and ArrowRight turn pages only at the default size. A larger page overflows
 * sideways, and the arrows are how a keyboard user scrolls it. A field or an open
 * dialog keeps its own arrow-key meaning.
 */

import { useEffect, useRef } from 'react';
import { translate } from '../i18n/translate.ts';

export const ZOOM_STEPS = [100, 150, 200] as const;
export type Zoom = (typeof ZOOM_STEPS)[number];

export interface DocumentPagerProps {
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly zoom: Zoom;
  readonly onPage: (pageNumber: number) => void;
  readonly onZoom: (zoom: Zoom) => void;
}

function pagesByArrowKeys(event: KeyboardEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  if (target.closest('[role="dialog"], [role="alertdialog"]') !== null) return false;
  return !target.isContentEditable && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function DocumentPager({
  pageNumber,
  pageCount,
  zoom,
  onPage,
  onZoom,
}: DocumentPagerProps): React.ReactElement {
  const latest = useRef({ pageNumber, pageCount, zoom, onPage });
  latest.current = { pageNumber, pageCount, zoom, onPage };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const current = latest.current;
      if (current.zoom !== ZOOM_STEPS[0] || !pagesByArrowKeys(event)) return;
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      const next = current.pageNumber + step;
      if (step === 0 || next < 1 || next > current.pageCount) return;
      event.preventDefault();
      current.onPage(next);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const zoomIndex = ZOOM_STEPS.indexOf(zoom);
  const smaller = ZOOM_STEPS[zoomIndex - 1];
  const larger = ZOOM_STEPS[zoomIndex + 1];

  return (
    <div className="df-reader-toolbar">
      <nav className="df-pager" aria-label={translate('viewer.page.navigation')}>
        <button
          type="button"
          className="df-button"
          disabled={pageNumber <= 1}
          onClick={() => {
            onPage(pageNumber - 1);
          }}
        >
          {translate('viewer.page.previous')}
        </button>
        <span className="df-pager__position" data-numeric="true">
          {translate('viewer.page.caption', { page: pageNumber, total: pageCount })}
        </span>
        <button
          type="button"
          className="df-button"
          disabled={pageNumber >= pageCount}
          onClick={() => {
            onPage(pageNumber + 1);
          }}
        >
          {translate('viewer.page.next')}
        </button>
      </nav>
      <div className="df-zoom" role="group" aria-label={translate('viewer.zoom.label')}>
        <button
          type="button"
          className="df-button df-button--quiet"
          disabled={smaller === undefined}
          onClick={() => {
            if (smaller !== undefined) onZoom(smaller);
          }}
        >
          {translate('viewer.zoom.out')}
        </button>
        <span className="df-pager__position" data-numeric="true" aria-live="polite">
          {translate('viewer.zoom.level', { percent: zoom })}
        </span>
        <button
          type="button"
          className="df-button df-button--quiet"
          disabled={larger === undefined}
          onClick={() => {
            if (larger !== undefined) onZoom(larger);
          }}
        >
          {translate('viewer.zoom.in')}
        </button>
      </div>
    </div>
  );
}
