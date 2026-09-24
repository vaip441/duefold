/**
 * One room's workspace: collection, access, processing, exports, and whatever
 * sections composed modules contribute.
 *
 * Moved out of `Workspace.tsx`, which held the register, the room, and every
 * section's state in one file. Behaviour is unchanged: the same loaders, the same
 * failure handling, the same optimistic-concurrency discipline.
 *
 * Every asynchronous surface keeps its designed state — loading, empty, offline,
 * unavailable, denied, not-found, stale, and validation failure. A stale write is
 * reported as a refresh prompt and NEVER silently retried, because re-sending
 * would overwrite a colleague's change.
 *
 * Section tabs are composed, not literal. A room section belonging to an omitted
 * module contributes nothing, so its tab and panel cannot reach the bundle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createUploadIntent,
  finalizeUpload,
  loadRoomWorkspace,
  mutateStructure,
  restoreFromTrash,
  searchRoom,
  type ExportRecord,
  type MemberRoom,
  type RoomWorkspace,
  type SearchHit,
  type TrashEntry,
  type WorkingEntry,
} from '../../api/client.ts';
import { ExportsPanel } from '../../components/ExportsPanel.tsx';
import { Notice } from '../../components/Notice.tsx';
import { ProcessingPanel } from '../../components/ProcessingPanel.tsx';
import { RoomPreparationNav } from '../../components/RoomPreparationNav.tsx';
import { RoomSettingsPanel } from '../../components/RoomSettingsPanel.tsx';
import { SectionNav } from '../../components/SectionNav.tsx';
import { StructureControls } from '../../components/StructureControls.tsx';
import { StructureTable } from '../../components/StructureTable.tsx';
import { TrashView } from '../../components/TrashView.tsx';
import {
  UploadPanel,
  planParts,
  type UploadItem,
  type UploadItemState,
} from '../../components/UploadPanel.tsx';
import type { SectionTab } from '../../contract.ts';
import { translate } from '../../i18n/translate.ts';
import { presentFailure, type PresentedFailure } from '../failures.ts';
import {
  composeSections,
  contributedSections,
  currentSection,
  isContributed,
} from '../sections.ts';
import type { Load } from '../state.ts';
import { useParticipantsSection } from '../useParticipantsSection.ts';
import { useExportsSection, useProcessingSection } from '../useRoomSections.ts';
import { useRoomSettings } from '../useRoomSettings.ts';
import { checksumPartPlan, transferParts } from '../upload.ts';
import { failureMessage } from '../failure-message.ts';
import { AccessSection } from './AccessSection.tsx';

export interface RoomViewProps {
  readonly roomId: string;
  /** The register's row for this room, or null while the register reloads. */
  readonly room: MemberRoom | null;
  readonly selectedEntryId: string | null;
  readonly sectionId: string;
  /**
   * Bumped by the frame after an action it owns changed this room — publication is
   * the only one today, because the publish control lives in the shell's banner. A
   * counter rather than a callback registration: the frame cannot hold a handle to
   * a child's loader without reaching inside it.
   */
  readonly reloadToken: number;
  readonly onSectionChange: (sectionId: string) => void;
  readonly onStatus: (message: string) => void;
  /** Refreshes the register, because a grant or publication moves its revisions. */
  readonly onRoomsChanged: () => void;
  /**
   * Reports this room's working entries, so the shell's collection index lists them
   * while a room is open. The index belongs to the frame; its CONTENT belongs to
   * whichever view knows it.
   */
  readonly onEntriesChange: (entries: readonly WorkingEntry[]) => void;
  /** Opens the frame's publication dialog, which owns the dry run. */
  readonly onPublish: () => void;
}

