/**
 * Member frame view tests.
 *
 * The split of `Workspace` into three views was a pure move, so these assert the
 * structure each view is responsible for rather than re-testing the panels below
 * them. Rendered through `react-dom/server`, matching `AppShell.unit.test.tsx`;
 * interaction and focus belong to the Playwright suite.
 *
 * `AdministrationView` and `RoomView` both mount their own loaders, which need a DOM
 * and a server, so only `RegisterView` — which renders from props alone — is rendered
 * here. The frame's composed view strip is asserted from the same contract the views
 * use.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MemberRoom } from '../../api/client.ts';
import { SectionNav } from '../../components/SectionNav.tsx';
import { messages } from '../../i18n/en.ts';
import { RegisterView } from './RegisterView.tsx';

const ROOM: MemberRoom = {
  roomId: 'r'.repeat(32),
  title: 'Series A',
  description: 'Diligence materials',
  state: 'draft',
  revision: 1,
  workingRevision: 1,
  publishedRevision: 0,
  roomRole: 'manager',
  accessSource: 'assignment',
  canPublish: true,
};

const CURSOR = { title: 'Series A', roomId: ROOM.roomId };

function register(overrides: Partial<Parameters<typeof RegisterView>[0]> = {}): string {
  return renderToStaticMarkup(
    <RegisterView
      rooms={{ kind: 'ready', value: { rooms: [ROOM], nextCursor: null } }}
      loadingMore={false}
      pageFailure={null}
      createRoom={null}
      onLoadMore={() => undefined}
      onOpen={() => undefined}
      onRetry={() => undefined}
      {...overrides}
    />,
  );
}

describe('RegisterView', () => {
  it('renders the register when rooms load', () => {
    const markup = register();
    expect(markup).toContain('Series A');
    expect(markup).toContain(messages['rooms.open']);
  });

  it('renders the loading state rather than an empty register', () => {
    const markup = register({ rooms: { kind: 'loading' } });
    expect(markup).toContain(messages['rooms.loading']);
    expect(markup).not.toContain('<table');
  });

  it('reports a refusal as a refusal, never as an empty register', () => {
    /*
     * "No rooms yet" beside a refused load would tell a member that inaccessible
     * rooms are absent, which is how revocation was once hidden from a viewer.
     */
    const markup = register({
      rooms: { kind: 'failed', failure: messages['error.denied.body'] },
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(messages['error.denied.body']);
    expect(markup).not.toContain(messages['rooms.empty']);
    expect(markup).toContain(messages['app.retry']);
  });

  it('says so when only part of the register loaded, and offers the rest', () => {
    /*
     * The register is paged. Silence about a prefix would let a short list read as every
     * room this member can reach, which is a false statement about access.
     *
     * The ACTION is the part that was missing. The frame used to walk to an arbitrary page
     * cap and store the prefix as terminal, so this notice named a limitation with no way
     * past it and rooms beyond the cap were unreachable.
     */
    const markup = register({
      rooms: { kind: 'ready', value: { rooms: [ROOM], nextCursor: CURSOR } },
    });
    expect(markup).toContain(messages['rooms.partial']);
    expect(markup).toContain(messages['rooms.more']);
    expect(markup).toContain('Series A');
  });

  it('names the continuation as pending while it runs, and disables it', () => {
    const markup = register({
      rooms: { kind: 'ready', value: { rooms: [ROOM], nextCursor: CURSOR } },
      loadingMore: true,
    });
    expect(markup).toContain(messages['rooms.loadingMore']);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('data-busy="true"');
  });

  it('reports a failed continuation beside the rooms that did load', () => {
    /* The cursor is untouched by a failure, so the rooms already read stay and the same
       request can be made again rather than the register emptying. */
    const markup = register({
      rooms: { kind: 'ready', value: { rooms: [ROOM], nextCursor: CURSOR } },
      pageFailure: messages['error.unavailable.body'],
    });
    expect(markup).toContain(messages['error.unavailable.body']);
    expect(markup).toContain('Series A');
    expect(markup).toContain(messages['rooms.more']);
  });

  it('claims nothing about completeness when the whole register loaded', () => {
    const markup = register();
    expect(markup).not.toContain(messages['rooms.partial']);
    /* No continuation control either: the server proved there is nothing to continue to,
       so offering one would be an action that cannot do anything. */
    expect(markup).not.toContain(messages['rooms.more']);
  });

  it('renders the empty register with its own copy when there genuinely are none', () => {
    const markup = register({
      rooms: { kind: 'ready', value: { rooms: [], nextCursor: null } },
    });
    expect(markup).toContain(messages['rooms.empty']);
    expect(markup).toContain(messages['rooms.emptyHelp']);
    expect(markup).not.toContain('role="alert"');
  });

  it('offers New room only when the server said this member may create rooms', () => {
    const ready = { kind: 'ready', value: { rooms: [], nextCursor: null } } as const;
    const props = {
      rooms: ready,
      loadingMore: false,
      pageFailure: null,
      onLoadMore: () => undefined,
      onOpen: () => undefined,
      onRetry: () => undefined,
    };
    expect(renderToStaticMarkup(<RegisterView {...props} createRoom={null} />)).not.toContain(
      messages['rooms.new'],
    );
    expect(
      renderToStaticMarkup(
        <RegisterView {...props} createRoom={() => Promise.resolve(null)} />,
      ),
    ).toContain(messages['rooms.new']);
  });
});

