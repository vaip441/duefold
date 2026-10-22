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
  createFolder,
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
import { StructureControls, type BulkProgress } from '../../components/StructureControls.tsx';
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
import { checksumPartPlan, resolveUploadFolders, transferParts } from '../upload.ts';
import { depthFirst } from '../../viewer/structure-depth.ts';
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
  /** Opens the investor preview of this room's published content. */
  readonly onPreview: () => void;
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

/* One shared empty list: a fresh `[]` per render would re-fire the effect that
   publishes entries to the frame, whose state update re-renders this view forever. */
const NO_ENTRIES: readonly WorkingEntry[] = [];

export function roomEntries(workspace: Load<RoomWorkspace>): readonly WorkingEntry[] {
  return workspace.kind === 'ready' ? workspace.value.entries : NO_ENTRIES;
}

/**
 * The selected entries bulk removal must stage itself. Staging a folder already withholds
 * everything inside it from publication, and the server refuses to stage an entry whose
 * folder is staged, so an entry under a selected or staged folder is left to that folder.
 */
export function removalTargets(
  entries: readonly WorkingEntry[],
  selection: readonly string[],
): readonly WorkingEntry[] {
  const selected = new Set(selection);
  const covered = new Set<string>();
  return depthFirst(entries).filter((entry) => {
    const underCovered = entry.parentFolderId !== null && covered.has(entry.parentFolderId);
    const chosen = selected.has(entry.entryId);
    if (underCovered || chosen || entry.stagedRemoved) covered.add(entry.resourceId);
    return chosen && !entry.stagedRemoved && !underCovered;
  });
}

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
  onPreview,
}: RoomViewProps): React.ReactElement {
  const [workspace, setWorkspace] = useState<Load<RoomWorkspace>>({ kind: 'loading' });
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [writePending, setWritePending] = useState(false);
  const [busyTrashId, setBusyTrashId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<readonly SearchHit[] | null>(null);
  const [searchPending, setSearchPending] = useState(false);
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const [uploadPending, setUploadPending] = useState(false);
  const [uploadStates, setUploadStates] = useState<ReadonlyMap<string, UploadItemState>>(
    new Map(),
  );
  const [uploadFailure, setUploadFailure] = useState<PresentedFailure | null>(null);
  const [uploadDoneCount, setUploadDoneCount] = useState(0);
  const uploadAbort = useRef<AbortController | null>(null);
  /* Leaving the room ends its upload; the server reaps the abandoned intent. */
  useEffect(
    () => () => {
      uploadAbort.current?.abort();
    },
    [roomId],
  );

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

  /* A newer read aborts the older one, so an earlier read can never land after a later one
     and put back a structure the member has already changed. A superseded read settles with
     the read that replaced it, so a caller waits for the structure actually shown. This view
     is reused across rooms, so a read asked for by a room already left is not started. */
  const reading = useRef<{
    readonly controller: AbortController;
    readonly landed: Promise<void>;
  } | null>(null);
  const openRoomId = useRef(roomId);
  const readWorkspace = useCallback((): Promise<void> => {
    if (openRoomId.current !== roomId) return Promise.resolve();
    reading.current?.controller.abort();
    const controller = new AbortController();
    const landed = loadRoomWorkspace(roomId, controller.signal)
      .then(
        (value) => {
          if (!controller.signal.aborted) setWorkspace({ kind: 'ready', value });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setWorkspace({ kind: 'failed', failure: presentFailure(error).body });
        },
      )
      .then(() =>
        reading.current?.controller === controller ? undefined : reading.current?.landed,
      );
    reading.current = { controller, landed };
    return landed;
  }, [roomId]);
  const refreshWorkspace = useCallback((): void => {
    void readWorkspace();
  }, [readWorkspace]);

  /* Synced before the read effect below, which checks it; a read the old room starts in
     between is aborted by that effect's cleanup. */
  useEffect(() => {
    openRoomId.current = roomId;
  }, [roomId]);
  useEffect(() => {
    setWorkspace({ kind: 'loading' });
    refreshWorkspace();
    return () => {
      reading.current?.controller.abort();
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

  /**
   * Runs a mutation, then refreshes from the server rather than guessing state. The structure
   * stays busy until that refresh lands: until then every row carries the revisions this write
   * replaced, and a second action would send them and be refused as a conflict.
   */
  const runMutation = (body: Readonly<Record<string, unknown>>): void => {
    setWritePending(true);
    setActionFailure(null);
    void mutateStructure(body)
      .then(
        () => {
          onStatus(translate('structure.saving'));
          onRoomsChanged();
          return readWorkspace();
        },
        (error: unknown) => {
          // A rejected revision means a colleague changed the room. The member is
          // told to refresh; the write is never retried behind their back.
          setActionFailure(presentFailure(error).body);
        },
      )
      .finally(() => {
        setWritePending(false);
      });
  };

  const entries = roomEntries(workspace);
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
  const selected = new Set(selection);
  const selectedDocumentIds = entries
    .filter((entry) => entry.resourceKind === 'document' && selected.has(entry.entryId))
    .map((entry) => entry.resourceId);

  const restore = (input: {
    readonly entry: TrashEntry;
    readonly displayName: string;
    readonly destinationFolderId: string | null;
  }): void => {
    if (workspace.kind !== 'ready') return;
    setBusyTrashId(input.entry.trashId);
    setActionFailure(null);
    // Busy until the refresh lands, as in runMutation: the stale row would offer a second restore.
    void restoreFromTrash({
      trashId: input.entry.trashId,
      destinationFolderId: input.destinationFolderId,
      displayName: input.displayName,
      expectedEntryRevision: input.entry.entryRevision,
      expectedWorkingRevision: workspace.value.workingRevision,
    })
      .then(
        () => {
          onRoomsChanged();
          return readWorkspace();
        },
        (error: unknown) => {
          setActionFailure(presentFailure(error).body);
        },
      )
      .finally(() => {
        setBusyTrashId(null);
      });
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
        setActionFailure(presentFailure(error).body);
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
   * Uploads a reviewed queue sequentially, after recreating its directory folders. Each
   * file keeps its own result, so one rejected source cannot make already-quarantined
   * files look absent or turn a partial batch into a false all-or-nothing success.
   */
  const upload = (items: readonly UploadItem[]): void => {
    if (workspace.kind !== 'ready') return;
    const { workingRevision } = workspace.value;
    const controller = new AbortController();
    uploadAbort.current = controller;
    setUploadPending(true);
    setUploadFailure(null);
    setUploadDoneCount(0);
    setUploadStates((current) => {
      const next = new Map(current);
      for (const item of items) next.set(item.id, { kind: 'waiting' });
      return next;
    });

    void (async () => {
      // A cancel during folder creation leaves this empty and ends at the loop's first check.
      let destinations: ReadonlyMap<string, string | null> = new Map();
      try {
        destinations = await resolveUploadFolders({
          relativePaths: items.map((item) => item.relativePath),
          entries,
          workingRevision,
          createFolder: (folder) =>
            createFolder({ roomId, ...folder, signal: controller.signal }),
        });
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          // No file was transferred; folders created before the refusal are reused next time.
          setUploadPending(false);
          uploadAbort.current = null;
          setUploadFailure(
            error instanceof Error && error.message === 'UPLOAD_FOLDER_NAME_TAKEN'
              ? { ...presentFailure(error), body: translate('upload.folderNameTaken') }
              : presentFailure(error),
          );
          refreshWorkspace();
          onRoomsChanged();
          return;
        }
      }
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
          const parentFolderId = destinations.get(item.relativePath);
          if (parentFolderId === undefined) throw new Error('UPLOAD_DESTINATION_UNRESOLVED');
          // macOS reports decomposed (NFD) names; the server accepts only NFC.
          const intent = await createUploadIntent({
            roomId,
            ...(parentFolderId === null ? {} : { parentFolderId }),
            displayTitle: item.title.normalize('NFC'),
            originalFilename: item.file.name.normalize('NFC'),
            declaredMediaType: item.mediaType,
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
      // Folders and files created before a cancel or a failure have still changed the room.
      refreshWorkspace();
      onRoomsChanged();
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
   * Each write's returned revision feeds the next, so a colleague's change in between
   * is refused as a conflict rather than overwritten. A failure partway reports how
   * many succeeded instead of implying all did. The structure stays busy until the
   * refresh lands, as in `runMutation`.
   */
  const bulkStageRemoval = (): void => {
    if (workspace.kind !== 'ready') return;
    const targets = removalTargets(workspace.value.entries, selection);
    if (targets.length === 0) return;
    setWritePending(true);
    setActionFailure(null);
    setBulkProgress({ kind: 'applying', total: targets.length });
    void (async () => {
      let done = 0;
      let workingRevision = workspace.value.workingRevision;
      for (const entry of targets) {
        try {
          ({ workingRevision } = await mutateStructure({
            action: 'stage-removal',
            roomId,
            entryId: entry.entryId,
            expectedEntryRevision: entry.revision,
            expectedWorkingRevision: workingRevision,
          }));
          done += 1;
        } catch (error: unknown) {
          setActionFailure(presentFailure(error).body);
          break;
        }
      }
      setBulkProgress(
        done === targets.length ? null : { kind: 'stopped', done, total: targets.length },
      );
      setSelection([]);
      onRoomsChanged();
      await readWorkspace();
      setWritePending(false);
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
        onPreview={onPreview}
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
              pending={writePending}
              selection={selection}
              bulkProgress={bulkProgress}
              onCreateFolder={(input) => {
                runMutation({
                  action: 'create-folder',
                  roomId,
                  ...(input.parentFolderId === null
                    ? {}
                    : { parentFolderId: input.parentFolderId }),
                  displayName: input.displayName,
                  description: input.description,
                  expectedWorkingRevision: workspace.value.workingRevision,
                });
              }}
              onSelectionChange={setSelection}
              onBulkStageRemoval={bulkStageRemoval}
            />
            <StructureTable
              entries={entries}
              pending={writePending}
              selection={selection}
              onSelectionChange={setSelection}
              folders={folders}
              downloads={
                settings === null ? null : settings.structureDownloads(refreshWorkspace)
              }
              onRename={(entry: WorkingEntry, displayName: string) => {
                runMutation({
                  action: 'rename',
                  roomId,
                  entryId: entry.entryId,
                  displayName,
                  expectedEntryRevision: entry.revision,
                  expectedWorkingRevision: workspace.value.workingRevision,
                });
              }}
              onReorder={(entry: WorkingEntry, targetPosition: number) => {
                runMutation({
                  action: 'reorder',
                  roomId,
                  entryId: entry.entryId,
                  targetPosition,
                  expectedEntryRevision: entry.revision,
                  expectedWorkingRevision: workspace.value.workingRevision,
                });
              }}
              onStageRemoval={(entry: WorkingEntry) => {
                runMutation({
                  action: 'stage-removal',
                  roomId,
                  entryId: entry.entryId,
                  expectedEntryRevision: entry.revision,
                  expectedWorkingRevision: workspace.value.workingRevision,
                });
              }}
              onMove={(input) => {
                runMutation({
                  action: 'move',
                  roomId,
                  entryId: input.entry.entryId,
                  destinationFolderId: input.destinationFolderId,
                  targetPosition: input.targetPosition,
                  expectedEntryRevision: input.entry.revision,
                  expectedWorkingRevision: workspace.value.workingRevision,
                });
              }}
              onOpenReview={() => {
                onSectionChange('processing');
              }}
              onMetadata={(input) => {
                runMutation({
                  action: 'document-metadata',
                  roomId,
                  documentId: input.entry.resourceId,
                  title: input.title,
                  description: input.description,
                  expectedDocumentRevision: input.entry.documentRevision,
                  expectedWorkingRevision: workspace.value.workingRevision,
                });
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
            processingSection.listing.kind === 'ready'
              ? processingSection.listing.value.versions
              : []
          }
          loading={processingSection.listing.kind === 'loading'}
          denied={processingSection.listing.kind === 'failed'}
          failure={processingSection.failure}
          busyVersionId={processingSection.busyVersionId}
          hasMore={
            processingSection.listing.kind === 'ready' &&
            processingSection.listing.value.nextCursor !== null
          }
          loadingMore={processingSection.loadingMore}
          onLoadMore={() => {
            processingSection.loadMore(roomId);
          }}
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
          exports={
            exportsSection.listing.kind === 'ready' ? exportsSection.listing.value.exports : []
          }
          loading={exportsSection.listing.kind === 'loading'}
          denied={exportsSection.listing.kind === 'failed'}
          failure={exportsSection.failure}
          hasMore={
            exportsSection.listing.kind === 'ready' &&
            exportsSection.listing.value.nextCursor !== null
          }
          loadingMore={exportsSection.loadingMore}
          onLoadMore={() => {
            exportsSection.loadMore(roomId);
          }}
          preflight={exportsSection.preflight}
          preflightLoading={exportsSection.preflightPending}
          generatePending={exportsSection.generatePending}
          downloadingId={exportsSection.downloadingId}
          selectedDocumentIds={selectedDocumentIds}
          onPreflight={(input) => {
            // The server refuses a selection sent with any other preset.
            exportsSection.review({
              roomId,
              ...input,
              selectedDocumentIds:
                input.preset === 'selected-documents' ? selectedDocumentIds : [],
            });
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
