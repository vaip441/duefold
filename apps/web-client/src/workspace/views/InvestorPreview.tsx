/**
 * The investor preview: a Room Manager reads the room's published content in the
 * reading-room layout to confirm every file renders before investors arrive.
 *
 * It is not the viewer's surface. Pages are the stored derivatives without the
 * investor watermark, opening a document is audited as the Manager rather than
 * recorded as investor activity, and download and link actions are absent. The
 * worktable states the first and last on every screen and the notes margin states the
 * second, so the difference is never mistaken for what an investor sees.
 *
 * Like the reading room, it renders only what the server returned: the preview routes
 * apply the viewer's publication rules, so nothing here filters content for itself.
 */

import { useCallback, useEffect, useId, useState } from 'react';
import { isAborted } from '../../api/abort.ts';
import {
  ApiError,
  loadPreviewDocument,
  loadPreviewRoom,
  type PreviewRoom,
} from '../../api/client.ts';
import { AppShell } from '../../components/AppShell.tsx';
import { DocumentPager } from '../../components/DocumentPager.tsx';
import { FindBar } from '../../components/FindBar.tsx';
import { Notice } from '../../components/Notice.tsx';
import { PageReader } from '../../components/PageReader.tsx';
import { RoomContents } from '../../components/RoomContents.tsx';
import { ThemeSelect, type ThemeChoice } from '../../components/ThemeSelect.tsx';
import { translate } from '../../i18n/translate.ts';
import type { MemberLocation, Navigate } from '../../navigation.ts';
import { memberPreviewPageSource } from '../../viewer/page-source.ts';
import { entryDepth } from '../../viewer/structure-depth.ts';
import { useDocumentReader } from '../../viewer/useDocumentReader.ts';
import { failureMessage } from '../failure-message.ts';
import type { Load } from '../state.ts';

type PreviewLocation = Extract<MemberLocation, { kind: 'preview' }>;

export interface InvestorPreviewProps {
  readonly location: PreviewLocation;
  readonly onNavigate: Navigate<MemberLocation>;
  readonly onExit: () => void;
  readonly theme: ThemeChoice;
  readonly onThemeChange: (choice: ThemeChoice) => void;
}

/* A refusal means the Manager lost the room mid-preview, which gets its own sentence. */
function previewFailure(error: unknown): string {
  return error instanceof ApiError && error.failure === 'denied'
    ? translate('preview.denied')
    : failureMessage(error);
}