const CORE_ROOM_TABS = [
  {
    id: 'structure',
    scope: 'room',
    label: () => translate('workspace.tab.structure'),
    order: 10,
  },
  {
    id: 'upload',
    scope: 'room',
    label: () => translate('workspace.tab.upload'),
    order: 20,
  },
  {
    id: 'participants',
    scope: 'room',
    label: () => translate('workspace.tab.participants'),
    order: 30,
  },
  {
    id: 'processing',
    scope: 'room',
    label: () => translate('workspace.tab.processing'),
    order: 40,
  },
  {
    id: 'exports',
    scope: 'room',
    label: () => translate('workspace.tab.exports'),
    order: 50,
  },
] as const satisfies readonly SectionTab[];

const SETTINGS_TAB = {
  id: 'settings',
  scope: 'room',
  label: () => translate('workspace.tab.settings'),
  order: 60,
} as const satisfies SectionTab;

/* Reached through the preparation path rather than the supporting strip. */
const PATH_SECTIONS: readonly string[] = ['structure', 'upload', 'participants', 'processing'];
/* Reader management and exports are Room Manager work; the server refuses anyone else,
   so a Contributor is not handed a section whose only content would be that refusal. */
const MANAGER_SECTIONS: readonly string[] = ['participants', 'exports'];

