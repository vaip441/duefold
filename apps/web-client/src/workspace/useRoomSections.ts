/**
 * Processing and exports section state.
 *
 * Extracted from `Workspace` alongside the participants hook. Both share a
 * shape -- load a list for the open room, run one action, reload from the server --
 * so they live together rather than in two near-identical files.
 *
 * Branding's section state moved into the optional module that owns it, so an
 * installation that omits branding ships neither its state machine nor its copy.
 *
 * The rule each loader preserves: a failed load becomes `failed`, never `ready` with
 * an empty value. Rendering "nothing is processing" or "No exports yet" for a refused
 * request represents inaccessible data as absent, which is how revocation was once
 * hidden from a viewer.
 *
 * `continuesFrom` holds the cursor object the shown listing continues from. These hooks outlive a
 * room switch, so a "load older" page that settles after a refresh or a switch continues a
 * listing that is gone: its rows, its failure, and its busy state are all dropped.
 */

import { useCallback, useRef, useState } from 'react';
import {
  deleteFailedSource,
  downloadExportOnce,
  generateExport,
  loadExports,
  loadProcessingState,
  preflightExport,
  retryProcessing,
  type ExportPage,
  type ExportPreflight,
  type ExportPreset,
  type ProcessingPage,
  type ProcessingVersion,
} from '../api/client.ts';
import { presentFailure, type PresentedFailure } from './failures.ts';
import type { Load } from './state.ts';

export interface ProcessingSection {
  readonly listing: Load<ProcessingPage>;
  readonly failure: PresentedFailure | null;
  readonly busyVersionId: string | null;
  readonly loadingMore: boolean;
  readonly refresh: (roomId: string, signal?: AbortSignal) => Promise<void>;
  readonly beginLoading: () => void;
  readonly loadMore: (roomId: string) => void;
  readonly retry: (version: ProcessingVersion) => void;
  readonly deleteSource: (version: ProcessingVersion) => void;
}

