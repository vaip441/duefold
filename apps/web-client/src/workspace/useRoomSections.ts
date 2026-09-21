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
 */

import { useCallback, useState } from 'react';
import {
  deleteFailedSource,
  downloadExportOnce,
  generateExport,
  loadExports,
  loadProcessingState,
  preflightExport,
  retryProcessing,
  type ExportPreflight,
  type ExportPreset,
  type ExportRecord,
  type ProcessingVersion,
} from '../api/client.ts';
import { presentFailure, type PresentedFailure } from './failures.ts';
import type { Load } from './state.ts';

export interface ProcessingSection {
  readonly versions: Load<readonly ProcessingVersion[]>;
  readonly failure: PresentedFailure | null;
  readonly busyVersionId: string | null;
  readonly refresh: (roomId: string, signal?: AbortSignal) => void;
  readonly beginLoading: () => void;
  readonly retry: (version: ProcessingVersion) => void;
  readonly deleteSource: (version: ProcessingVersion) => void;
}

export function useProcessingSection(handlers: {
  readonly onRetried: () => void;
  readonly onSourceDeleted: () => void;
  readonly roomId: () => string | null;
}): ProcessingSection {
  const [versions, setVersions] = useState<Load<readonly ProcessingVersion[]>>({
    kind: 'loading',
  });
  const [failure, setFailure] = useState<PresentedFailure | null>(null);
  const [busyVersionId, setBusyVersionId] = useState<string | null>(null);

  const refresh = useCallback((roomId: string, signal?: AbortSignal): void => {
    setFailure(null);
    loadProcessingState(roomId, signal).then(
      (value) => {
        setVersions({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const presented = presentFailure(error);
        setVersions({ kind: 'failed', failure: presented.title });
        setFailure(presented);
      },
    );
  }, []);

  const beginLoading = useCallback((): void => {
    setVersions({ kind: 'loading' });
  }, []);

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
        refresh(roomId);
      },
      (error: unknown) => {
        setBusyVersionId(null);
        setFailure(presentFailure(error));
      },
    );
  };

  return {
    versions,
    failure,
    busyVersionId,
    refresh,
    beginLoading,
    retry: (version) => {
      act(version, retryProcessing, handlers.onRetried);
    },
    deleteSource: (version) => {
      act(version, deleteFailedSource, handlers.onSourceDeleted);
    },
  };
}

export interface ExportsSection {
  readonly exports: Load<readonly ExportRecord[]>;
  readonly failure: PresentedFailure | null;
  readonly preflight: ExportPreflight | null;
  readonly preflightPending: boolean;
  readonly generatePending: boolean;
  readonly downloadingId: string | null;
  readonly refresh: (roomId: string, signal?: AbortSignal) => void;
  readonly beginLoading: () => void;
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
  const [exports, setExports] = useState<Load<readonly ExportRecord[]>>({ kind: 'loading' });
  const [failure, setFailure] = useState<PresentedFailure | null>(null);
  const [preflight, setPreflight] = useState<ExportPreflight | null>(null);
  const [request, setRequest] = useState<{
    readonly preset: ExportPreset;
    readonly includeOriginals: boolean;
    readonly selectedDocumentIds: readonly string[];
  } | null>(null);
  const [preflightPending, setPreflightPending] = useState(false);
  const [generatePending, setGeneratePending] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const refresh = useCallback((roomId: string, signal?: AbortSignal): void => {
    setFailure(null);
    loadExports(roomId, signal).then(
      (value) => {
        setExports({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const presented = presentFailure(error);
        setExports({ kind: 'failed', failure: presented.title });
        setFailure(presented);
      },
    );
  }, []);

  const beginLoading = useCallback((): void => {
    setExports({ kind: 'loading' });
  }, []);

  return {
    exports,
    failure,
    preflight,
    preflightPending,
    generatePending,
    downloadingId,
    refresh,
    beginLoading,
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
