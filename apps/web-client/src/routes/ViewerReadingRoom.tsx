/**
 * The viewer reading room.
 *
 * The signed-in external viewer's entire surface: granted rooms, the published
 * tree within a room, and the page reader.
 *
 * Security posture, stated once here because every branch depends on it: this
 * component renders exactly what the server disclosed for this viewer's session.
 * It never filters a list for itself, so there is no client-side collection that
 * could leak an inaccessible title, path, count, or peer. A document that returns
 * `null` metadata is presented identically to one that does not exist, because the
 * server deliberately does not distinguish them.
 *
 * Preview evidence is opened before the first page is requested, since the page
 * delivery endpoint requires the activity id -- a page cannot be fetched without
 * the evidence that records it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isAborted } from '../api/abort.ts';
import {
  ApiError,
  beginPreview,
  createDownloadLease,
  fetchDownloadRange,
  loadViewerDocument,
  loadViewerRooms,
  loadViewerStructure,
  resolveInterstitial,
  signOut,
  type InterstitialTarget,
  type TextLayer,
  type TextLayerItem,
  type ViewerDocument,
  type ViewerEntry,
  type ViewerRoom,
} from '../api/client.ts';
import { AppShell } from '../components/AppShell.tsx';
import { DownloadPanel, type DownloadState } from '../components/DownloadPanel.tsx';
import { FindBar } from '../components/FindBar.tsx';
import { LinkInterstitial } from '../components/LinkInterstitial.tsx';
import { Notice } from '../components/Notice.tsx';
import { PageReader } from '../components/PageReader.tsx';
import { ThemeSelect, type ThemeChoice } from '../components/ThemeSelect.tsx';
import { translate } from '../i18n/translate.ts';
import { findMatches } from '../viewer/find.ts';
import { usePreviewEvidence } from '../viewer/usePreviewEvidence.ts';
import { useViewerIntroduction } from '../branding/useViewerIntroduction.ts';
import { formatViewerLocation, parseViewerLocation, useLocation } from '../navigation.ts';
import { DocumentPager, type Zoom } from '../components/DocumentPager.tsx';
import { RoomContents } from '../components/RoomContents.tsx';

export interface ViewerReadingRoomProps {
  readonly theme: ThemeChoice;
  readonly onThemeChange: (choice: ThemeChoice) => void;
  readonly onSignedOut: () => void;
}

type Load<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'failed'; readonly failure: string };

/** One range request per chunk. 4 MiB keeps memory bounded on long documents. */
const RANGE_CHUNK = 4 * 1024 * 1024;

function failureMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return translate('error.unavailable.body');
  switch (error.failure) {
    case 'offline':
      return translate('app.offline.body');
    case 'denied':
      return translate('error.denied.body');
    case 'fresh-authentication-required':
      return translate('error.freshSignIn.body');
    case 'not-found':
      return translate('error.notFound.body');
    case 'unauthenticated':
      return translate('viewer.expired');
    case 'rate-limited':
      return translate('otp.paused');
    /*
     * A viewer performs no optimistic write, so a 409 is not a stale-revision
     * collision they can resolve; and a 400 from a viewer request means the
     * client built a malformed one. Both are reported as the neutral unavailable
     * state rather than inventing viewer-facing copy for a condition a viewer
     * cannot act on.
     */
    case 'conflict':
    case 'invalid':
    case 'unavailable':
      return translate('error.unavailable.body');
  }
}