export function useProcessingSection(handlers: {
  readonly onRetried: () => void;
  readonly onSourceDeleted: () => void;
  readonly roomId: () => string | null;
}): ProcessingSection {
  const [listing, setListing] = useState<Load<ProcessingPage>>({ kind: 'loading' });
  const [failure, setFailure] = useState<PresentedFailure | null>(null);
  const [busyVersionId, setBusyVersionId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const continuesFrom = useRef<ProcessingPage['nextCursor']>(null);

  const refresh = useCallback(async (roomId: string, signal?: AbortSignal): Promise<void> => {
    setFailure(null);
    try {
      const value = await loadProcessingState(
        signal === undefined ? { roomId } : { roomId, signal },
      );
      continuesFrom.current = value.nextCursor;
      setLoadingMore(false);
      setListing({ kind: 'ready', value });
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const presented = presentFailure(error);
      continuesFrom.current = null;
      setLoadingMore(false);
      setListing({ kind: 'failed', failure: presented.title });
      setFailure(presented);
      throw error;
    }
  }, []);

  const beginLoading = useCallback((): void => {
    continuesFrom.current = null;
    setLoadingMore(false);
    setListing({ kind: 'loading' });
  }, []);

  const loadMore = (roomId: string): void => {
    if (listing.kind !== 'ready' || listing.value.nextCursor === null) return;
    const after = listing.value.nextCursor;
    setLoadingMore(true);
    setFailure(null);
    loadProcessingState({ roomId, after }).then(
      (page) => {
        if (continuesFrom.current !== after) return;
        continuesFrom.current = page.nextCursor;
        setLoadingMore(false);
        setListing((current) =>
          current.kind === 'ready'
            ? {
                kind: 'ready',
                value: {
                  versions: [...current.value.versions, ...page.versions],
                  nextCursor: page.nextCursor,
                },
              }
            : current,
        );
      },
      (error: unknown) => {
        if (continuesFrom.current !== after) return;
        setLoadingMore(false);
        setFailure(presentFailure(error));
      },
    );
  };

  const act = (
    version: ProcessingVersion,
    run: (versionId: string) => Promise<void>,
    done: () => void,
  ): void => {
    const roomId = handlers.roomId();
    if (roomId === null) return;
    setBusyVersionId(version.versionId);
    setFailure(null);
    run(version.versionId).then(
      () => {
        setBusyVersionId(null);
        done();
        void refresh(roomId);
      },
      (error: unknown) => {
        setBusyVersionId(null);
        setFailure(presentFailure(error));
      },
    );
  };

  return {
    listing,
    failure,
    busyVersionId,
    loadingMore,
    refresh,
    beginLoading,
    loadMore,
    retry: (version) => {
      act(version, retryProcessing, handlers.onRetried);
    },
    deleteSource: (version) => {
      act(version, deleteFailedSource, handlers.onSourceDeleted);
    },
  };
}

export interface ExportsSection {
  readonly listing: Load<ExportPage>;
  readonly failure: PresentedFailure | null;
  readonly loadingMore: boolean;
  readonly preflight: ExportPreflight | null;
  readonly preflightPending: boolean;
  readonly generatePending: boolean;
  readonly downloadingId: string | null;
  readonly refresh: (roomId: string, signal?: AbortSignal) => void;
  readonly beginLoading: () => void;
  readonly loadMore: (roomId: string) => void;
  readonly review: (input: {
    roomId: string;
    preset: ExportPreset;
    includeOriginals: boolean;
    selectedDocumentIds: readonly string[];
  }) => void;
  readonly generate: (roomId: string) => void;
  /* Resolves with the archive; saving it is the route's business, not this hook's. */
  readonly download: (exportId: string) => Promise<Blob | null>;
  readonly cancelReview: () => void;
}

export function useExportsSection(handlers: {
  readonly onGenerated: () => void;
  readonly onDownloaded: () => void;
}): ExportsSection {
  const [listing, setListing] = useState<Load<ExportPage>>({ kind: 'loading' });
  const [failure, setFailure] = useState<PresentedFailure | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [preflight, setPreflight] = useState<ExportPreflight | null>(null);
  const [request, setRequest] = useState<{
    readonly preset: ExportPreset;
    readonly includeOriginals: boolean;
    readonly selectedDocumentIds: readonly string[];
  } | null>(null);
  const [preflightPending, setPreflightPending] = useState(false);
  const [generatePending, setGeneratePending] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const continuesFrom = useRef<ExportPage['nextCursor']>(null);

  const refresh = useCallback((roomId: string, signal?: AbortSignal): void => {
    setFailure(null);
    loadExports(signal === undefined ? { roomId } : { roomId, signal }).then(
      (value) => {
        continuesFrom.current = value.nextCursor;
        setLoadingMore(false);
        setListing({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const presented = presentFailure(error);
        continuesFrom.current = null;
        setLoadingMore(false);
        setListing({ kind: 'failed', failure: presented.title });
        setFailure(presented);
      },
    );
  }, []);

  const beginLoading = useCallback((): void => {
    continuesFrom.current = null;
    setLoadingMore(false);
    setListing({ kind: 'loading' });
  }, []);

  const loadMore = (roomId: string): void => {
    if (listing.kind !== 'ready' || listing.value.nextCursor === null) return;
    const after = listing.value.nextCursor;
    setLoadingMore(true);
    setFailure(null);
    loadExports({ roomId, after }).then(
      (page) => {
        if (continuesFrom.current !== after) return;
        continuesFrom.current = page.nextCursor;
        setLoadingMore(false);
        setListing((current) =>
          current.kind === 'ready'
            ? {
                kind: 'ready',
                value: {
                  exports: [...current.value.exports, ...page.exports],
                  nextCursor: page.nextCursor,
                },
              }
            : current,
        );
      },
      (error: unknown) => {
        if (continuesFrom.current !== after) return;
        setLoadingMore(false);
        setFailure(presentFailure(error));
      },
    );
  };

  return {
    listing,
    failure,
    loadingMore,
    preflight,
    preflightPending,
    generatePending,
    downloadingId,
    refresh,
    beginLoading,
    loadMore,
    review: (input) => {
      setPreflightPending(true);
      setFailure(null);
      setPreflight(null);
      setRequest({
        preset: input.preset,
        includeOriginals: input.includeOriginals,
        selectedDocumentIds: input.selectedDocumentIds,
      });
      preflightExport(input).then(
        (value) => {
          setPreflightPending(false);
          setPreflight(value);
        },
        (error: unknown) => {
          setPreflightPending(false);
          setFailure(presentFailure(error));
        },
      );
    },
    generate: (roomId) => {
      const pending = request;
      if (pending === null) return;
      setGeneratePending(true);
      setFailure(null);
      generateExport({ roomId, ...pending }).then(
        () => {
          setGeneratePending(false);
          setPreflight(null);
          setRequest(null);
          handlers.onGenerated();
          refresh(roomId);
        },
        (error: unknown) => {
          setGeneratePending(false);
          setFailure(presentFailure(error));
        },
      );
    },
    download: async (exportId) => {
      setDownloadingId(exportId);
      setFailure(null);
      try {
        const blob = await downloadExportOnce(exportId);
        setDownloadingId(null);
        handlers.onDownloaded();
        return blob;
      } catch (error: unknown) {
        setDownloadingId(null);
        setFailure(presentFailure(error));
        return null;
      }
    },
    cancelReview: () => {
      setPreflight(null);
      setRequest(null);
      setFailure(null);
    },
  };
}
