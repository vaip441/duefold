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
  createDownloadLease,
  fetchDownloadRange,
  loadViewerDocument,
  loadViewerRooms,
  loadViewerStructure,
  resolveInterstitial,
  signOut,
  type InterstitialTarget,
  type TextLayerItem,
  type ViewerEntry,
  type ViewerRoom,
} from '../api/client.ts';
import { AppShell } from '../components/AppShell.tsx';
import { DocumentPages } from '../components/DocumentPages.tsx';
import { DownloadPanel, type DownloadState } from '../components/DownloadPanel.tsx';
import { LinkInterstitial } from '../components/LinkInterstitial.tsx';
import { Notice } from '../components/Notice.tsx';
import { ThemeSelect, type ThemeChoice } from '../components/ThemeSelect.tsx';
import { translate } from '../i18n/translate.ts';
import { protectedPageSource } from '../viewer/page-source.ts';
import { collectionEntries, depthFirst, entryDepth } from '../viewer/structure-depth.ts';
import { useDocumentReader } from '../viewer/useDocumentReader.ts';
import { usePreviewEvidence, type AccessLoss } from '../viewer/usePreviewEvidence.ts';
import { useViewerIntroduction } from '../branding/useViewerIntroduction.ts';
import { formatViewerLocation, parseViewerLocation, useLocation } from '../navigation.ts';
import { RoomContents } from '../components/RoomContents.tsx';
import { presentFailure } from '../workspace/failures.ts';
import type { Load } from '../workspace/state.ts';

export interface ViewerReadingRoomProps {
  readonly theme: ThemeChoice;
  readonly onThemeChange: (choice: ThemeChoice) => void;
  readonly onSignedOut: () => void;
}

/** One range request per chunk. 4 MiB keeps memory bounded on long documents. */
const RANGE_CHUNK = 4 * 1024 * 1024;

/* A viewer performs no write, so a 409 is not a collision they can resolve and a 400
   means the client built a malformed request: neither gets copy asking them to act. */
