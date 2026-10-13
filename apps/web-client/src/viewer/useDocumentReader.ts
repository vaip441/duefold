/**
 * The reading desk shared by the viewer reading room and the investor preview: the
 * open document's metadata, page turns, zoom, and in-page find.
 */

import { useEffect, useMemo, useState } from 'react';
import type { TextLayer, ViewerDocument } from '../api/client.ts';
import type { Zoom } from '../components/DocumentPager.tsx';
import type { FindBarProps } from '../components/FindBar.tsx';
import { translate } from '../i18n/translate.ts';
import type { Load } from '../workspace/state.ts';
import { findMatches, type FindMatch } from './find.ts';

export interface LoadedDocument {
  readonly documentId: string | null;
  readonly load: Load<ViewerDocument | null>;
}

/**
 * Metadata is kept with the document it was read for, so after Back or Forward the
 * previous document's page count and policy never stand in for the new one's.
 */
export function documentFor(
  loaded: LoadedDocument,
  documentId: string | null,
): Load<ViewerDocument | null> {
  return loaded.documentId === documentId ? loaded.load : { kind: 'loading' };
}

export interface DocumentReaderInput {
  readonly documentId: string | null;
  readonly page: number;
  /** Replaces, not pushes, the location's page: Back should leave the document, not step
      through its pages. */
  readonly onPage: (page: number) => void;
  readonly onStatus: (message: string) => void;
}

export interface DocumentReader {
  readonly document: Load<ViewerDocument | null>;
  readonly openDocument: ViewerDocument | null;
  readonly receiveDocument: (loaded: LoadedDocument) => void;
  readonly goToPage: (page: number) => void;
  readonly zoom: Zoom;
  readonly setZoom: (zoom: Zoom) => void;
  readonly matches: readonly FindMatch[];
  readonly currentMatch: number | null;
  readonly onTextLayer: (layer: TextLayer | null) => void;
  readonly findBar: FindBarProps;
}

export function useDocumentReader({
  documentId,
  page,
  onPage,
  onStatus,
}: DocumentReaderInput): DocumentReader {
  const [loaded, setLoaded] = useState<LoadedDocument>({
    documentId: null,
    load: { kind: 'loading' },
  });
  /* Page width as a share of the worktable. The text layer is positioned in
     percentages of the sheet, so it scales with the image. */
  const [zoom, setZoom] = useState<Zoom>(100);
  const [layer, setLayer] = useState<TextLayer | null>(null);
  const [query, setQuery] = useState('');
  const [currentMatch, setCurrentMatch] = useState<number | null>(null);

  const document = documentFor(loaded, documentId);
  const openDocument = document.kind === 'ready' ? document.value : null;
  const totalPages = openDocument?.pageCount ?? 0;
  const matches = useMemo(
    () => (layer === null ? [] : findMatches(layer.items, query)),
    [layer, query],
  );

  useEffect(() => {
    setQuery('');
    setCurrentMatch(null);
  }, [documentId]);

  /* A page from a stale link past the end of a republished document opens page one. */
  useEffect(() => {
    if (openDocument !== null && page > openDocument.pageCount) onPage(1);
  }, [openDocument, page, onPage]);

  const goToPage = (next: number): void => {
    if (next < 1 || next > totalPages) return;
    onPage(next);
    setCurrentMatch(null);
    onStatus(
      translate('viewer.page.announce')
        .replace('{page}', String(next))
        .replace('{total}', String(totalPages)),
    );
  };

  const stepMatch = (delta: number): void => {
    if (matches.length === 0) {
      onStatus(translate('viewer.find.none'));
      return;
    }
    /*
     * With no match selected yet, stepping forward must land on the FIRST match
     * and stepping backward on the LAST. Starting from -1 forward and 0 backward
     * makes the modulo below produce exactly that.
     */
    const base = currentMatch ?? (delta > 0 ? -1 : 0);
    const next = (base + delta + matches.length) % matches.length;
    setCurrentMatch(next);
    onStatus(
      translate('viewer.find.position')
        .replace('{index}', String(next + 1))
        .replace('{count}', String(matches.length)),
    );
  };

  return {
    document,
    openDocument,
    receiveDocument: setLoaded,
    goToPage,
    zoom,
    setZoom,
    matches,
    currentMatch,
    onTextLayer: setLayer,
    findBar: {
      query,
      matchCount: matches.length,
      currentMatch,
      disabled: layer === null || layer.items.length === 0,
      onQueryChange: (value) => {
        setQuery(value);
        setCurrentMatch(null);
      },
      onNext: () => {
        stepMatch(1);
      },
      onPrevious: () => {
        stepMatch(-1);
      },
      onClear: () => {
        setQuery('');
        setCurrentMatch(null);
      },
    },
  };
}