describe('view navigation', () => {
  const VIEWS = [
    {
      id: 'rooms',
      scope: 'top' as const,
      label: () => messages['workspace.tab.rooms'],
      order: 10,
    },
    {
      id: 'administration',
      scope: 'top' as const,
      label: () => messages['workspace.tab.members'],
      order: 20,
    },
  ];

  it('marks the current view with aria-current, not colour alone', () => {
    const markup = renderToStaticMarkup(
      <SectionNav
        label={messages['workspace.views.label']}
        sections={VIEWS}
        currentId="administration"
        onSelect={() => undefined}
      />,
    );
    expect([...markup.matchAll(/aria-current="true"/gu)]).toHaveLength(1);
    const current = markup.indexOf('aria-current="true"');
    expect(markup.slice(current, current + 120)).toContain(messages['workspace.tab.members']);
  });

  it('names the navigation region so a landmark list is usable', () => {
    const markup = renderToStaticMarkup(
      <SectionNav
        label={messages['workspace.views.label']}
        sections={VIEWS}
        currentId="rooms"
        onSelect={() => undefined}
      />,
    );
    expect(markup).toMatch(/<nav class="df-sections" aria-label="[^"]+"/u);
  });

  it('offers the administration view to every member, because visibility is not authorization', () => {
    /*
     * The reader behind the workbench refuses anyone who is not an Owner or Admin, and
     * the surface renders that refusal. Hiding the tab would put an access decision in
     * the browser, where a change of role could not be reflected without a reload.
     */
    const markup = renderToStaticMarkup(
      <SectionNav
        label={messages['workspace.views.label']}
        sections={VIEWS}
        currentId="rooms"
        onSelect={() => undefined}
      />,
    );
    expect(markup).toContain(messages['workspace.tab.members']);
  });

  it('renders no strip for a single section, which would be a tab stop saying nothing', () => {
    const markup = renderToStaticMarkup(
      <SectionNav
        label={messages['workspace.views.label']}
        sections={[VIEWS[0]!]}
        currentId="rooms"
        onSelect={() => undefined}
      />,
    );
    expect(markup).toBe('');
  });

  it('renders section tabs as buttons in a nav rather than an ARIA tablist', () => {
    // A tablist would promise arrow-key semantics that add nothing here, and
    // `aria-current` already states which section is showing.
    const markup = renderToStaticMarkup(
      <SectionNav
        label={messages['workspace.views.label']}
        sections={VIEWS}
        currentId="rooms"
        onSelect={() => undefined}
      />,
    );
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain('role="tab"');
    expect([...markup.matchAll(/<button type="button"/gu)]).toHaveLength(VIEWS.length);
  });
});