function viewerFailure(error: unknown): string {
  const failure = error instanceof ApiError ? error.failure : null;
  if (failure === 'unauthenticated') return translate('viewer.expired');
  if (failure === 'conflict' || failure === 'invalid' || failure === 'export-too-large')
    return translate('error.unavailable.body');
  return presentFailure(error).body;
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
  const replacePage = useCallback(
    (next: number) => {
      if (location.kind === 'room') navigate({ ...location, page: next }, 'replace');
    },
    [location, navigate],
  );
  const reader = useDocumentReader({
    documentId: openDocumentId,
    page: pageNumber,
    onPage: replacePage,
    onStatus: setStatus,
  });
  const { document, openDocument, receiveDocument } = reader;
  const [sessionEnded, setSessionEnded] = useState(false);
  const [roomLost, setRoomLost] = useState(false);
  const [roomsRead, setRoomsRead] = useState(0);
  const [documentWithdrawn, setDocumentWithdrawn] = useState(false);
  const [pendingSignOut, setPendingSignOut] = useState<'this-device' | 'everywhere' | null>(
    null,
  );

  const [interstitial, setInterstitial] = useState<{
    readonly open: boolean;
    readonly target: InterstitialTarget | null;
    readonly loading: boolean;
    readonly failure: string | null;
  } | null>(null);

  const [download, setDownload] = useState<DownloadState>({ kind: 'idle' });
  const downloadAbort = useRef<AbortController | null>(null);
  const linkAbort = useRef<AbortController | null>(null);
  const refusalAbort = useRef<AbortController | null>(null);

  /* Most readers hold one room. Arriving at the room list with a single entry is a
     click that decides nothing, so the first arrival lands in the room itself; the
     room list stays reachable afterwards. */
  const arrived = useRef(false);
  /* An ended session ends every room. A refusal ends only the open room: the investor
     returns to a re-read list of the rooms they can still read, and never lands back
     in the lost room even when it is the only one listed. */
  const loseAccess = useCallback(
    (failure: AccessLoss) => {
      if (failure === 'unauthenticated') {
        setSessionEnded(true);
        return;
      }
      arrived.current = true;
      setRoomLost(true);
      setRoomsRead((count) => count + 1);
      navigate({ kind: 'rooms' }, 'replace');
    },
    [navigate],
  );
  /* A refused open means the published version changed or access ended, and the
     metadata says which: a new version is read from then on. A withdrawn document
     reads as unavailable at once, then returns the reader to the room while it still
     discloses a document, the test the room list applies; otherwise the room stops.
     Any other failure leaves the page's own retry in place. */
  const onEvidenceRefused = useCallback(() => {
    if (openRoomId === null || openDocumentId === null) return;
    refusalAbort.current?.abort();
    const controller = new AbortController();
    refusalAbort.current = controller;
    loadViewerDocument({ roomId: openRoomId, documentId: openDocumentId }, controller.signal)
      .then(async (metadata) => {
        if (isAborted(controller.signal)) return;
        if (metadata !== null) {
          receiveDocument({
            documentId: openDocumentId,
            load: { kind: 'ready', value: metadata },
          });
          return;
        }
        receiveDocument({ documentId: openDocumentId, load: { kind: 'ready', value: null } });
        const value = await loadViewerStructure(openRoomId, controller.signal);
        if (isAborted(controller.signal)) return;
        if (!value.some((entry) => entry.resourceKind === 'document')) {
          loseAccess('denied');
          return;
        }
        setStructure({ kind: 'ready', value });
        setDocumentWithdrawn(true);
        setStatus(translate('viewer.document.unavailable'));
        navigate({ kind: 'room', roomId: openRoomId, documentId: null, page: 1 }, 'replace');
      })
      .catch((error: unknown) => {
        if (isAborted(controller.signal)) return;
        if (
          error instanceof ApiError &&
          (error.failure === 'unauthenticated' || error.failure === 'denied')
        )
          loseAccess(error.failure);
      });
  }, [openRoomId, openDocumentId, receiveDocument, navigate, loseAccess]);
  const openActivity = usePreviewEvidence({
    target:
      sessionEnded || openRoomId === null || openDocument === null
        ? null
        : {
            roomId: openRoomId,
            documentId: openDocument.documentId,
            versionId: openDocument.publishedVersionId,
          },
    onRefused: onEvidenceRefused,
    onRejected: loseAccess,
  });
  const pageSource = useMemo(
    () => (openActivity === null ? null : protectedPageSource(openActivity)),
    [openActivity],
  );

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
    navigate({ kind: 'room', roomId: openRoomId, documentId: null, page: 1 });
  };

  // Rewrites a bare '/' or a link from before the /read prefix, so a reload after the
  // session ends offers the investor sign-in. Only a load or Back brings such an address:
  // navigate writes canonical ones, and replacing one later would undo a newer move.
  useEffect(() => {
    const { pathname, search } = window.location;
    if (formatViewerLocation(parseViewerLocation(pathname, search)) !== `${pathname}${search}`)
      navigate(location, 'replace');
  }, [location, navigate]);

  useEffect(() => {
    const controller = new AbortController();
    setRooms({ kind: 'loading' });
    loadViewerRooms(controller.signal).then(
      (value) => {
        setRooms({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRooms({ kind: 'failed', failure: viewerFailure(error) });
      },
    );
    return () => {
      controller.abort();
    };
  }, [roomsRead]);

  useEffect(() => {
    if (arrived.current || rooms.kind !== 'ready') return;
    arrived.current = true;
    const [only] = rooms.value;
    if (rooms.value.length === 1 && only !== undefined && location.kind === 'rooms')
      openRoom(only.roomId, 'replace');
  }, [rooms, location.kind, openRoom]);

  useEffect(() => {
    setDocumentWithdrawn(false);
    if (openRoomId === null) return;
    setRoomLost(false);
    const controller = new AbortController();
    setStructure({ kind: 'loading' });
    // A withdrawal's re-read may answer first, and it is the fresher of the two.
    const settle = (next: Load<readonly ViewerEntry[]>): void => {
      setStructure((current) => (current.kind === 'loading' ? next : current));
    };
    loadViewerStructure(openRoomId, controller.signal).then(
      (value) => {
        settle({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        settle({ kind: 'failed', failure: viewerFailure(error) });
      },
    );
    return () => {
      controller.abort();
    };
  }, [openRoomId]);

  // Opening a document reads its metadata; the evidence hook then opens the preview
  // activity for that published version before any page is delivered.
  useEffect(() => {
    if (openRoomId === null || openDocumentId === null) return;
    const controller = new AbortController();
    setDocumentWithdrawn(false);
    receiveDocument({ documentId: openDocumentId, load: { kind: 'loading' } });
    setDownload({ kind: 'idle' });

    void (async () => {
      try {
        const metadata = await loadViewerDocument(
          { roomId: openRoomId, documentId: openDocumentId },
          controller.signal,
        );
        if (isAborted(controller.signal)) return;
        receiveDocument({
          documentId: openDocumentId,
          load: { kind: 'ready', value: metadata },
        });
      } catch (error) {
        if (isAborted(controller.signal)) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        receiveDocument({
          documentId: openDocumentId,
          load: { kind: 'failed', failure: viewerFailure(error) },
        });
      }
    })();

    return () => {
      controller.abort();
      // A link, download or re-read started under this document must not answer under the next.
      refusalAbort.current?.abort();
      refusalAbort.current = null;
      linkAbort.current?.abort();
      linkAbort.current = null;
      setInterstitial(null);
      downloadAbort.current?.abort();
      downloadAbort.current = null;
    };
  }, [openRoomId, openDocumentId, receiveDocument]);

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
    linkAbort.current?.abort();
    const controller = new AbortController();
    linkAbort.current = controller;
    setInterstitial({ open: true, target: null, loading: true, failure: null });
    resolveInterstitial(item.link.interstitialPath, controller.signal).then(
      (target) => {
        if (isAborted(controller.signal)) return;
        setInterstitial({ open: true, target, loading: false, failure: null });
      },
      () => {
        if (isAborted(controller.signal)) return;
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
    downloadAbort.current?.abort();
    const controller = new AbortController();
    downloadAbort.current = controller;
    setDownload({ kind: 'active', received: 0, total: 1 });
    setStatus(translate('viewer.download.pending'));

    void (async () => {
      try {
        const lease = await createDownloadLease(
          { roomId: openRoomId, documentId: openDocumentId },
          controller.signal,
        );
        // Thrown rather than returned so a cancellation reaches the catch and settles the panel.
        controller.signal.throwIfAborted();
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
          controller.signal.throwIfAborted();
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
        // Superseded by a newer download or another document: that run owns the panel.
        if (downloadAbort.current !== controller) return;
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
        if (downloadAbort.current === controller) downloadAbort.current = null;
      }
    })();
  };

  const entries = structure.kind === 'ready' ? depthFirst(structure.value) : [];

  const depthOf = entryDepth(entries);

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
      : collectionEntries(entries, depthOf);

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
      pageTitle={
        openRoomId === null
          ? 'viewer.rooms.title'
          : openDocumentId !== null
            ? 'page.document'
            : 'page.room'
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
      {sessionEnded ? (
        <Notice tone="problem" role="alert">
          {translate('viewer.expired')}
        </Notice>
      ) : openRoomId === null ? (
        <>
          {roomLost ? (
            <Notice tone="problem" role="alert">
              {translate('viewer.revoked')}
            </Notice>
          ) : null}
          {rooms.kind === 'loading' ? (
            <p className="df-field__help">{translate('viewer.rooms.loading')}</p>
          ) : rooms.kind === 'failed' ? (
            <Notice tone="problem" role="alert">
              {rooms.failure}
            </Notice>
          ) : rooms.value.length === 0 ? (
            <div className="df-empty">
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
          )}
        </>
      ) : openDocumentId === null ? (
        structure.kind === 'loading' ? (
          <p className="df-field__help">{translate('viewer.structure.loading')}</p>
        ) : structure.kind === 'failed' ? (
          <Notice tone="problem" role="alert">
            {structure.failure}
          </Notice>
        ) : entries.length === 0 ? (
          <div className="df-empty">
            <span className="df-empty__lead">{translate('viewer.index.empty')}</span>
            {translate('viewer.index.emptyHelp')}
          </div>
        ) : (
          <>
            {documentWithdrawn ? (
              <Notice
                tone="caution"
                role="status"
                title={translate('viewer.document.unavailable')}
              >
                {translate('viewer.document.unavailableHelp')}
              </Notice>
            ) : null}
            <RoomContents
              entries={entries}
              depthOf={depthOf}
              onOpenDocument={openDocumentById}
            />
          </>
        )
      ) : document.kind === 'loading' ? (
        <p className="df-field__help">{translate('viewer.document.loading')}</p>
      ) : document.kind === 'failed' ? (
        <Notice tone="problem" role="alert">
          {document.failure}
        </Notice>
      ) : openDocument === null ? (
        <div className="df-empty">
          <span className="df-empty__lead">{translate('viewer.document.unavailable')}</span>
          {translate('viewer.document.unavailableHelp')}
        </div>
      ) : (
        <>
          <DocumentPages
            reader={reader}
            roomId={openRoomId}
            documentId={openDocumentId}
            pageNumber={pageNumber}
            pageCount={openDocument.pageCount}
            source={pageSource}
            onLinkActivate={openLink}
            onUnauthorized={loseAccess}
          />

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
          linkAbort.current?.abort();
          setInterstitial((current) => (current === null ? null : { ...current, open: false }));
        }}
      />
    </AppShell>
  );
}
