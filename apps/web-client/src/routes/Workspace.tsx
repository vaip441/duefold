/**
 * The signed-in member frame.
 *
 * Two surfaces: the room register, and one room's workspace. Both are driven
 * entirely by what the server discloses. The client makes no access decision — it
 * renders because the server said a session exists, and it offers a publish control
 * only where the server reported `canPublish`, which avoids presenting an action
 * the server would reject rather than acting as a permission itself.
 *
 * Every asynchronous surface has a designed state: loading, empty, offline,
 * unavailable, denied, not-found, stale (concurrent edit), and validation failure.
 * A stale write is reported as a refresh prompt, never silently retried, because
 * silently re-sending would overwrite a colleague's change.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  createUploadIntent,
  finalizeUpload,
  loadRoomWorkspace,
  loadRooms,
  mutateStructure,
  publicationApply,
  publicationDryRun,
  restoreFromTrash,
  searchRoom,
  signOut,
  type ExportRecord,
  type MemberRoom,
  type PublicationImpact,
  type RoomWorkspace,
  type SearchHit,
  type TrashEntry,
  type WorkingEntry,
} from '../api/client.ts';
import { AppShell } from '../components/AppShell.tsx';
import { BrandingPanel } from '../components/BrandingPanel.tsx';
import { ExportsPanel } from '../components/ExportsPanel.tsx';
import { Notice } from '../components/Notice.tsx';
import { ParticipantsPanel } from '../components/ParticipantsPanel.tsx';
import { ProcessingPanel } from '../components/ProcessingPanel.tsx';
import { PublicationDialog } from '../components/PublicationDialog.tsx';
import { RoomRegister } from '../components/RoomRegister.tsx';
import { StructureControls } from '../components/StructureControls.tsx';
import { StructureTable } from '../components/StructureTable.tsx';
import { ThemeSelect, type ThemeChoice } from '../components/ThemeSelect.tsx';
import { TrashView } from '../components/TrashView.tsx';
import { UploadPanel, planParts } from '../components/UploadPanel.tsx';
import { translate, type MessageKey } from '../i18n/translate.ts';
import { presentFailure, type PresentedFailure } from '../workspace/failures.ts';
import type { Load } from '../workspace/state.ts';
import { useParticipantsSection } from '../workspace/useParticipantsSection.ts';
import {
  useBrandingSection,
  useExportsSection,
  useProcessingSection,
} from '../workspace/useRoomSections.ts';
import { transferParts } from '../workspace/upload.ts';

export interface WorkspaceProps {
  /**
   * Always `'member'`. Viewers are served by `ViewerReadingRoom`, so this surface
   * has no viewer branch to keep in sync with it.
   */
  readonly principal: 'member';
  readonly theme: ThemeChoice;
  readonly onThemeChange: (choice: ThemeChoice) => void;
  readonly onSignedOut: () => void;
}

/** Room sections. Each is a landmark-bearing panel, not a separate route. */
const SECTIONS = ['structure', 'participants', 'processing', 'exports', 'branding'] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_LABEL: Readonly<Record<Section, MessageKey>> = {
  structure: 'workspace.tab.structure',
  participants: 'workspace.tab.participants',
  processing: 'workspace.tab.processing',
  exports: 'workspace.tab.exports',
  branding: 'workspace.tab.branding',
};

/** Maps a server failure onto designed copy. Never surfaces server detail. */
function failureMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return translate('structure.rejected');
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
      return translate('error.expired.body');
    case 'rate-limited':
      return translate('otp.paused');
    case 'conflict':
      return translate('error.conflict.body');
    case 'invalid':
      return translate('error.invalid.body');
    case 'unavailable':
      return translate('error.unavailable.body');
    default:
      return translate('error.unavailable.body');
  }
}

