/**
 * The signed-in member frame.
 *
 * Deliberately thin: it owns the session, the theme, which view is current, and the
 * one polite live region. The register, the organization workbench, and one room's
 * workspace are three views, each owning its own state, because this file used to
 * hold all of them plus every section's state machine and had grown past a thousand
 * lines.
 *
 * The client makes no access decision. It renders because the server said a session
 * exists, and it offers a control only where the server described one — which avoids
 * presenting an action the server would reject, and is not itself a permission.
 *
 * View navigation is a strip of links-as-buttons, so the register and the workbench
 * read symmetrically with a room's sections rather than introducing a third
 * navigation concept.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  createRoom,
  loadRooms,
  publicationApply,
  publicationDryRun,
  signOut,
  type MemberRoom,
  type NewRoom,
  type RoomCursor,
  type PublicationImpact,
  type WorkingEntry,
} from '../api/client.ts';
import { AppShell } from '../components/AppShell.tsx';
import { Notice } from '../components/Notice.tsx';
import { OpenRoomState } from '../components/OpenRoomState.tsx';
import { PublicationDialog } from '../components/PublicationDialog.tsx';
import { SectionNav } from '../components/SectionNav.tsx';
import { ThemeSelect, type ThemeChoice } from '../components/ThemeSelect.tsx';
import type { SectionTab } from '../contract.ts';
import { currentSection } from '../workspace/sections.ts';
import { translate } from '../i18n/translate.ts';
import { failureMessage } from '../workspace/failure-message.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { settle } from '../workspace/outcome.ts';
import type { Load } from '../workspace/state.ts';
import { useOpenRoom } from '../workspace/useOpenRoom.ts';
import { AdministrationView } from '../workspace/views/AdministrationView.tsx';
import { RegisterView } from '../workspace/views/RegisterView.tsx';
import { RoomView } from '../workspace/views/RoomView.tsx';

export interface WorkspaceProps {
  /**
   * Always `'member'`. Viewers are served by `ViewerReadingRoom`, so this surface
   * has no viewer branch to keep in sync with it.
   */
  readonly principal: 'member';
  /**
   * Whether the server said this member may administer members.
   *
   * Decides whether the Members view is offered. Not an authorization decision: the
   * list route and every mutation refuse independently.
   */
  readonly mayAdministerOrganization: boolean;
  readonly theme: ThemeChoice;
  readonly onThemeChange: (choice: ThemeChoice) => void;
  readonly onSignedOut: () => void;
}

/**
 * The register, and where it continues.
 *
 * `nextCursor` is RETAINED rather than walked to exhaustion. The frame used to follow up
 * to 100 pages eagerly and then store whatever prefix it had reached as permanently
 * incomplete, which turned a loop backstop into an undocumented functional cap: with the
 * default page of 50, room 5,001 could not be reached from the register or the staffing
 * dialog at all, and the surface only reported the list as partial without offering any
 * way to continue. Duefold defines no installation room cap, so a terminal prefix is not
 * an answer this frame may settle on.
 *
 * Keeping the cursor makes completeness the server's statement (`nextCursor === null`) and
 * the remainder always one bounded request away. The staffing dialog decides what "Not
 * staffed" means from this list, so a prefix presented as the full set would let a room
 * the administrator never received read as a room the member is not in.
 */
interface RoomRegister {
  readonly rooms: readonly MemberRoom[];
  /** Null once the server proved this is the whole register. */
  readonly nextCursor: RoomCursor | null;
}

/**
 * The top-level views.
 *
 * `administration` is offered only when the SERVER said this member may administer
 * members. That answer comes from the session bootstrap, so a role change is
 * reflected on the next bootstrap rather than requiring a client release -- and the
 * decision is still not made here: `read_members` and every mutation refuse
 * independently.
 *
 * It used to be offered to everyone, on the reasoning that visibility is not
 * authorization. That was true and still produced a plain member being handed a
 * destination whose only possible content was a refusal.
 */
const ROOMS_VIEW = {
  id: 'rooms',
  scope: 'top',
  label: () => translate('workspace.tab.rooms'),
  order: 10,
} as const satisfies SectionTab;
const ADMINISTRATION_VIEW = {
  id: 'administration',
  scope: 'top',
  label: () => translate('workspace.tab.administration'),
  order: 20,
} as const satisfies SectionTab;
type ViewId = (typeof ROOMS_VIEW | typeof ADMINISTRATION_VIEW)['id'];