export function RoomView({
  roomId,
  room,
  selectedEntryId,
  sectionId,
  reloadToken,
  onSectionChange,
  onStatus,
  onRoomsChanged,
  onEntriesChange,
  onPublish,
}: RoomViewProps): React.ReactElement {
  const [workspace, setWorkspace] = useState<Load<RoomWorkspace>>({ kind: 'loading' });
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [busyEntryId, setBusyEntryId] = useState<string | null>(null);
  const [busyTrashId, setBusyTrashId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly SearchHit[] | null>(null);
  const [searchPending, setSearchPending] = useState(false);
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [bulkProgress, setBulkProgress] = useState<{
    readonly done: number;
    readonly total: number;
  } | null>(null);
  const [uploadPending, setUploadPending] = useState(false);
  const [uploadStates, setUploadStates] = useState<ReadonlyMap<string, UploadItemState>>(
    new Map(),
  );
  const [uploadFailure, setUploadFailure] = useState<PresentedFailure | null>(null);
  const [uploadDoneCount, setUploadDoneCount] = useState(0);
  const uploadAbort = useRef<AbortController | null>(null);

  /*
   * Section state lives in its own hook. This view composes sections; it does not
   * own their state machines. The register is refreshed after a successful change
   * because a grant or invitation advances the room revision the next optimistic
   * write depends on.
   */
  const processingSection = useProcessingSection({
    roomId: () => roomId,
    onRetried: () => {
      onStatus(translate('processing.retry.pending'));
    },
    // Deleting a failed source announced nothing before; keep that unchanged.
    onSourceDeleted: () => undefined,
  });
  const exportsSection = useExportsSection({
    // Generation announced nothing before; the list refresh is the feedback.
    onGenerated: () => undefined,
    onDownloaded: () => {
      onStatus(translate('exports.download.done'));
    },
  });
  const participantsSection = useParticipantsSection({
    onInvited: (email) => {
      onStatus(translate('participants.invite.done', { email }));
      onRoomsChanged();
    },
    onApplied: () => {
      onStatus(translate('grant.done'));
      onRoomsChanged();
    },
    onRosterChanged: onRoomsChanged,
  });

  /* Offered on Room Manager authority, the register row's `canPublish`. The reader
     refuses anyone else independently. */
  const settings = useRoomSettings(room?.canPublish === true ? roomId : null, onRoomsChanged);

  const refreshWorkspace = useCallback(
    (signal?: AbortSignal): void => {
      loadRoomWorkspace(roomId, signal).then(
        (value) => {
          setWorkspace({ kind: 'ready', value });
        },
        (error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setWorkspace({ kind: 'failed', failure: failureMessage(error) });
        },
      );
    },
    [roomId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setWorkspace({ kind: 'loading' });
    refreshWorkspace(controller.signal);
    return () => {
      controller.abort();
    };
  }, [refreshWorkspace, reloadToken]);

  /*
   * Core room tabs, composed with whatever modules contributed.
   *
   * Core tabs carry no `render`: they are rendered from this view's own state
   * below. A contribution carries one, because it cannot reach that state and
   * `SectionProps` stays narrow deliberately — widening it so core could be
   * expressed the same way would make every module's section depend on this view's
   * internals.
   */
  const canManage = room?.canPublish === true;
  const sections = composeSections(
    [
      ...CORE_ROOM_TABS.filter((tab) => canManage || !MANAGER_SECTIONS.includes(tab.id)),
      ...(settings === null ? [] : [SETTINGS_TAB]),
    ],
    contributedSections('room'),
  );
  const section = currentSection(sections, sectionId);
  const currentId = section?.id ?? '';
  const supportingSections = sections.filter((tab) => !PATH_SECTIONS.includes(tab.id));

  useEffect(() => {
    if (currentId !== 'structure' || selectedEntryId === null) return;
    const target = document.getElementById(`entry-${selectedEntryId}`);
    if (target === null) return;
    target.scrollIntoView({ behavior: 'auto', block: 'nearest' });
    target.focus();
  }, [currentId, selectedEntryId]);

  /*
   * Section data is fetched when its section is first shown rather than all at
   * once on room open: a Manager who never opens Exports should not cause an
   * export listing request, and the participants reader is Manager-only, so
   * fetching it eagerly for a Contributor would produce a guaranteed 403.
   */
  useEffect(() => {
    const controller = new AbortController();
    if (currentId === 'participants') {
      participantsSection.beginLoading();
      participantsSection.refresh(roomId, controller.signal);
    }
    if (currentId === 'processing') {
      processingSection.beginLoading();
      void processingSection.refresh(roomId, controller.signal).then(
        () => {
          refreshWorkspace();
          onRoomsChanged();
        },
        () => undefined,
      );
    }
    if (currentId === 'exports') {
      exportsSection.beginLoading();
      exportsSection.refresh(roomId, controller.signal);
    }
    return () => {
      controller.abort();
    };
  }, [
    roomId,
    currentId,
    participantsSection.beginLoading,
    participantsSection.refresh,
    processingSection.beginLoading,
    processingSection.refresh,
    exportsSection.beginLoading,
    exportsSection.refresh,
  ]);

  /** Runs a mutation, then refreshes from the server rather than guessing state. */
  const runMutation = (
    body: Readonly<Record<string, unknown>>,
    entryId: string | null,
  ): void => {
    setBusyEntryId(entryId);
    setActionFailure(null);
    mutateStructure(body).then(
      () => {
        setBusyEntryId(null);
        onStatus(translate('structure.saving'));
        refreshWorkspace();
        onRoomsChanged();
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
  /* Published to the frame so the shell's collection index lists this room's
     entries. Effect rather than a call in render, because the frame stores it. */
  useEffect(() => {
    onEntriesChange(entries);
  }, [entries, onEntriesChange]);
  /*
   * Selected DOCUMENTS for the selected-documents export preset. Folders in the
   * selection are ignored rather than silently expanded, because expanding a folder
   * client-side would export documents the member did not choose.
   */
  const selectedDocumentIds = entries
    .filter((entry) => entry.resourceKind === 'document' && selection.includes(entry.entryId))
    .map((entry) => entry.resourceId);

  const restore = (input: {
    readonly entry: TrashEntry;
    readonly displayName: string;
    readonly destinationFolderId: string | null;
  }): void => {
    if (workspace.kind !== 'ready') return;
    setBusyTrashId(input.entry.trashId);
    setActionFailure(null);
    restoreFromTrash({
      trashId: input.entry.trashId,
      destinationFolderId: input.destinationFolderId,
      displayName: input.displayName,
      expectedEntryRevision: input.entry.entryRevision,
      expectedWorkingRevision: workspace.value.workingRevision,
    }).then(
      () => {
        setBusyTrashId(null);
        refreshWorkspace();
        onRoomsChanged();
      },
      (error: unknown) => {
        setBusyTrashId(null);
        setActionFailure(failureMessage(error));
      },
    );
  };

  const runSearch = (): void => {
    if (query.trim() === '') return;
    setSearchPending(true);
    setActionFailure(null);
    searchRoom(roomId, query.trim()).then(
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

  /**
   * Downloads an export once and hands the archive to the browser.
   *
   * The object URL is revoked immediately after the click so nothing is retained:
   * §8.3 forbids persisting protected content, and a live object URL is a retained
   * copy. The request itself belongs to the exports hook; only this saving step is
   * the view's, because it touches the document.
   */
  const saveExportArchive = (record: ExportRecord): void => {
    void exportsSection.download(record.exportId).then((blob) => {
      if (blob === null) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'duefold-export.zip';
      anchor.click();
      URL.revokeObjectURL(url);
      exportsSection.refresh(roomId);
    });
  };

  /**
   * Uploads a reviewed queue sequentially. Each file keeps its own result, so one
   * rejected source cannot make already-quarantined files look absent or turn a
   * partial batch into a false all-or-nothing success.
   */
  const upload = (items: readonly UploadItem[]): void => {
    const controller = new AbortController();
    uploadAbort.current = controller;
    setUploadPending(true);
    setUploadFailure(null);
    setUploadDoneCount(0);
    setUploadStates(new Map(items.map((item) => [item.id, { kind: 'waiting' } as const])));

    void (async () => {
      let completed = 0;
      for (const item of items) {
        if (controller.signal.aborted) break;
        const plan = planParts(item.file.size);
        setUploadStates((current) =>
          new Map(current).set(item.id, { kind: 'active', percent: 0 }),
        );
        try {
          const checksummedPlan = await checksumPartPlan({
            file: item.file,
            plan,
            signal: controller.signal,
          });
          const intent = await createUploadIntent({
            roomId,
            displayTitle: item.title,
            originalFilename: item.file.name,
            declaredMediaType:
              item.file.type === '' ? 'application/octet-stream' : item.file.type,
            declaredSize: item.file.size,
            parts: checksummedPlan,
          });
          const parts = await transferParts({
            file: item.file,
            intent,
            plan: checksummedPlan,
            signal: controller.signal,
            onProgress: (percent) => {
              setUploadStates((current) =>
                new Map(current).set(item.id, { kind: 'active', percent }),
              );
            },
          });
          await finalizeUpload({ intentId: intent.intentId, uploadId: intent.uploadId, parts });
          completed += 1;
          setUploadDoneCount(completed);
          setUploadStates((current) => new Map(current).set(item.id, { kind: 'done' }));
        } catch (error: unknown) {
          if (error instanceof DOMException && error.name === 'AbortError') break;
          const presented = presentFailure(error);
          setUploadStates((current) =>
            new Map(current).set(item.id, { kind: 'failed', message: presented.body }),
          );
        }
      }

      setUploadPending(false);
      uploadAbort.current = null;
      if (controller.signal.aborted) {
        setUploadStates((current) => {
          const next = new Map(current);
          for (const item of items) {
            const state = next.get(item.id);
            if (state?.kind === 'waiting' || state?.kind === 'active')
              next.set(item.id, { kind: 'cancelled' });
          }
          return next;
        });
        onStatus(translate('upload.cancelled'));
        return;
      }
      onStatus(translate('upload.batchDone', { count: completed, total: items.length }));
      refreshWorkspace();
      if (completed > 0) onRoomsChanged();
      if (currentId === 'processing') {
        void processingSection.refresh(roomId).then(
          () => {
            refreshWorkspace();
            onRoomsChanged();
          },
          () => undefined,
        );
      }
    })();
  };

  /**
   * Applies staged removal to the whole selection, one entry at a time.
   *
   * Sequential rather than parallel because each write carries the room's working
   * revision, and concurrent writes would race that revision against each other.
   * A failure partway reports how many succeeded instead of implying all did.
   */
  const bulkStageRemoval = (): void => {
    if (workspace.kind !== 'ready') return;
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
          /*
           * The ENTRY revision is re-read per iteration, because the previous write
           * advanced it and a cached value would be stale by construction.
           *
           * The room's working revision comes from the register the frame already holds.
           * Re-reading it here would mean walking the paged register once per entry, and
           * a stale one is self-correcting: the server refuses the write with a conflict,
           * which the loop reports rather than retrying.
           */
          const current = await loadRoomWorkspace(roomId);
          const fresh = current.entries.find((item) => item.entryId === entry.entryId);
          if (fresh === undefined) break;
          await mutateStructure({
            action: 'stage-removal',
            roomId,
            entryId: entry.entryId,
            expectedEntryRevision: fresh.revision,
            expectedWorkingRevision: current.workingRevision,
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
      refreshWorkspace();
      onRoomsChanged();
    })();
  };

  if (workspace.kind === 'loading')
    return <p className="df-field__help">{translate('workspace.loading')}</p>;

  if (workspace.kind === 'failed')
    return (
      <>
        <Notice tone="problem" role="alert">
          {workspace.failure}
        </Notice>
        <button
          type="button"
          className="df-button"
          onClick={() => {
            setWorkspace({ kind: 'loading' });
            refreshWorkspace();
          }}
        >
          {translate('app.retry')}
        </button>
      </>
    );

  return (
    <>
      {actionFailure === null ? null : (
        <Notice tone="problem" role="alert">
          {actionFailure}{' '}
          <button
            type="button"
            className="df-button df-button--quiet"
            onClick={() => {
              setActionFailure(null);
              refreshWorkspace();
              onRoomsChanged();
            }}
          >
            {translate('structure.refresh')}
          </button>
        </Notice>
      )}

      <RoomPreparationNav
        canManage={canManage}
        sectionId={currentId}
        onSelect={onSectionChange}
        onPublish={onPublish}
      />
      <SectionNav
        label={translate('workspace.supporting.label')}
        sections={supportingSections}
        currentId={currentId}
        onSelect={onSectionChange}
      />

      {currentId === 'structure' ? (
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
            <div className="df-section__header">
              <h2 className="df-section__heading">
                {translate('workspace.section.structure')}
              </h2>
              <button
                type="button"
                className="df-button"
                onClick={() => {
                  onSectionChange('upload');
                }}
              >
                {translate('workspace.tab.upload')}
              </button>
            </div>
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
                    roomId,
                    ...(input.parentFolderId === null
                      ? {}
                      : { parentFolderId: input.parentFolderId }),
                    displayName: input.displayName,
                    description: input.description,
                    expectedWorkingRevision: workspace.value.workingRevision,
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
              downloads={
                settings === null ? null : settings.structureDownloads(refreshWorkspace)
              }
              onRename={(entry: WorkingEntry, displayName: string) => {
                runMutation(
                  {
                    action: 'rename',
                    roomId,
                    entryId: entry.entryId,
                    displayName,
                    expectedEntryRevision: entry.revision,
                    expectedWorkingRevision: workspace.value.workingRevision,
                  },
                  entry.entryId,
                );
              }}
              onReorder={(entry: WorkingEntry, targetPosition: number) => {
                runMutation(
                  {
                    action: 'reorder',
                    roomId,
                    entryId: entry.entryId,
                    targetPosition,
                    expectedEntryRevision: entry.revision,
                    expectedWorkingRevision: workspace.value.workingRevision,
                  },
                  entry.entryId,
                );
              }}
              onStageRemoval={(entry: WorkingEntry) => {
                runMutation(
                  {
                    action: 'stage-removal',
                    roomId,
                    entryId: entry.entryId,
                    expectedEntryRevision: entry.revision,
                    expectedWorkingRevision: workspace.value.workingRevision,
                  },
                  entry.entryId,
                );
              }}
              onMove={(input) => {
                runMutation(
                  {
                    action: 'move',
                    roomId,
                    entryId: input.entry.entryId,
                    destinationFolderId: input.destinationFolderId,
                    targetPosition: input.targetPosition,
                    expectedEntryRevision: input.entry.revision,
                    expectedWorkingRevision: workspace.value.workingRevision,
                  },
                  input.entry.entryId,
                );
              }}
              onOpenReview={() => {
                onSectionChange('processing');
              }}
              onMetadata={(input) => {
                runMutation(
                  {
                    action: 'document-metadata',
                    roomId,
                    documentId: input.entry.resourceId,
                    title: input.title,
                    description: input.description,
                    expectedDocumentRevision: input.entry.documentRevision,
                    expectedWorkingRevision: workspace.value.workingRevision,
                  },
                  input.entry.entryId,
                );
              }}
            />
          </section>

          <TrashView
            trash={workspace.value.trash}
            retentionDays={workspace.value.retentionDays}
            folders={folders}
            busyTrashId={busyTrashId}
            onRestore={restore}
          />
        </>
      ) : null}

      {currentId === 'upload' ? (
        <UploadPanel
          pending={uploadPending}
          states={uploadStates}
          failure={uploadFailure}
          doneCount={uploadDoneCount}
          onUpload={upload}
          onCancel={() => {
            uploadAbort.current?.abort();
          }}
          onReload={() => {
            refreshWorkspace();
          }}
        />
      ) : null}

      {currentId === 'participants' ? (
        <AccessSection
          roomId={roomId}
          room={room}
          entries={entries}
          section={participantsSection}
          onStatus={onStatus}
          onRoomsChanged={onRoomsChanged}
        />
      ) : null}

      {currentId === 'processing' ? (
        <ProcessingPanel
          versions={
            processingSection.versions.kind === 'ready' ? processingSection.versions.value : []
          }
          loading={processingSection.versions.kind === 'loading'}
          denied={processingSection.versions.kind === 'failed'}
          failure={processingSection.failure}
          busyVersionId={processingSection.busyVersionId}
          onRetry={processingSection.retry}
          onDeleteSource={processingSection.deleteSource}
          onRefresh={() => {
            void processingSection.refresh(roomId).then(
              () => {
                refreshWorkspace();
                onRoomsChanged();
              },
              () => undefined,
            );
          }}
          onReload={() => {
            processingSection.beginLoading();
            void processingSection.refresh(roomId).then(
              () => {
                refreshWorkspace();
                onRoomsChanged();
              },
              () => undefined,
            );
          }}
        />
      ) : null}

      {currentId === 'exports' ? (
        <ExportsPanel
          exports={exportsSection.exports.kind === 'ready' ? exportsSection.exports.value : []}
          loading={exportsSection.exports.kind === 'loading'}
          denied={exportsSection.exports.kind === 'failed'}
          failure={exportsSection.failure}
          preflight={exportsSection.preflight}
          preflightLoading={exportsSection.preflightPending}
          generatePending={exportsSection.generatePending}
          downloadingId={exportsSection.downloadingId}
          selectedDocumentIds={selectedDocumentIds}
          onPreflight={(input) => {
            exportsSection.review({ roomId, ...input, selectedDocumentIds });
          }}
          onGenerate={() => {
            exportsSection.generate(roomId);
          }}
          onCancelPreflight={exportsSection.cancelReview}
          onDownload={saveExportArchive}
          onReload={() => {
            exportsSection.beginLoading();
            exportsSection.refresh(roomId);
          }}
        />
      ) : null}

      {currentId === 'settings' && settings !== null ? (
        <RoomSettingsPanel section={settings} onStatus={onStatus} />
      ) : null}

      {/* A contributed section renders itself and owns its own state. */}
      {section !== null && isContributed(section)
        ? section.render({ scope: 'room', roomId, onStatus })
        : null}
    </>
  );
}