export function Workspace({
  principal,
  theme,
  onThemeChange,
  onSignedOut,
}: WorkspaceProps): React.ReactElement {
  const [status, setStatus] = useState('');
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [pendingSignOut, setPendingSignOut] = useState<'this-device' | 'everywhere' | null>(
    null,
  );
  const [rooms, setRooms] = useState<Load<readonly MemberRoom[]>>({ kind: 'loading' });
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<Load<RoomWorkspace>>({ kind: 'loading' });
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
  const [busyTrashId, setBusyTrashId] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [impact, setImpact] = useState<PublicationImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [publishPending, setPublishPending] = useState(false);
  const [publishFailure, setPublishFailure] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly SearchHit[] | null>(null);
  const [searchPending, setSearchPending] = useState(false);

  const [section, setSection] = useState<Section>('structure');
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [bulkProgress, setBulkProgress] = useState<{
    readonly done: number;
    readonly total: number;
  } | null>(null);

  /*
   * Section state lives in its own hook. This route composes sections; it does not
   * own their state machines. `refreshRooms` runs after a successful change because
   * a grant or invitation advances the room revision the next optimistic write
   * depends on.
   */
  const processingSection = useProcessingSection({
    roomId: () => openRoomId,
    onRetried: () => {
      setStatus(translate('processing.retry.pending'));
    },
    // Deleting a failed source announced nothing before; keep that unchanged.
    onSourceDeleted: () => undefined,
  });
  const exportsSection = useExportsSection({
    // Generation announced nothing before; the list refresh is the feedback.
    onGenerated: () => undefined,
    onDownloaded: () => {
      setStatus(translate('exports.download.done'));
    },
  });
  const brandingSection = useBrandingSection({
    onSaved: () => {
      setStatus(translate('branding.saved'));
    },
  });
  const participantsSection = useParticipantsSection({
    onInvited: (email) => {
      setStatus(translate('participants.invite.done', { email }));
      refreshRooms();
    },
    onApplied: () => {
      setStatus(translate('grant.done'));
      refreshRooms();
    },
  });

  const [uploadPending, setUploadPending] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [uploadFailure, setUploadFailure] = useState<PresentedFailure | null>(null);
  const [uploadDone, setUploadDone] = useState(false);
  const uploadAbort = useRef<AbortController | null>(null);

  const refreshRooms = useCallback((signal?: AbortSignal): void => {
    loadRooms(signal).then(
      (value) => {
        setRooms({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRooms({ kind: 'failed', failure: failureMessage(error) });
      },
    );
  }, []);

  const refreshWorkspace = useCallback((roomId: string, signal?: AbortSignal): void => {
    loadRoomWorkspace(roomId, signal).then(
      (value) => {
        setWorkspace({ kind: 'ready', value });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setWorkspace({ kind: 'failed', failure: failureMessage(error) });
      },
    );
  }, []);

  /*
   * Section loaders. Each keeps its own failure so a refusal in one section never
   * blanks another. A failed load enters the `failed` state and NEVER `ready` with
   * an empty value: rendering "nothing is here" beside a refusal tells the
   * operator inaccessible data is absent, which is the substitution that
   * previously hid revocation from viewers.
   */
  useEffect(() => {
    const controller = new AbortController();
    refreshRooms(controller.signal);
    return () => {
      controller.abort();
    };
  }, [refreshRooms]);

  useEffect(() => {
    if (openRoomId === null) return;
    const controller = new AbortController();
    setWorkspace({ kind: 'loading' });
    refreshWorkspace(openRoomId, controller.signal);
    return () => {
      controller.abort();
    };
  }, [openRoomId, refreshWorkspace]);

  useEffect(() => {
    if (section !== 'structure' || selectedEntryId === null) return;
    const target = document.getElementById(`entry-${selectedEntryId}`);
    if (target === null) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
    target.focus();
  }, [section, selectedEntryId]);

  /*
   * Section data is fetched when its section is first shown rather than all at
   * once on room open: a Manager who never opens Exports should not cause an
   * export listing request, and the participants reader is Manager-only, so
   * fetching it eagerly for a Contributor would produce a guaranteed 403.
   */
  useEffect(() => {
    if (openRoomId === null) return;
    const controller = new AbortController();
    if (section === 'participants') {
      participantsSection.beginLoading();
      participantsSection.refresh(openRoomId, controller.signal);
    }
    if (section === 'processing') {
      processingSection.beginLoading();
      processingSection.refresh(openRoomId, controller.signal);
    }
    if (section === 'exports') {
      exportsSection.beginLoading();
      exportsSection.refresh(openRoomId, controller.signal);
    }
    if (section === 'branding') brandingSection.refresh(openRoomId);
    return () => {
      controller.abort();
    };
  }, [
    openRoomId,
    section,
    participantsSection.beginLoading,
    participantsSection.refresh,
    processingSection.beginLoading,
    processingSection.refresh,
    exportsSection.beginLoading,
    exportsSection.refresh,
    brandingSection.refresh,
  ]);

  const requestSignOut = (scope: 'this-device' | 'everywhere'): void => {
    setPendingSignOut(scope);
    setSignOutFailed(false);
    setStatus(translate('shell.signOut.pending'));
    signOut(principal, scope).then(
      () => {
        setPendingSignOut(null);
        setStatus(translate('shell.signedOut'));
        onSignedOut();
      },
      (error: unknown) => {
        setPendingSignOut(null);
        setSignOutFailed(true);
        setStatus(
          error instanceof ApiError && error.failure === 'offline'
            ? translate('app.offline.body')
            : translate('shell.signOut.failed'),
        );
      },
    );
  };

  const openRoom =
    openRoomId === null || rooms.kind !== 'ready'
      ? null
      : (rooms.value.find((room) => room.roomId === openRoomId) ?? null);

  /** Runs a mutation, then refreshes from the server rather than guessing state. */
  const runMutation = (
    body: Readonly<Record<string, unknown>>,
    entryId: string | null,
  ): void => {
    if (openRoomId === null) return;
    setBusyEntryId(entryId);
    setActionFailure(null);
    mutateStructure(body).then(
      () => {
        setBusyEntryId(null);
        setStatus(translate('structure.saving'));
        refreshWorkspace(openRoomId);
        refreshRooms();
      },
      (error: unknown) => {
        setBusyEntryId(null);
        // A rejected revision means a colleague changed the room. The member is
        // told to refresh; the write is never retried behind their back.
        setActionFailure(failureMessage(error));
      },
    );
  };

  const entries = workspace.kind === 'ready' ? workspace.value.entries : [];
  const folders = entries.filter((entry) => entry.resourceKind === 'folder');
  /*
   * Selected DOCUMENTS for the selected-documents export preset. Folders in the
   * selection are ignored rather than silently expanded, because expanding a folder
   * client-side would export documents the member did not choose.
   */
  const selectedDocumentIds = entries
    .filter((entry) => entry.resourceKind === 'document' && selection.includes(entry.entryId))
    .map((entry) => entry.resourceId);

  const beginPublish = (): void => {
    if (openRoomId === null) return;
    setPublishOpen(true);
    setImpact(null);
    setPublishFailure(null);
    setImpactLoading(true);
    publicationDryRun(openRoomId).then(
      (value) => {
        setImpactLoading(false);
        setImpact(value);
      },
      (error: unknown) => {
        setImpactLoading(false);
        setPublishFailure(failureMessage(error));
      },
    );
  };

  const confirmPublish = (confirmation: string): void => {
    if (openRoomId === null || openRoom === null) return;
    setPublishPending(true);
    setPublishFailure(null);
    publicationApply({
      roomId: openRoomId,
      expectedWorkingRevision: openRoom.workingRevision,
      expectedPublishedRevision: openRoom.publishedRevision,
      confirmation,
    }).then(
      () => {
        setPublishPending(false);
        setPublishOpen(false);
        setStatus(translate('publish.done'));
        refreshWorkspace(openRoomId);
        refreshRooms();
      },
      (error: unknown) => {
        setPublishPending(false);
        setPublishFailure(
          error instanceof ApiError && error.failure === 'denied'
            ? translate('publish.freshSignIn')
            : failureMessage(error),
        );
      },
    );
  };

  const restore = (input: {
    readonly entry: TrashEntry;
    readonly displayName: string;
    readonly destinationFolderId: string | null;
  }): void => {
    if (openRoomId === null || workspace.kind !== 'ready') return;
    setBusyTrashId(input.entry.trashId);
    setActionFailure(null);
    const room = openRoom;
    restoreFromTrash({
      trashId: input.entry.trashId,
      destinationFolderId: input.destinationFolderId,
      displayName: input.displayName,
      expectedEntryRevision: input.entry.entryRevision,
      expectedWorkingRevision: room?.workingRevision ?? 0,
    }).then(
      () => {
        setBusyTrashId(null);
        refreshWorkspace(openRoomId);
        refreshRooms();
      },
      (error: unknown) => {
        setBusyTrashId(null);
        setActionFailure(failureMessage(error));
      },
    );
  };

  const runSearch = (): void => {
    if (openRoomId === null || query.trim() === '') return;
    setSearchPending(true);
    setActionFailure(null);
    searchRoom(openRoomId, query.trim()).then(
      (results) => {
        setSearchPending(false);
        setHits(results);
      },
      (error: unknown) => {
        setSearchPending(false);
        setActionFailure(failureMessage(error));
      },
    );
  };

  /* --- Participants and grants ------------------------------------------- */

  /* --- Processing --------------------------------------------------------- */

  /**
   * Downloads an export once and hands the archive to the browser.
   *
   * The object URL is revoked immediately after the click so nothing is retained:
   * 8.3 forbids persisting protected content, and a live object URL is a retained
   * copy. The request itself belongs to the exports hook; only this saving step is
   * the route's, because it touches the document.
   */
  const saveExportArchive = (record: ExportRecord): void => {
    if (openRoomId === null) return;
    void exportsSection.download(record.exportId).then((blob) => {
      if (blob === null) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'duefold-export.zip';
      anchor.click();
      URL.revokeObjectURL(url);
      exportsSection.refresh(openRoomId);
    });
  };

  /* --- Branding ----------------------------------------------------------- */

  /* --- Upload ------------------------------------------------------------- */

  /**
   * Intent, then sequential part transfer, then finalize.
   *
   * A cancelled or failed transfer finalizes NOTHING: the server reaps the
   * abandoned intent rather than assembling a partial object, so an interrupted
   * upload cannot produce a half document.
   */
  const upload = (input: { readonly file: File; readonly title: string }): void => {
    if (openRoomId === null) return;
    const controller = new AbortController();
    uploadAbort.current = controller;
    setUploadPending(true);
    setUploadPercent(0);
    setUploadFailure(null);
    setUploadDone(false);
    const plan = planParts(input.file.size);
    void (async () => {
      try {
        const intent = await createUploadIntent({
          roomId: openRoomId,
          displayTitle: input.title,
          originalFilename: input.file.name,
          declaredMediaType:
            input.file.type === '' ? 'application/octet-stream' : input.file.type,
          declaredSize: input.file.size,
          parts: plan,
        });
        const parts = await transferParts({
          file: input.file,
          intent,
          plan,
          signal: controller.signal,
          onProgress: setUploadPercent,
        });
        await finalizeUpload({
          intentId: intent.intentId,
          uploadId: intent.uploadId,
          parts,
        });
        setUploadPending(false);
        setUploadPercent(null);
        setUploadDone(true);
        setStatus(translate('upload.done'));
        refreshWorkspace(openRoomId);
        if (section === 'processing') processingSection.refresh(openRoomId);
      } catch (error: unknown) {
        setUploadPending(false);
        setUploadPercent(null);
        if (error instanceof DOMException && error.name === 'AbortError') {
          setStatus(translate('upload.cancelled'));
          return;
        }
        setUploadFailure(presentFailure(error));
      }
    })();
  };

  /* --- Bulk actions ------------------------------------------------------- */

  /**
   * Applies staged removal to the whole selection, one entry at a time.
   *
   * Sequential rather than parallel because each write carries the room's working
   * revision, and concurrent writes would race that revision against each other.
   * A failure partway reports how many succeeded instead of implying all did.
   */
  const bulkStageRemoval = (): void => {
    if (openRoomId === null || workspace.kind !== 'ready') return;
    const targets = workspace.value.entries.filter(
      (entry) => selection.includes(entry.entryId) && !entry.stagedRemoved,
    );
    if (targets.length === 0) return;
    setActionFailure(null);
    setBulkProgress({ done: 0, total: targets.length });
    void (async () => {
      let done = 0;
      for (const entry of targets) {
        try {
          // Revisions are re-read per entry: the previous write advanced the room's
          // working revision, so a cached value would be stale by construction.
          const current = await loadRoomWorkspace(openRoomId);
          const fresh = current.entries.find((item) => item.entryId === entry.entryId);
          const rooms = await loadRooms();
          const room = rooms.find((item) => item.roomId === openRoomId);
          if (fresh === undefined || room === undefined) break;
          await mutateStructure({
            action: 'stage-removal',
            roomId: openRoomId,
            entryId: entry.entryId,
            expectedEntryRevision: fresh.revision,
            expectedWorkingRevision: room.workingRevision,
          });
          done += 1;
          setBulkProgress({ done, total: targets.length });
        } catch (error: unknown) {
          setActionFailure(failureMessage(error));
          break;
        }
      }
      setBulkProgress(done === targets.length ? null : { done, total: targets.length });
      setSelection([]);
      refreshWorkspace(openRoomId);
      refreshRooms();
    })();
  };

  const indexEntries =
    openRoomId === null
      ? rooms.kind === 'ready'
        ? rooms.value.map((room) => ({ id: room.roomId, title: room.title, depth: 0 }))
        : []
      : entries.map((entry) => ({
          id: entry.entryId,
          title: entry.displayName,
          depth: entry.depth,
        }));

  return (
    <AppShell
      title={openRoom === null ? translate('rooms.title') : openRoom.title}
      entries={indexEntries}
      currentEntryId={openRoomId === null ? null : selectedEntryId}
      indexEmpty={{
        lead:
          openRoomId === null ? translate('shell.index.empty') : translate('workspace.empty'),
        help:
          openRoomId === null
            ? translate('shell.index.emptyHelp')
            : translate('workspace.emptyHelp'),
      }}
      onSelectEntry={(id) => {
        if (openRoomId === null) {
          if (rooms.kind === 'ready' && rooms.value.some((room) => room.roomId === id)) {
            setOpenRoomId(id);
            setSelectedEntryId(null);
          }
          return;
        }
        setSelectedEntryId(id);
        setSection('structure');
      }}
      status={status}
      primaryAction={
        openRoom === null ? null : openRoom.canPublish ? (
          <button type="button" className="df-button df-button--primary" onClick={beginPublish}>
            {translate('publish.action')}
          </button>
        ) : (
          // A Contributor stages; a Manager publishes. Rather than hiding the
          // concept, the reason is stated so the member is not left guessing.
          <span className="df-field__help">{translate('publish.contributorNote')}</span>
        )
      }
      notes={
        openRoom === null ? undefined : (
          <>
            <p>{translate(`rooms.state.${openRoom.state}.explain`)}</p>
            <p>
              {translate('rooms.notes.access', {
                access:
                  openRoom.roomRole === null
                    ? translate('rooms.access.globalRole')
                    : translate(
                        openRoom.roomRole === 'manager'
                          ? 'rooms.role.manager'
                          : 'rooms.role.contributor',
                      ),
              })}
            </p>
          </>
        )
      }
      contextActions={
        openRoomId === null ? null : (
          <button
            type="button"
            className="df-button df-button--quiet"
            onClick={() => {
              setOpenRoomId(null);
              setSelectedEntryId(null);
              setHits(null);
              setQuery('');
            }}
          >
            {translate('rooms.title')}
          </button>
        )
      }
      accountActions={
        <>
          <ThemeSelect value={theme} onChange={onThemeChange} />
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
      {signOutFailed ? (
        <Notice tone="problem" role="alert">
          {translate('shell.signOut.failed')}
        </Notice>
      ) : null}

      {openRoomId === null ? (
        rooms.kind === 'loading' ? (
          <p className="df-field__help">{translate('rooms.loading')}</p>
        ) : rooms.kind === 'failed' ? (
          <>
            <Notice tone="problem" role="alert">
              {rooms.failure}
            </Notice>
            <button
              type="button"
              className="df-button"
              onClick={() => {
                setRooms({ kind: 'loading' });
                refreshRooms();
              }}
            >
              {translate('app.retry')}
            </button>
          </>
        ) : (
          <RoomRegister
            rooms={rooms.value}
            onOpen={(id) => {
              setOpenRoomId(id);
              setSelectedEntryId(null);
            }}
          />
        )
      ) : workspace.kind === 'loading' ? (
        <p className="df-field__help">{translate('workspace.loading')}</p>
      ) : workspace.kind === 'failed' ? (
        <>
          <Notice tone="problem" role="alert">
            {workspace.failure}
          </Notice>
          <button
            type="button"
            className="df-button"
            onClick={() => {
              setWorkspace({ kind: 'loading' });
              refreshWorkspace(openRoomId);
            }}
          >
            {translate('app.retry')}
          </button>
        </>
      ) : (
        <>
          {actionFailure === null ? null : (
            <Notice tone="problem" role="alert">
              {actionFailure}{' '}
              <button
                type="button"
                className="df-button df-button--quiet"
                onClick={() => {
                  setActionFailure(null);
                  refreshWorkspace(openRoomId);
                  refreshRooms();
                }}
              >
                {translate('structure.refresh')}
              </button>
            </Notice>
          )}

          <nav className="df-sections" aria-label={translate('workspace.tabs.label')}>
            {/*
             * Sections are links-as-buttons in a nav, not an ARIA tablist: a
             * tablist would promise arrow-key semantics that add nothing here, and
             * `aria-current` already states which section is showing.
             */}
            {SECTIONS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                className="df-sections__entry"
                aria-current={candidate === section ? 'true' : undefined}
                onClick={() => {
                  setSection(candidate);
                }}
              >
                {translate(SECTION_LABEL[candidate])}
              </button>
            ))}
          </nav>

          {section === 'structure' ? (
            <>
              <section aria-label={translate('workspace.section.search')}>
                <div className="df-field df-field--inline">
                  <label className="df-field__label" htmlFor="df-room-search">
                    {translate('search.label')}
                  </label>
                  <input
                    id="df-room-search"
                    className="df-field__input"
                    type="search"
                    value={query}
                    placeholder={translate('search.placeholder')}
                    onChange={(event) => {
                      setQuery(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') runSearch();
                    }}
                  />
                  <button
                    type="button"
                    className="df-button"
                    disabled={searchPending || query.trim() === ''}
                    onClick={runSearch}
                  >
                    {searchPending ? translate('search.pending') : translate('search.submit')}
                  </button>
                </div>
                <p className="df-field__help">{translate('search.scope')}</p>
                {hits === null ? null : hits.length === 0 ? (
                  <p className="df-field__help">{translate('search.empty')}</p>
                ) : (
                  <ul className="df-results">
                    {hits.map((hit) => (
                      <li key={`${hit.resourceKind}:${hit.resourceId}`}>
                        <span className="df-results__name">{hit.displayName}</span>
                        <span className="df-register__meta">{hit.path}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-label={translate('workspace.section.structure')}>
                <h2 className="df-section__heading">
                  {translate('workspace.section.structure')}
                </h2>
                <StructureControls
                  entries={entries}
                  folders={folders}
                  pending={busyEntryId !== null || bulkProgress !== null}
                  selection={selection}
                  bulkProgress={bulkProgress}
                  onCreateFolder={(input) => {
                    runMutation(
                      {
                        action: 'create-folder',
                        roomId: openRoomId,
                        ...(input.parentFolderId === null
                          ? {}
                          : { parentFolderId: input.parentFolderId }),
                        displayName: input.displayName,
                        description: input.description,
                        expectedWorkingRevision: openRoom?.workingRevision ?? 0,
                      },
                      null,
                    );
                  }}
                  onSelectionChange={setSelection}
                  onBulkStageRemoval={bulkStageRemoval}
                />
                <StructureTable
                  entries={entries}
                  busyEntryId={busyEntryId}
                  selection={selection}
                  onSelectionChange={setSelection}
                  folders={folders}
                  onRename={(entry: WorkingEntry, displayName: string) => {
                    runMutation(
                      {
                        action: 'rename',
                        roomId: openRoomId,
                        entryId: entry.entryId,
                        displayName,
                        expectedEntryRevision: entry.revision,
                        expectedWorkingRevision: openRoom?.workingRevision ?? 0,
                      },
                      entry.entryId,
                    );
                  }}
                  onReorder={(entry: WorkingEntry, targetPosition: number) => {
                    runMutation(
                      {
                        action: 'reorder',
                        roomId: openRoomId,
                        entryId: entry.entryId,
                        targetPosition,
                        expectedEntryRevision: entry.revision,
                        expectedWorkingRevision: openRoom?.workingRevision ?? 0,
                      },
                      entry.entryId,
                    );
                  }}
                  onStageRemoval={(entry: WorkingEntry) => {
                    runMutation(
                      {
                        action: 'stage-removal',
                        roomId: openRoomId,
                        entryId: entry.entryId,
                        expectedEntryRevision: entry.revision,
                        expectedWorkingRevision: openRoom?.workingRevision ?? 0,
                      },
                      entry.entryId,
                    );
                  }}
                  onMove={(input) => {
                    runMutation(
                      {
                        action: 'move',
                        roomId: openRoomId,
                        entryId: input.entry.entryId,
                        destinationFolderId: input.destinationFolderId,
                        targetPosition: input.targetPosition,
                        expectedEntryRevision: input.entry.revision,
                        expectedWorkingRevision: openRoom?.workingRevision ?? 0,
                      },
                      input.entry.entryId,
                    );
                  }}
                  onMetadata={(input) => {
                    runMutation(
                      {
                        action: 'document-metadata',
                        roomId: openRoomId,
                        documentId: input.entry.resourceId,
                        title: input.title,
                        description: input.description,
                        expectedDocumentRevision: input.entry.revision,
                        expectedWorkingRevision: openRoom?.workingRevision ?? 0,
                      },
                      input.entry.entryId,
                    );
                  }}
                />
              </section>

              <UploadPanel
                pending={uploadPending}
                progressPercent={uploadPercent}
                failure={uploadFailure}
                done={uploadDone}
                onUpload={upload}
                onCancel={() => {
                  uploadAbort.current?.abort();
                }}
                onReload={() => {
                  refreshWorkspace(openRoomId);
                }}
              />

              <TrashView
                trash={workspace.value.trash}
                retentionDays={workspace.value.retentionDays}
                folders={folders}
                busyTrashId={busyTrashId}
                onRestore={restore}
              />
            </>
          ) : null}

          {section === 'participants' ? (
            <ParticipantsPanel
              participants={
                participantsSection.participants.kind === 'ready'
                  ? participantsSection.participants.value
                  : []
              }
              entries={entries}
              loading={participantsSection.participants.kind === 'loading'}
              denied={participantsSection.participants.kind === 'failed'}
              failure={participantsSection.failure}
              inviteFailure={participantsSection.inviteFailure}
              invitePending={participantsSection.invitePending}
              impact={participantsSection.impact}
              impactLoading={participantsSection.impactPending}
              applyPending={participantsSection.applyPending}
              changeFailure={participantsSection.changeFailure}
              onInvite={(email) => {
                if (openRoom === null) return;
                participantsSection.invite({
                  roomId: openRoomId,
                  email,
                  expectedRoomRevision: openRoom.revision,
                });
              }}
              onReview={(submission) => {
                participantsSection.review(openRoomId, submission);
              }}
              onApply={(confirmation) => {
                if (openRoom === null) return;
                participantsSection.apply({
                  roomId: openRoomId,
                  expectedRoomRevision: openRoom.revision,
                  confirmation,
                });
              }}
              onCancelChange={participantsSection.cancelChange}
              onReload={() => {
                participantsSection.beginLoading();
                participantsSection.refresh(openRoomId);
                refreshRooms();
              }}
            />
          ) : null}

          {section === 'processing' ? (
            <ProcessingPanel
              versions={
                processingSection.versions.kind === 'ready'
                  ? processingSection.versions.value
                  : []
              }
              loading={processingSection.versions.kind === 'loading'}
              denied={processingSection.versions.kind === 'failed'}
              failure={processingSection.failure}
              busyVersionId={processingSection.busyVersionId}
              onRetry={processingSection.retry}
              onDeleteSource={processingSection.deleteSource}
              onRefresh={() => {
                processingSection.refresh(openRoomId);
              }}
              onReload={() => {
                processingSection.beginLoading();
                processingSection.refresh(openRoomId);
              }}
            />
          ) : null}

          {section === 'exports' ? (
            <ExportsPanel
              exports={
                exportsSection.exports.kind === 'ready' ? exportsSection.exports.value : []
              }
              loading={exportsSection.exports.kind === 'loading'}
              denied={exportsSection.exports.kind === 'failed'}
              failure={exportsSection.failure}
              preflight={exportsSection.preflight}
              preflightLoading={exportsSection.preflightPending}
              generatePending={exportsSection.generatePending}
              downloadingId={exportsSection.downloadingId}
              selectedDocumentIds={selectedDocumentIds}
              onPreflight={(input) => {
                exportsSection.review({ roomId: openRoomId, ...input, selectedDocumentIds });
              }}
              onGenerate={() => {
                exportsSection.generate(openRoomId);
              }}
              onCancelPreflight={exportsSection.cancelReview}
              onDownload={saveExportArchive}
              onReload={() => {
                exportsSection.beginLoading();
                exportsSection.refresh(openRoomId);
              }}
            />
          ) : null}

          {section === 'branding' ? (
            <BrandingPanel
              roomId={openRoomId}
              configuration={brandingSection.configuration}
              loading={brandingSection.loading}
              denied={brandingSection.denied}
              failure={brandingSection.failure}
              savePending={brandingSection.saving}
              onSave={(input) => {
                brandingSection.save({ roomId: openRoomId, ...input });
              }}
              onUploadAsset={async (kind, file) => {
                await brandingSection.uploadAsset(kind, file);
                brandingSection.refresh(openRoomId);
              }}
              onDeleteAsset={async (kind) => {
                await brandingSection.deleteAsset(openRoomId, kind);
                brandingSection.refresh(openRoomId);
              }}
              onReload={() => {
                brandingSection.refresh(openRoomId);
              }}
            />
          ) : null}
        </>
      )}

      {publishOpen ? (
        <PublicationDialog
          impact={impact}
          loading={impactLoading}
          pending={publishPending}
          failure={publishFailure}
          onConfirm={confirmPublish}
          onCancel={() => {
            setPublishOpen(false);
          }}
        />
      ) : null}
    </AppShell>
  );
}
