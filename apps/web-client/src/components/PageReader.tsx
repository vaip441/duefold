/**
 * The protected page reader.
 *
 * A raster page image with the sanitized positional text layer laid over it, so
 * text is SELECTABLE, findable, and reachable by assistive technology.
 * The overlay text is transparent and sits at the coordinates
 * the server supplied, which is how a raster page supports selection at all.
 *
 * Deliberate non-features:
 *   - No print action. Print styles hide the page instead.
 *   - Selection, copy, and the context menu are NOT disabled. No `user-select:
 *     none`, no `oncontextmenu` handler, no copy interception. Crippling the page
 *     would break assistive technology and buy nothing, since a screenshot is
 *     always available.
 *   - No claim of protection. The surface states plainly that screenshots cannot
 *     be prevented.
 *
 * The image element carries the page's accessible label, so a page whose text
 * extraction failed is still announced rather than being an unlabelled graphic.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { isAborted } from '../api/abort.ts';
import {
  ApiError,
  createProtectedPage,
  loadTextLayer,
  protectedPageImageUrl,
  type TextLayer,
  type TextLayerItem,
} from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import { splitRuns, type FindMatch } from '../viewer/find.ts';
import { Notice } from './Notice.tsx';

export interface PageReaderProps {
  readonly roomId: string;
  readonly documentId: string;
  readonly pageNumber: number;
  readonly totalPages: number;
  readonly activityId: string;
  readonly matches: readonly FindMatch[];
  readonly currentMatch: number | null;
  readonly onTextLayer: (layer: TextLayer | null) => void;
  readonly onLinkActivate: (item: TextLayerItem) => void;
  readonly onUnauthorized: () => void;
}

type PageState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly imageUrl: string;
      readonly layer: TextLayer | null;
    }
  | { readonly kind: 'failed'; readonly message: string };

export function PageReader({
  roomId,
  documentId,
  pageNumber,
  totalPages,
  activityId,
  matches,
  currentMatch,
  onTextLayer,
  onLinkActivate,
  onUnauthorized,
}: PageReaderProps): React.ReactElement {
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const captionId = useId();
  const currentMatchRef = useRef<HTMLSpanElement | null>(null);

  /*
   * The parent callbacks are held in refs and deliberately NOT effect
   * dependencies. Calling `onTextLayer` sets state in the parent, which
   * re-renders this component; if the callback identity were a dependency, that
   * re-render would re-run the effect, request the page again, and loop forever.
   * The refs keep the latest callback without making the fetch depend on it.
   */
  const textLayerSink = useRef(onTextLayer);
  const unauthorizedSink = useRef(onUnauthorized);
  useEffect(() => {
    textLayerSink.current = onTextLayer;
    unauthorizedSink.current = onUnauthorized;
  }, [onTextLayer, onUnauthorized]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    setState({ kind: 'loading' });
    textLayerSink.current(null);

    /*
     * Order matters: the cache object is created first, because the delivery
     * endpoint requires both a cache id and the activity id. The text layer is
     * fetched alongside and is allowed to fail independently -- a page with no
     * extractable text still renders as an image with its accessible label.
     *
     * The abort signal is the single cancellation source; a separate boolean flag
     * would be a second source of truth that can disagree with it.
     */
    void (async () => {
      try {
        const page = await createProtectedPage({ roomId, documentId, pageNumber });
        if (isAborted(signal)) return;
        let layer: TextLayer | null = null;
        try {
          layer = await loadTextLayer({ roomId, documentId, pageNumber }, signal);
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          /*
           * Only a SUCCESSFUL response carrying no items is the designed
           * extraction-failure state. Substituting null for every rejection
           * turned 401, 403, and 500 into an apparently readable page with a
           * fallback label, hiding revocation and real faults from the viewer.
           * Rethrow so the outer handler routes access loss to the sink and
           * everything else to the failure state.
           */
          throw error;
        }
        if (isAborted(signal)) return;
        setState({
          kind: 'ready',
          imageUrl: protectedPageImageUrl({ cacheId: page.cacheId, activityId }),
          layer,
        });
        textLayerSink.current(layer);
      } catch (error) {
        if (isAborted(signal)) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (
          error instanceof ApiError &&
          (error.failure === 'unauthenticated' || error.failure === 'denied')
        ) {
          unauthorizedSink.current();
          return;
        }
        setState({
          kind: 'failed',
          message:
            error instanceof ApiError && error.failure === 'offline'
              ? translate('app.offline.body')
              : translate('viewer.page.failed'),
        });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [roomId, documentId, pageNumber, activityId, attempt]);

  // Bring the current find match into view without animating a potentially
  // keyboard-repeated focus jump.
  useEffect(() => {
    const node = currentMatchRef.current;
    if (node === null) return;
    node.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: 'auto',
    });
  }, [currentMatch]);

  if (state.kind === 'loading')
    return (
      <div className="df-page">
        <p className="df-field__help" id={captionId}>
          {translate('viewer.page.loading').replace('{page}', String(pageNumber))}
        </p>
      </div>
    );

  if (state.kind === 'failed')
    return (
      <div className="df-page">
        <Notice tone="problem" role="alert">
          {state.message}
        </Notice>
        <button
          type="button"
          className="df-button"
          onClick={() => {
            setAttempt((value) => value + 1);
          }}
        >
          {translate('viewer.page.retry')}
        </button>
      </div>
    );

  const layer = state.layer;
  const label =
    layer === null || layer.items.length === 0
      ? translate('viewer.page.imageFallback').replace('{page}', String(pageNumber))
      : layer.accessibleLabel;

  return (
    <div className="df-page" data-print-notice={translate('viewer.print.omitted')}>
      <p className="df-page__caption" id={captionId} data-numeric="true">
        {translate('viewer.page.caption')
          .replace('{page}', String(pageNumber))
          .replace('{total}', String(totalPages))}
      </p>
      {/*
        `.df-document-pixels` pins a light ground and disables forced colours, so
        the document is colour-accurate in dark mode and under a forced-colours
        mode rather than being inverted with the interface.
      */}
      <div className="df-page__sheet df-document-pixels">
        <img
          className="df-page__image"
          src={state.imageUrl}
          alt={label}
          aria-describedby={captionId}
          draggable={false}
        />
        {layer === null ? null : (
          <div className="df-page__text" aria-hidden="false">
            {layer.items.map((item, itemIndex) => {
              const runs = splitRuns(item.text, matches, itemIndex);
              const style = {
                left: `${String(item.x * 100)}%`,
                top: `${String(item.y * 100)}%`,
                width: `${String(item.width * 100)}%`,
                height: `${String(item.height * 100)}%`,
              };
              const content = runs.map((run, runIndex) =>
                run.matched ? (
                  <span
                    key={runIndex}
                    className="df-page__match"
                    data-current={run.matchIndex === currentMatch ? 'true' : 'false'}
                    ref={run.matchIndex === currentMatch ? currentMatchRef : undefined}
                  >
                    {run.text}
                  </span>
                ) : (
                  <span key={runIndex}>{run.text}</span>
                ),
              );
              /*
               * A link renders as a button only when the SERVER supplied a
               * normalized destination. An item without `link` stays inert text,
               * which is how credential-bearing, malformed, non-HTTPS, and
               * unsafe-scheme URLs are handled (14.1).
               */
              if (item.link !== undefined)
                return (
                  <button
                    key={itemIndex}
                    type="button"
                    className="df-page__run df-page__run--link"
                    style={style}
                    onClick={() => {
                      onLinkActivate(item);
                    }}
                  >
                    {content}
                    <span className="df-visually-hidden">
                      {' '}
                      {translate('viewer.link.destination')} {item.link.normalizedDomain}
                    </span>
                  </button>
                );
              return (
                <span key={itemIndex} className="df-page__run" style={style}>
                  {content}
                </span>
              );
            })}
          </div>
        )}
      </div>
      {layer !== null && layer.items.length === 0 ? (
        <p className="df-field__help">{translate('viewer.page.textUnavailable')}</p>
      ) : null}
    </div>
  );
}