export function InvestorPreview({
  location,
  onNavigate,
  onExit,
  theme,
  onThemeChange,
}: InvestorPreviewProps): React.ReactElement {
  const { roomId, documentId, page } = location;
  const [status, setStatus] = useState('');
  const [room, setRoom] = useState<Load<PreviewRoom>>({ kind: 'loading' });
  const [denied, setDenied] = useState(false);
  const downloadHeadingId = useId();
  const replacePage = useCallback(
    (next: number) => {
      onNavigate({ ...location, page: next }, 'replace');
    },
    [location, onNavigate],
  );
  const reader = useDocumentReader({
    documentId,
    page,
    onPage: replacePage,
    onStatus: setStatus,
  });
  const { document, openDocument, receiveDocument } = reader;

  useEffect(() => {
    const controller = new AbortController();
    setRoom({ kind: 'loading' });
    loadPreviewRoom(roomId, controller.signal).then(
      (value) => {
        setRoom({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (isAborted(controller.signal)) return;
        setRoom({ kind: 'failed', failure: previewFailure(error) });
      },
    );
    return () => {
      controller.abort();
    };
  }, [roomId]);

  /* Each open is one audited read, so metadata is requested once per document. */
  useEffect(() => {
    if (documentId === null) return;
    const controller = new AbortController();
    loadPreviewDocument({ roomId, documentId }, controller.signal).then(
      (value) => {
        receiveDocument({ documentId, load: { kind: 'ready', value } });
      },
      (error: unknown) => {
        if (isAborted(controller.signal)) return;
        receiveDocument({
          documentId,
          load: { kind: 'failed', failure: previewFailure(error) },
        });
      },
    );
    return () => {
      controller.abort();
    };
  }, [roomId, documentId, receiveDocument]);

  const entries = room.kind === 'ready' ? room.value.entries : [];
  const depthOf = entryDepth(entries);

  const openDocumentById = (id: string): void => {
    onNavigate({ kind: 'preview', roomId, documentId: id, page: 1 });
  };
  const closeDocument = (): void => {
    onNavigate({ kind: 'preview', roomId, documentId: null, page: 1 });
  };

  const title =
    openDocument?.displayTitle ??
    (room.kind === 'ready' ? room.value.title : translate('preview.title'));

  return (
    <AppShell
      title={title}
      pageTitle="preview.title"
      entries={entries.map((entry) => ({
        id: entry.entryId,
        title: entry.displayName,
        depth: depthOf(entry),
        kind: entry.resourceKind === 'folder' ? ('group' as const) : ('item' as const),
      }))}
      currentEntryId={
        documentId === null
          ? null
          : (entries.find((entry) => entry.resourceId === documentId)?.entryId ?? null)
      }
      indexEmpty={
        room.kind === 'ready'
          ? { lead: translate('preview.empty'), help: translate('preview.emptyHelp') }
          : null
      }
      onSelectEntry={(id) => {
        const entry = entries.find((item) => item.entryId === id);
        if (entry?.resourceKind === 'document') openDocumentById(entry.resourceId);
      }}
      status={status}
      notes={
        <>
          <p>{translate('preview.audit')}</p>
          {room.kind === 'ready' && room.value.state !== 'published' ? (
            <p>{translate('preview.notVisible')}</p>
          ) : null}
        </>
      }
      contextActions={
        <>
          {documentId !== null ? (
            <button
              type="button"
              className="df-button df-button--quiet"
              onClick={closeDocument}
            >
              {translate('viewer.index.heading')}
            </button>
          ) : null}
          <button type="button" className="df-button" onClick={onExit}>
            {translate('preview.exit')}
          </button>
        </>
      }
      accountActions={<ThemeSelect value={theme} onChange={onThemeChange} />}
    >
      <Notice tone="caution" title={translate('preview.title')}>
        {translate('preview.banner')}
      </Notice>
      {denied ? (
        <Notice tone="problem" role="alert">
          {translate('preview.denied')}
        </Notice>
      ) : room.kind === 'loading' ? (
        <p className="df-field__help">{translate('viewer.structure.loading')}</p>
      ) : room.kind === 'failed' ? (
        <Notice tone="problem" role="alert">
          {room.failure}
        </Notice>
      ) : documentId === null ? (
        entries.length === 0 ? (
          <div className="df-empty">
            <span className="df-empty__lead">{translate('preview.empty')}</span>
            {translate('preview.emptyHelp')}
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
        <div className="df-empty">
          <span className="df-empty__lead">{translate('preview.document.unavailable')}</span>
          {translate('preview.document.unavailableHelp')}
        </div>
      ) : (
        <>
          <FindBar {...reader.findBar} />
          <DocumentPager
            pageNumber={page}
            pageCount={openDocument.pageCount}
            zoom={reader.zoom}
            onPage={reader.goToPage}
            onZoom={reader.setZoom}
          />
          <div className="df-page-zoom" data-zoom={reader.zoom}>
            <PageReader
              roomId={roomId}
              documentId={documentId}
              pageNumber={page}
              totalPages={openDocument.pageCount}
              source={memberPreviewPageSource}
              matches={reader.matches}
              currentMatch={reader.currentMatch}
              onTextLayer={reader.onTextLayer}
              onLinkActivate={() => undefined}
              onUnauthorized={() => {
                setDenied(true);
              }}
            />
          </div>
          {/* Where the reader offers the download, the preview states the policy only. */}
          <section className="df-download" aria-labelledby={downloadHeadingId}>
            <h2 className="df-section__heading" id={downloadHeadingId}>
              {translate('viewer.download.heading')}
            </h2>
            <p className="df-field__help">
              {translate(
                openDocument.downloadPolicy === 'allow'
                  ? 'preview.download.allowed'
                  : 'preview.download.denied',
              )}
            </p>
          </section>
        </>
      )}
    </AppShell>
  );
}