export function ViewerReadingRoom({
  theme,
  onThemeChange,
  onSignedOut,
}: ViewerReadingRoomProps): React.ReactElement {
  const [status, setStatus] = useState('');
  const [rooms, setRooms] = useState<Load<readonly ViewerRoom[]>>({ kind: 'loading' });
  const [location, navigate] = useLocation(parseViewerLocation, formatViewerLocation);
  const openRoomId = location.kind === 'room' ? location.roomId : null;
  const openDocumentId = location.kind === 'room' ? location.documentId : null;
  const pageNumber = location.kind === 'room' ? location.page : 1;
  const roomIntroduction = useViewerIntroduction(openRoomId !== null);
  const [structure, setStructure] = useState<Load<readonly ViewerEntry[]>>({
    kind: 'loading',
  });
  const [document, setDocument] = useState<Load<ViewerDocument | null>>({ kind: 'loading' });
  /* Page width as a share of the worktable. The text layer is positioned in
     percentages of the sheet, so it scales with the image. */
  const [zoom, setZoom] = useState<Zoom>(100);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  const [pendingSignOut, setPendingSignOut] = useState<'this-device' | 'everywhere' | null>(
    null,
  );

  const [layer, setLayer] = useState<TextLayer | null>(null);
  const [query, setQuery] = useState('');
  const [currentMatch, setCurrentMatch] = useState<number | null>(null);

  const [interstitial, setInterstitial] = useState<{
    readonly open: boolean;
    readonly target: InterstitialTarget | null;
    readonly loading: boolean;
    readonly failure: string | null;
  } | null>(null);

  const [download, setDownload] = useState<DownloadState>({ kind: 'idle' });
  const downloadAbort = useRef<AbortController | null>(null);

  const matches = useMemo(
    () => (layer === null ? [] : findMatches(layer.items, query)),
    [layer, query],
  );

  const onEvidenceRejected = useCallback(() => {
    setAccessLost(true);
  }, []);
  usePreviewEvidence({ activityId, onRejected: onEvidenceRejected });

  const openRoom = useCallback(
    (roomId: string, mode: 'push' | 'replace' = 'push'): void => {
      navigate({ kind: 'room', roomId, documentId: null, page: 1 }, mode);
    },
    [navigate],
  );
  const openDocumentById = (documentId: string): void => {
    if (openRoomId === null) return;
    navigate({ kind: 'room', roomId: openRoomId, documentId, page: 1 });
  };
  const closeDocument = (): void => {
    if (openRoomId === null) return;
    setActivityId(null);
    navigate({ kind: 'room', roomId: openRoomId, documentId: null, page: 1 });
  };

  useEffect(() => {
    const controller = new AbortController();
    loadViewerRooms(controller.signal).then(
      (value) => {
        setRooms({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRooms({ kind: 'failed', failure: failureMessage(error) });
      },
    );
    return () => {
      controller.abort();
    };
  }, []);

  /* Most readers hold one room. Arriving at the room list with a single entry is a
     click that decides nothing, so the first arrival lands in the room itself; the
     room list stays reachable afterwards. */
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current || rooms.kind !== 'ready') return;
    arrived.current = true;
    const [only] = rooms.value;
    if (rooms.value.length === 1 && only !== undefined && location.kind === 'rooms')
      openRoom(only.roomId, 'replace');
  }, [rooms, location.kind, openRoom]);

  useEffect(() => {
    if (openRoomId === null) return;
    const controller = new AbortController();
    setStructure({ kind: 'loading' });
    loadViewerStructure(openRoomId, controller.signal).then(
      (value) => {
        setStructure({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setStructure({ kind: 'failed', failure: failureMessage(error) });
      },
    );
    return () => {
      controller.abort();
    };
  }, [openRoomId]);

  // Opening a document: read its metadata, then open one preview activity for
  // the published version before any page is requested.
  useEffect(() => {
    if (openRoomId === null || openDocumentId === null) return;
    const controller = new AbortController();
    setDocument({ kind: 'loading' });
    setActivityId(null);
    setQuery('');
    setCurrentMatch(null);
    setDownload({ kind: 'idle' });

    void (async () => {
      try {
        const metadata = await loadViewerDocument(
          { roomId: openRoomId, documentId: openDocumentId },
          controller.signal,
        );
        if (isAborted(controller.signal)) return;
        setDocument({ kind: 'ready', value: metadata });
        if (metadata === null) return;
        const activity = await beginPreview(
          {
            roomId: openRoomId,
            documentId: openDocumentId,
            versionId: metadata.publishedVersionId,
          },
          controller.signal,
        );
        if (isAborted(controller.signal)) return;
        setActivityId(activity.activityId);
      } catch (error) {
        if (isAborted(controller.signal)) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setDocument({ kind: 'failed', failure: failureMessage(error) });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [openRoomId, openDocumentId]);

  const requestSignOut = (scope: 'this-device' | 'everywhere'): void => {
    setPendingSignOut(scope);
    setStatus(translate('shell.signOut.pending'));
    signOut('viewer', scope).then(
      () => {
        setPendingSignOut(null);
        onSignedOut();
      },
      () => {
        setPendingSignOut(null);
        setStatus(translate('shell.signOut.failed'));
      },
    );
  };

  const openLink = (item: TextLayerItem): void => {
    if (item.link === undefined) return;
    setInterstitial({ open: true, target: null, loading: true, failure: null });
    resolveInterstitial(item.link.interstitialPath).then(
      (target) => {
        setInterstitial({ open: true, target, loading: false, failure: null });
      },
      () => {
        setInterstitial({
          open: true,
          target: null,
          loading: false,
          failure: translate('viewer.link.failed'),
        });
      },
    );
  };

  /**
   * Streams the original through sequential authenticated range requests, then
   * hands the assembled bytes to the browser as a download. Every range is
   * re-authorized server-side, so a revocation mid-download stops the next range
   * rather than being detected client-side.
   */
  const startDownload = (): void => {
    if (openRoomId === null || openDocumentId === null) return;
    const controller = new AbortController();
    downloadAbort.current = controller;
    setDownload({ kind: 'active', received: 0, total: 1 });
    setStatus(translate('viewer.download.pending'));

    void (async () => {
      try {
        const lease = await createDownloadLease({
          roomId: openRoomId,
          documentId: openDocumentId,
        });
        if (isAborted(controller.signal)) return;
        setDownload({ kind: 'active', received: 0, total: lease.sizeBytes });
        const chunks: ArrayBuffer[] = [];
        let received = 0;
        while (received < lease.sizeBytes) {
          const end = Math.min(received + RANGE_CHUNK, lease.sizeBytes) - 1;
          const chunk = await fetchDownloadRange({
            leaseId: lease.leaseId,
            start: received,
            end,
            signal: controller.signal,
          });
          if (isAborted(controller.signal)) return;
          chunks.push(chunk);
          received += chunk.byteLength;
          setDownload({ kind: 'active', received, total: lease.sizeBytes });
          // A server that returns fewer bytes than requested without reaching the
          // end would otherwise spin forever.
          if (chunk.byteLength === 0) throw new ApiError('unavailable');
        }
        const blob = new Blob(chunks);
        const url = URL.createObjectURL(blob);
        try {
          const anchor = window.document.createElement('a');
          anchor.href = url;
          anchor.download = lease.filename;
          anchor.rel = 'noopener';
          anchor.click();
        } finally {
          // Released immediately: the object URL is the only place these bytes
          // are reachable, and nothing is written to storage or a cache.
          URL.revokeObjectURL(url);
        }
        setDownload({ kind: 'done' });
        setStatus(translate('viewer.download.done'));
      } catch (error) {
        if (isAborted(controller.signal)) {
          setDownload({ kind: 'cancelled' });
          setStatus(translate('viewer.download.cancelled'));
          return;
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
          setDownload({ kind: 'cancelled' });
          return;
        }
        const expired =
          error instanceof ApiError &&
          (error.failure === 'denied' || error.failure === 'unauthenticated');
        setDownload({
          kind: 'failed',
          message: expired
            ? translate('viewer.download.expired')
            : translate('viewer.download.failed'),
        });
        setStatus(translate('viewer.download.failed'));
      } finally {
        downloadAbort.current = null;
      }
    })();
  };

  const entries = structure.kind === 'ready' ? structure.value : [];

  // Depth for the finding-aid indent, derived from the parent chain the server
  // disclosed. An entry whose parent is not in the response is a grant root and
  // sits at depth 0.
  const byResource = new Map(entries.map((item) => [item.resourceId, item]));
  const depthOf = (entry: ViewerEntry): number => {
    let depth = 0;
    let parent = entry.parentFolderId;
    while (parent !== null) {
      const next = byResource.get(parent);
      if (next === undefined) break;
      depth += 1;
      parent = next.parentFolderId;
    }
    return depth;
  };

  const indexEntries =
    openRoomId === null
      ? rooms.kind === 'ready'
        ? rooms.value.map((room) => ({
            id: room.roomId,
            title: room.title,
            depth: 0,
            kind: 'item' as const,
          }))
        : []
      : entries.map((entry) => ({
          id: entry.entryId,
          title: entry.displayName,
          depth: depthOf(entry),
          kind: entry.resourceKind === 'folder' ? ('group' as const) : ('item' as const),
        }));

  const openDocument = document.kind === 'ready' ? document.value : null;
  const totalPages = openDocument?.pageCount ?? 0;

  const goToPage = (next: number): void => {
    if (next < 1 || next > totalPages || location.kind !== 'room') return;
    /* Replace, not push: Back should leave the document, not step through its pages. */
    navigate({ ...location, page: next }, 'replace');
    setCurrentMatch(null);
    setStatus(
      translate('viewer.page.announce')
        .replace('{page}', String(next))
        .replace('{total}', String(totalPages)),
    );
  };

  /* A page from a stale link past the end of a republished document opens page one. */
  useEffect(() => {
    if (openDocument === null || location.kind !== 'room') return;
    if (location.page > openDocument.pageCount) navigate({ ...location, page: 1 }, 'replace');
  }, [openDocument, location, navigate]);

  const stepMatch = (delta: number): void => {
    if (matches.length === 0) {
      setStatus(translate('viewer.find.none'));
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
    setStatus(
      translate('viewer.find.position')
        .replace('{index}', String(next + 1))
        .replace('{count}', String(matches.length)),
    );
  };

  return (
    <AppShell
      title={
        openRoomId === null
          ? translate('viewer.rooms.title')
          : (openDocument?.displayTitle ??
            (rooms.kind === 'ready'
              ? (rooms.value.find((room) => room.roomId === openRoomId)?.title ??
                translate('viewer.rooms.title'))
              : translate('viewer.rooms.title')))
      }
      entries={indexEntries}
      currentEntryId={
        openDocumentId === null
          ? openRoomId
          : (entries.find((entry) => entry.resourceId === openDocumentId)?.entryId ?? null)
      }
      indexEmpty={
        openRoomId === null
          ? null
          : {
              lead: translate('viewer.index.empty'),
              help: translate('viewer.index.emptyHelp'),
            }
      }
      onSelectEntry={(id) => {
        if (openRoomId === null) {
          if (rooms.kind === 'ready' && rooms.value.some((room) => room.roomId === id))
            openRoom(id);
          return;
        }
        const entry = entries.find((item) => item.entryId === id);
        if (entry?.resourceKind === 'document') openDocumentById(entry.resourceId);
      }}
      status={status}
      notes={
        <>
          {/* Security-bearing sentences remain on every reading surface; the
              optional branding slot contributes organization-owned copy. */}
          <p>{translate('viewer.watermark.notice')}</p>
          <p>{translate('viewer.screenshot.honesty')}</p>
          {roomIntroduction.kind === 'loaded' && roomIntroduction.value !== '' ? (
            <p className="df-reading-room__introduction">{roomIntroduction.value}</p>
          ) : roomIntroduction.kind === 'failed' ? (
            <p className="df-reading-room__introduction" role="alert">
              {translate('viewer.introduction.failed')}
            </p>
          ) : null}
        </>
      }
      contextActions={
        openDocumentId !== null ? (
          <button type="button" className="df-button df-button--quiet" onClick={closeDocument}>
            {translate('viewer.index.heading')}
          </button>
        ) : null
      }
      accountActions={
        <>
          <ThemeSelect value={theme} onChange={onThemeChange} />
          {openRoomId !== null ? (
            <button
              type="button"
              className="df-button df-button--quiet"
              onClick={() => {
                setActivityId(null);
                navigate({ kind: 'rooms' });
              }}
            >
              {translate('viewer.rooms.title')}
            </button>
          ) : null}
          <button
            type="button"
            className="df-button"
            data-busy={pendingSignOut === 'this-device' ? 'true' : 'false'}
            disabled={pendingSignOut !== null}
            onClick={() => {
              requestSignOut('this-device');
            }}
          >
            {translate('shell.signOut')}
          </button>
          <button
            type="button"
            className="df-button df-button--quiet"
            data-busy={pendingSignOut === 'everywhere' ? 'true' : 'false'}
            disabled={pendingSignOut !== null}
            onClick={() => {
              requestSignOut('everywhere');
            }}
          >
            {translate('shell.signOutEverywhere')}
          </button>
        </>
      }
    >
      {accessLost ? (
        <Notice tone="problem" role="alert">
          {translate('viewer.revoked')}
        </Notice>
      ) : openRoomId === null ? (
        rooms.kind === 'loading' ? (
          <p className="df-field__help">{translate('viewer.rooms.loading')}</p>
        ) : rooms.kind === 'failed' ? (
          <Notice tone="problem" role="alert">
            {rooms.failure}
          </Notice>
        ) : rooms.value.length === 0 ? (
          <div className="df-empty df-empty--worktable">
            <span className="df-empty__lead">{translate('viewer.rooms.empty')}</span>
            {translate('viewer.rooms.emptyHelp')}
          </div>
        ) : (
          <ul className="df-results">
            {rooms.value.map((room) => (
              <li key={room.roomId}>
                <button
                  type="button"
                  className="df-button df-button--quiet"
                  onClick={() => {
                    openRoom(room.roomId);
                  }}
                >
                  <span className="df-results__name">{room.title}</span>
                </button>
                {room.description === '' ? null : (
                  <span className="df-register__meta">{room.description}</span>
                )}
              </li>
            ))}
          </ul>
        )
      ) : openDocumentId === null ? (
        structure.kind === 'loading' ? (
          <p className="df-field__help">{translate('viewer.structure.loading')}</p>
        ) : structure.kind === 'failed' ? (
          <Notice tone="problem" role="alert">
            {structure.failure}
          </Notice>
        ) : entries.length === 0 ? (
          <div className="df-empty df-empty--worktable">
            <span className="df-empty__lead">{translate('viewer.index.empty')}</span>
            {translate('viewer.index.emptyHelp')}
          </div>
        ) : (
          <RoomContents entries={entries} depthOf={depthOf} onOpenDocument={openDocumentById} />
        )
      ) : document.kind === 'loading' ? (
        <p className="df-field__help">{translate('viewer.document.loading')}</p>
      ) : document.kind === 'failed' ? (
        <Notice tone="problem" role="alert">
          {document.failure}
        </Notice>
      ) : openDocument === null ? (
        <div className="df-empty df-empty--worktable">
          <span className="df-empty__lead">{translate('viewer.document.unavailable')}</span>
          {translate('viewer.document.unavailableHelp')}
        </div>
      ) : (
        <>
          <FindBar
            query={query}
            matchCount={matches.length}
            currentMatch={currentMatch}
            disabled={layer === null || layer.items.length === 0}
            onQueryChange={(value) => {
              setQuery(value);
              setCurrentMatch(null);
            }}
            onNext={() => {
              stepMatch(1);
            }}
            onPrevious={() => {
              stepMatch(-1);
            }}
            onClear={() => {
              setQuery('');
              setCurrentMatch(null);
            }}
          />

          <DocumentPager
            pageNumber={pageNumber}
            pageCount={openDocument.pageCount}
            zoom={zoom}
            onPage={goToPage}
            onZoom={setZoom}
          />

          {/* Selecting another document renders once with the previous document's
              metadata and activity before they reset; without the id check that
              render requests a page of the new document it has no activity for. */}
          {activityId === null || openDocument.documentId !== openDocumentId ? (
            <p className="df-field__help">{translate('viewer.document.loading')}</p>
          ) : (
            <div className="df-page-zoom" data-zoom={zoom}>
              <PageReader
                roomId={openRoomId}
                documentId={openDocumentId}
                pageNumber={pageNumber}
                totalPages={openDocument.pageCount}
                activityId={activityId}
                matches={matches}
                currentMatch={currentMatch}
                onTextLayer={setLayer}
                onLinkActivate={openLink}
                onUnauthorized={() => {
                  setAccessLost(true);
                }}
              />
            </div>
          )}

          <DownloadPanel
            policy={openDocument.downloadPolicy}
            state={download}
            onStart={startDownload}
            onCancel={() => {
              downloadAbort.current?.abort();
            }}
          />
        </>
      )}

      <LinkInterstitial
        open={interstitial?.open ?? false}
        target={interstitial?.target ?? null}
        loading={interstitial?.loading ?? false}
        failure={interstitial?.failure ?? null}
        onCancel={() => {
          setInterstitial((current) => (current === null ? null : { ...current, open: false }));
        }}
      />
    </AppShell>
  );
}