export function Workspace({
  principal,
  mayAdministerOrganization,
  theme,
  onThemeChange,
  onSignedOut,
}: WorkspaceProps): React.ReactElement {
  const [status, setStatus] = useState('');
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [pendingSignOut, setPendingSignOut] = useState<'this-device' | 'everywhere' | null>(
    null,
  );
  const [rooms, setRooms] = useState<Load<RoomRegister>>({ kind: 'loading' });
  /* A failed CONTINUATION, distinct from a failed first page: the rooms already read stay
     on screen and the same request can be made again. */
  const [roomsFailure, setRoomsFailure] = useState<string | null>(null);
  const [roomsLoadingMore, setRoomsLoadingMore] = useState(false);
  const [view, setView] = useState<ViewId>('rooms');
  /* One entry for a member who cannot administer, so the strip degrades to the single
     destination they have rather than to a tab that would only refuse them. */
  const views = mayAdministerOrganization ? [ROOMS_VIEW, ADMINISTRATION_VIEW] : [ROOMS_VIEW];
  /*
   * Resolved against the strip that actually exists, so `mayAdministerOrganization` is
   * consulted ONCE -- when composing `views` -- and every later question is "is this view
   * on the strip?".
   *
   * It was tested again at the selection handler and again at the render, and three copies
   * of one rule is three places to forget it. `currentSection` falls back to the first tab
   * when the requested id is absent, which is exactly the behaviour those checks were
   * hand-rolling: a member who cannot administer resolves to Rooms because Administration
   * is not in their strip, not because a boolean was re-read.
   */
  const currentView = currentSection(views, view) ?? ROOMS_VIEW;
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [roomSectionId, setRoomSectionId] = useState('structure');
  /* This room's entries, published by the room view so the shell's collection index
     can list them. The index is the frame's; its content belongs to the view. */
  const [roomEntries, setRoomEntries] = useState<readonly WorkingEntry[]>([]);
  /* Bumped when the frame's own action changed the open room, so the room view
     re-reads rather than the frame reaching into its loader. */
  const [roomReloadToken, setRoomReloadToken] = useState(0);
  const [administrationSectionId, setAdministrationSectionId] = useState('members');
  const [publishOpen, setPublishOpen] = useState(false);
  const [impact, setImpact] = useState<PublicationImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [publishPending, setPublishPending] = useState(false);
  const [publishFailure, setPublishFailure] = useState<string | null>(null);
  const preparationStep =
    roomSectionId === 'participants' || roomSectionId === 'counterparties'
      ? 'access'
      : roomSectionId === 'structure' || roomSectionId === 'upload'
        ? 'collection'
        : roomSectionId === 'processing'
          ? 'review'
          : null;

  /*
   * The register is loaded by the frame rather than by a view, because both the
   * register and the workbench need it: a room's title and revisions come from here,
   * and the assignment dialog names rooms from the same list.
   *
   * A failed load enters `failed` and NEVER `ready` with an empty list. Rendering
   * "no rooms yet" beside a refusal would tell a member that inaccessible rooms are
   * absent, which is how revocation was once hidden from a viewer.
   *
   * The register is PAGED (§23) and this reads ONE page. `nextCursor` is kept so the rest
   * is reachable on request: walking every page eagerly and stopping at an arbitrary cap
   * made the tail of a large installation unreachable and slowed the first paint by every
   * page it insisted on reading first.
   */
  const [openRoomToken, setOpenRoomToken] = useState(0);
  const refreshRooms = useCallback((signal?: AbortSignal): void => {
    setOpenRoomToken((token) => token + 1);
    loadRooms(signal === undefined ? {} : { signal }).then(
      (page) => {
        setRoomsFailure(null);
        setRooms({
          kind: 'ready',
          value: { rooms: page.rooms, nextCursor: page.nextCursor },
        });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRooms({ kind: 'failed', failure: failureMessage(error) });
      },
    );
  }, []);

  /**
   * Reads the next page and appends it.
   *
   * The pages already read stay on screen: they are accurate for the rooms they name, and
   * discarding them on a failed continuation would empty a register that had loaded.
   * `nextCursor` is replaced by whatever the server states, so a failure leaves the cursor
   * intact and the same request can be made again.
   */
  const loadMoreRooms = useCallback((): void => {
    setRooms((current) => {
      if (current.kind !== 'ready' || current.value.nextCursor === null) return current;
      const after = current.value.nextCursor;
      setRoomsLoadingMore(true);
      setRoomsFailure(null);
      loadRooms({ after }).then(
        (page) => {
          setRoomsLoadingMore(false);
          setRooms((latest) =>
            latest.kind === 'ready'
              ? {
                  kind: 'ready',
                  value: {
                    rooms: [...latest.value.rooms, ...page.rooms],
                    nextCursor: page.nextCursor,
                  },
                }
              : latest,
          );
        },
        (error: unknown) => {
          setRoomsLoadingMore(false);
          /* The cursor is untouched, so this is retryable rather than terminal. */
          setRoomsFailure(failureMessage(error));
        },
      );
      return current;
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refreshRooms(controller.signal);
    return () => {
      controller.abort();
    };
  }, [refreshRooms]);

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

  const register = rooms.kind === 'ready' ? rooms.value : null;
  const roomList = register?.rooms ?? [];
  const openRoomLoad = useOpenRoom(openRoomId, openRoomToken);
  const openRoom = openRoomLoad?.kind === 'ready' ? openRoomLoad.value : null;

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
    if (openRoomId === null || impact === null) return;
    setPublishPending(true);
    setPublishFailure(null);
    publicationApply({
      roomId: openRoomId,
      expectedWorkingRevision: impact.workingRevision,
      expectedPublishedRevision: impact.publishedRevision,
      confirmation,
    }).then(
      () => {
        setPublishPending(false);
        setPublishOpen(false);
        setStatus(translate('publish.done'));
        refreshRooms();
        setRoomReloadToken((token) => token + 1);
      },
      (error: unknown) => {
        setPublishPending(false);
        setPublishFailure(
          error instanceof ApiError && error.failure === 'fresh-authentication-required'
            ? translate('publish.freshSignIn')
            : failureMessage(error),
        );
      },
    );
  };

  const leaveRoom = (): void => {
    setOpenRoomId(null);
    setSelectedEntryId(null);
    setRoomSectionId('structure');
    setRoomEntries([]);
  };

  const inRoom = openRoomId !== null;
  /*
   * The collection index lists rooms at the top level and this room's entries inside
   * one, which is the finding-aid behaviour the shell was built for.
   */
  const indexEntries = inRoom
    ? roomEntries.map((entry) => ({
        id: entry.entryId,
        title: entry.displayName,
        depth: entry.depth,
        kind: entry.resourceKind === 'folder' ? ('group' as const) : ('item' as const),
      }))
    : roomList.map((room) => ({
        id: room.roomId,
        title: room.title,
        depth: 0,
        kind: 'item' as const,
      }));

  const enterRoom = (id: string): void => {
    setOpenRoomId(id);
    setSelectedEntryId(null);
    setRoomSectionId('structure');
  };

  const createRoomAndEnter = async (room: NewRoom): Promise<PresentedFailure | null> => {
    const outcome = await settle(createRoom(room));
    if (!outcome.ok) return outcome.failure;
    setStatus(translate('rooms.new.created', { title: room.title }));
    enterRoom(outcome.value.roomId);
    refreshRooms();
    return null;
  };

  return (
    <AppShell
      title={
        openRoom !== null
          ? openRoom.title
          : view === 'administration'
            ? translate('members.title')
            : translate('rooms.title')
      }
      entries={indexEntries}
      currentEntryId={inRoom ? selectedEntryId : null}
      indexEmpty={{
        lead: inRoom ? translate('workspace.empty') : translate('shell.index.empty'),
        help: inRoom ? translate('workspace.emptyHelp') : translate('shell.index.emptyHelp'),
      }}
      onSelectEntry={(id) => {
        if (inRoom) {
          setSelectedEntryId(id);
          setRoomSectionId('structure');
          return;
        }
        if (roomList.some((room) => room.roomId === id)) {
          setOpenRoomId(id);
          setSelectedEntryId(null);
          setView('rooms');
          setRoomSectionId('structure');
        }
      }}
      status={status}
      primaryAction={
        openRoom !== null ? (
          openRoom.canPublish ? (
            <button
              type="button"
              className="df-button df-button--primary"
              onClick={beginPublish}
            >
              {translate('publish.action')}
            </button>
          ) : (
            // A Contributor stages; a Manager publishes. Rather than hiding the
            // concept, the reason is stated so the member is not left guessing.
            <span className="df-field__help">{translate('publish.contributorNote')}</span>
          )
        ) : null
      }
      notes={
        openRoom !== null ? (
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
        ) : undefined
      }
      contextActions={
        inRoom ? (
          <button type="button" className="df-button df-button--quiet" onClick={leaveRoom}>
            {translate('rooms.title')}
          </button>
        ) : null
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

      {/* View navigation belongs to the top level only. Inside a room the strip
          would compete with that room's own sections for the same grammar. */}
      {inRoom ? null : (
        <SectionNav
          label={translate('workspace.views.label')}
          sections={views}
          currentId={view}
          onSelect={(id) => {
            setView(currentSection(views, id)?.id ?? 'rooms');
          }}
        />
      )}

      {openRoomLoad === null ? null : (
        <OpenRoomState
          load={openRoomLoad}
          onRetry={() => {
            setOpenRoomToken((current) => current + 1);
          }}
          onLeave={leaveRoom}
        />
      )}

      {openRoomId !== null && openRoom !== null ? (
        <>
          <nav className="df-preparation" aria-label={translate('workspace.steps.label')}>
            <button
              type="button"
              className="df-preparation__step"
              aria-current={preparationStep === 'collection' ? 'step' : undefined}
              onClick={() => {
                setRoomSectionId('structure');
              }}
            >
              {translate('workspace.steps.collection')}
            </button>
            <button
              type="button"
              className="df-preparation__step"
              aria-current={preparationStep === 'access' ? 'step' : undefined}
              onClick={() => {
                setRoomSectionId('participants');
              }}
            >
              {translate('workspace.steps.access')}
            </button>
            <button
              type="button"
              className="df-preparation__step"
              aria-current={preparationStep === 'review' ? 'step' : undefined}
              onClick={() => {
                setRoomSectionId('processing');
              }}
            >
              {translate('workspace.steps.review')}
            </button>
            <button
              type="button"
              className="df-preparation__step df-preparation__step--publish"
              onClick={beginPublish}
            >
              {translate('workspace.steps.publish')}
            </button>
          </nav>
          <RoomView
            roomId={openRoomId}
            room={openRoom}
            selectedEntryId={selectedEntryId}
            sectionId={roomSectionId}
            reloadToken={roomReloadToken}
            onSectionChange={setRoomSectionId}
            onStatus={setStatus}
            onRoomsChanged={refreshRooms}
            onEntriesChange={setRoomEntries}
          />
        </>
      ) : currentView.id === 'administration' ? (
        <AdministrationView
          rooms={roomList}
          roomsComplete={register?.nextCursor === null}
          roomsLoadingMore={roomsLoadingMore}
          onLoadMoreRooms={loadMoreRooms}
          sectionId={administrationSectionId}
          onSectionChange={setAdministrationSectionId}
          onStatus={setStatus}
          onSessionEnded={onSignedOut}
        />
      ) : (
        <RegisterView
          rooms={rooms}
          loadingMore={roomsLoadingMore}
          pageFailure={roomsFailure}
          createRoom={mayAdministerOrganization ? createRoomAndEnter : null}
          onLoadMore={loadMoreRooms}
          onOpen={enterRoom}
          onRetry={() => {
            setRooms({ kind: 'loading' });
            setRoomsFailure(null);
            refreshRooms();
          }}
        />
      )}

      <PublicationDialog
        open={publishOpen}
        impact={impact}
        loading={impactLoading}
        pending={publishPending}
        failure={publishFailure}
        onConfirm={confirmPublish}
        onCancel={() => {
          setPublishOpen(false);
        }}
      />
    </AppShell>
  );
}
