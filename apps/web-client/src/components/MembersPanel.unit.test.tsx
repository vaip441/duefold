import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  MemberRoom,
  OwnershipTransferImpact,
  PendingInvitation,
  ProvisionedMember,
} from '../api/client.ts';
import { messages } from '../i18n/en.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { classifyLoad, type LoadRecovery } from '../workspace/views/load-state.ts';
import { MemberRoomsForm } from './MemberRoomsForm.tsx';
import { MembersPanel, type MembersPanelProps } from './MembersPanel.tsx';
import { OwnershipTransferPreview } from './OwnershipTransferPreview.tsx';

const ROOM: MemberRoom = {
  roomId: 'r'.repeat(32),
  title: 'Series A',
  description: '',
  state: 'draft',
  revision: 1,
  workingRevision: 1,
  publishedRevision: 0,
  roomRole: null,
  accessSource: 'global_role',
  canPublish: true,
};

function subject(overrides: Partial<ProvisionedMember> = {}): ProvisionedMember {
  return {
    subjectKind: 'member',
    subjectId: 'a'.repeat(32),
    emailDisplay: 'person@example.test',
    globalRole: 'member',
    state: 'active',
    revision: 2,
    createdAt: '2026-09-20T10:00:00.000Z',
    assignments: [],
    capabilities: { setRole: true, setState: true, assignRooms: true, transfer: true },
    ...overrides,
  };
}

function invitation(overrides: Partial<PendingInvitation> = {}): PendingInvitation {
  return {
    subjectKind: 'invitation',
    subjectId: 'b'.repeat(32),
    emailDisplay: 'invited@example.test',
    state: 'pending',
    intendedRole: 'admin',
    revision: 1,
    createdAt: '2026-09-20T11:00:00.000Z',
    ...overrides,
  };
}

/**
 * The panel's props are grouped by surface; these overrides are deliberately FLAT.
 *
 * A case says `render({ loading: true })`, not `render({ listing: { loading: true, denied:
 * false, ... } })`. Nesting the overrides would make every case restate a whole group to
 * change one field, and what each case is actually testing would disappear into the
 * scaffolding. The grouping is the component's contract; this is the test's convenience,
 * and `render` is the one place that maps between them.
 */
interface Overrides {
  readonly subjects?: MembersPanelProps['subjects'];
  readonly busySubjectId?: string | null;
  readonly changeFailure?: PresentedFailure | null;
  readonly loading?: boolean;
  readonly denied?: boolean;
  readonly failedLoad?: boolean;
  readonly loadRecovery?: LoadRecovery;
  readonly failure?: PresentedFailure | null;
  readonly hasMore?: boolean;
  readonly loadingMore?: boolean;
  readonly rooms?: MembersPanelProps['assignment']['rooms'];
  readonly roomsComplete?: boolean;
  readonly roomsLoadingMore?: boolean;
  readonly invitePending?: boolean;
  readonly inviteFailure?: PresentedFailure | null;
  readonly transferImpact?: MembersPanelProps['transfer']['impact'];
  readonly transferImpactPending?: boolean;
  readonly transferPending?: boolean;
  readonly transferFailure?: PresentedFailure | null;
  readonly onAssign?: MembersPanelProps['assignment']['onAssign'];
  readonly onRoleChange?: MembersPanelProps['onRoleChange'];
  readonly onStateChange?: MembersPanelProps['onStateChange'];
  readonly onRevokeInvitation?: MembersPanelProps['onRevokeInvitation'];
}

function render(overrides: Overrides = {}): string {
  return renderToStaticMarkup(
    <MembersPanel
      subjects={overrides.subjects ?? []}
      busySubjectId={overrides.busySubjectId ?? null}
      changeFailure={overrides.changeFailure ?? null}
      listing={{
        loading: overrides.loading ?? false,
        denied: overrides.denied ?? false,
        failedLoad: overrides.failedLoad ?? false,
        loadRecovery: overrides.loadRecovery ?? 'none',
        failure: overrides.failure ?? null,
        hasMore: overrides.hasMore ?? false,
        loadingMore: overrides.loadingMore ?? false,
        onLoadMore: () => undefined,
        onReload: () => undefined,
      }}
      invite={{
        pending: overrides.invitePending ?? false,
        failure: overrides.inviteFailure ?? null,
        onInvite: () => undefined,
      }}
      assignment={{
        rooms: overrides.rooms ?? [],
        roomsComplete: overrides.roomsComplete ?? true,
        roomsLoadingMore: overrides.roomsLoadingMore ?? false,
        onLoadMoreRooms: () => undefined,
        onAssign: overrides.onAssign ?? (() => Promise.resolve(null)),
      }}
      transfer={{
        impact: overrides.transferImpact ?? null,
        impactPending: overrides.transferImpactPending ?? false,
        pending: overrides.transferPending ?? false,
        failure: overrides.transferFailure ?? null,
        onReview: () => undefined,
        onApply: () => undefined,
        onCancel: () => undefined,
      }}
      onRevokeInvitation={overrides.onRevokeInvitation ?? (() => undefined)}
      onRoleChange={overrides.onRoleChange ?? (() => undefined)}
      onStateChange={overrides.onStateChange ?? (() => undefined)}
      onSessionEnded={() => undefined}
    />,
  );
}

describe('designed states', () => {
  it('renders a loading line rather than an empty table', () => {
    const markup = render({ loading: true });
    expect(markup).toContain(messages['members.loading']);
    expect(markup).not.toContain('<table');
  });

  it('renders the empty state with a next step, not a blank surface', () => {
    const markup = render();
    expect(markup).toContain(messages['members.empty']);
    expect(markup).toContain(messages['members.emptyHelp']);
  });

  describe('a failed load is not a denial', () => {
    function failed(kind: PresentedFailure['kind'], body: string): string {
      return render({
        failedLoad: true,
        loadRecovery: classifyLoad({
          failed: true,
          failure: { kind, title: null, body, offerReload: false },
        }).recovery,
        subjects: [subject()],
        failure: { kind, title: null, body, offerReload: false },
      });
    }

    it('reports an offline browser as offline, with a retry', () => {
      const markup = failed('offline', messages['app.offline.body']);
      expect(markup).toContain(messages['app.offline.body']);
      expect(markup).not.toContain(messages['members.denied']);
      expect(markup).toContain(messages['members.failed.retry']);
    });

    it('reports a server fault as a fault, with a retry', () => {
      const markup = failed('plain', messages['error.unavailable.body']);
      expect(markup).toContain(messages['error.unavailable.body']);
      expect(markup).not.toContain(messages['members.denied']);
      expect(markup).toContain(messages['members.failed.retry']);
    });

    it('offers sign-in for an ended session, never a retry that would fail again', () => {
      const markup = failed('session-ended', messages['error.expired.body']);
      expect(markup).toContain(messages['error.expired.body']);
      expect(markup).toContain(messages['error.freshSignIn.action']);
      expect(markup).not.toContain(messages['members.failed.retry']);
      expect(markup).not.toContain(messages['members.denied']);
    });

    it('offers sign-in for a stale-authentication refusal, matching its own copy', () => {
      const markup = failed('fresh-oidc', messages['error.freshSignIn.body']);
      expect(markup).toContain(messages['error.freshSignIn.body']);
      expect(markup).toContain(messages['error.freshSignIn.action']);
      expect(markup).not.toContain(messages['members.failed.retry']);
      expect(markup).not.toContain(messages['members.denied']);
    });

    it('shows no table or invite form for any failure class', () => {
      const markup = failed('plain', messages['error.unavailable.body']);
      expect(markup).not.toContain('<table');
      expect(markup).not.toContain(messages['members.invite.submit']);
      expect(markup).not.toContain('person@example.test');
    });

    it('falls back to its own copy when no failure was presented', () => {
      const markup = render({ failedLoad: true, failure: null, loadRecovery: 'retry' });
      expect(markup).toContain(messages['members.failed']);
      expect(markup).toContain(messages['members.failed.retry']);
    });
  });

  it('renders the denied state without disclosing whether members exist', () => {
    const markup = render({ denied: true, subjects: [subject()] });
    expect(markup).toContain(messages['members.denied']);
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('@');
    expect(markup).not.toContain(messages['members.empty']);
    expect(markup).not.toContain(messages['members.invite.submit']);
    expect(markup).not.toContain(messages['members.failed.retry']);
  });

  it('keeps a page failure separate from the denied state', () => {
    const markup = render({
      subjects: [subject()],
      failure: {
        kind: 'plain',
        title: null,
        body: messages['error.unavailable.body'],
        offerReload: false,
      },
    });
    expect(markup).toContain(messages['error.unavailable.body']);
    expect(markup).toContain('person@example.test');
  });
});

describe('an invitation is not a member', () => {
  const invited = invitation();

  it('names the state in words rather than by position or colour', () => {
    const markup = render({ subjects: [invited] });
    expect(markup).toContain(messages['members.state.invited']);
    expect(markup).toContain(messages['members.state.invitedHelp']);
  });

  it('offers only withdrawal, because nothing else can act on them', () => {
    const markup = render({ subjects: [invited], rooms: [ROOM] });
    expect(markup).toContain(messages['members.invite.revoke']);
    expect(markup).not.toContain(messages['members.rooms.manage']);
    expect(markup).not.toContain(messages['members.state.disable']);
    expect(markup).not.toContain(messages['members.transfer']);
  });

  it('shows no rooms for someone who has never signed in', () => {
    const markup = render({ subjects: [invited] });
    expect(markup).toContain(messages['members.rooms.none']);
    expect(markup).not.toContain(messages['members.rooms.byRole']);
  });
});

describe('what a row states about access', () => {
  it('names every role with its consequence in words', () => {
    const markup = render({
      subjects: [
        subject({ globalRole: 'owner', subjectId: 'o'.repeat(32) }),
        subject({ globalRole: 'admin', subjectId: 'd'.repeat(32) }),
        subject(),
      ],
    });
    for (const key of [
      'members.role.owner',
      'members.role.admin',
      'members.role.member',
      'members.role.owner.explain',
      'members.role.admin.explain',
      'members.role.member.explain',
    ] as const)
      expect(markup, key).toContain(messages[key]);
  });

  it('states role-derived room access rather than showing no rooms', () => {
    const markup = render({ subjects: [subject({ globalRole: 'admin' })] });
    expect(markup).toContain(messages['members.rooms.byRole']);
  });

  it('names each assigned room and role, never a bare count', () => {
    const markup = render({
      rooms: [ROOM],
      subjects: [subject({ assignments: [{ roomId: ROOM.roomId, roomRole: 'contributor' }] })],
    });
    expect(markup).toContain('Series A');
    expect(markup).toContain(messages['members.assign.contributor']);
  });

  it('lists a room outside the register instead of omitting it', () => {
    const markup = render({
      rooms: [],
      subjects: [subject({ assignments: [{ roomId: 'z'.repeat(32), roomRole: 'manager' }] })],
    });
    expect(markup).toContain(messages['members.rooms.unknown']);
    expect(markup).toContain(messages['members.assign.manager']);
    expect(markup).not.toContain(messages['members.rooms.none']);
  });

  it('offers the Owner no role or access control', () => {
    const markup = render({
      subjects: [
        subject({
          globalRole: 'owner',
          capabilities: {
            setRole: false,
            setState: false,
            assignRooms: false,
            transfer: false,
          },
        }),
      ],
    });
    expect(markup).not.toContain(messages['members.role.toMember']);
    expect(markup).not.toContain(messages['members.state.disable']);
    expect(markup).not.toContain(messages['members.transfer']);
  });

  it('offers no control at all on the acting administrator\u2019s own row', () => {
    const markup = render({
      subjects: [
        subject({
          globalRole: 'admin',
          capabilities: {
            setRole: false,
            setState: false,
            assignRooms: false,
            transfer: false,
          },
        }),
      ],
    });
    expect(markup).not.toContain(messages['members.role.toMember']);
    expect(markup).not.toContain(messages['members.state.disable']);
    expect(markup).not.toContain(messages['members.rooms.manage']);
    expect(markup).not.toContain(messages['members.transfer']);
  });

  it('offers an Admin no ownership transfer, because transfer is Owner-only', () => {
    const markup = render({
      subjects: [
        subject({
          capabilities: {
            setRole: true,
            setState: true,
            assignRooms: true,
            transfer: false,
          },
        }),
      ],
    });
    expect(markup).toContain(messages['members.state.disable']);
    expect(markup).not.toContain(messages['members.transfer']);
  });

  it('offers re-enabling a disabled member but no transfer to them', () => {
    const markup = render({
      subjects: [
        subject({
          state: 'disabled',
          capabilities: {
            setRole: true,
            setState: true,
            assignRooms: false,
            transfer: false,
          },
        }),
      ],
    });
    expect(markup).toContain(messages['members.state.enable']);
    expect(markup).toContain(messages['members.state.disabledHelp']);
    expect(markup).not.toContain(messages['members.transfer']);
  });

  it('warns that a change signs the member out, before the controls', () => {
    const markup = render({ subjects: [subject()] });
    const warning = markup.indexOf(messages['members.role.signOutWarning']);
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(markup.indexOf(messages['members.state.disable']));
  });
});

describe('a short page is not a complete one', () => {
  it('says the list is partial while a cursor remains', () => {
    const markup = render({ subjects: [subject()], hasMore: true });
    expect(markup).toContain(messages['members.page.partial']);
    expect(markup).toContain(messages['members.page.more']);
  });

  it('claims nothing about continuation once the server proved there is none', () => {
    const markup = render({ subjects: [subject()], hasMore: false });
    expect(markup).not.toContain(messages['members.page.partial']);
    expect(markup).not.toContain(messages['members.page.more']);
  });
});

describe('stacked layout keeps column meaning', () => {
  it('labels every cell with its column name', () => {
    const markup = render({
      rooms: [ROOM],
      subjects: [subject({ assignments: [{ roomId: ROOM.roomId, roomRole: 'manager' }] })],
    });
    for (const column of [
      'members.columns.person',
      'members.columns.role',
      'members.columns.state',
      'members.columns.rooms',
      'members.columns.actions',
    ] as const)
      expect(markup, column).toContain(`data-label="${messages[column]}"`);
  });

  it('labels the cells of an invitation row too', () => {
    const markup = render({ subjects: [invitation()] });
    expect(markup).toContain(`data-label="${messages['members.columns.person']}"`);
    expect(markup).toContain(`data-label="${messages['members.columns.actions']}"`);
  });

  it('keeps the real column headers in the DOM rather than removing them', () => {
    const markup = render({ subjects: [subject()] });
    expect(markup).toContain('<thead>');
    expect([...markup.matchAll(/<th scope="col">/gu)].length).toBeGreaterThanOrEqual(4);
  });

  it('renders no second visible label element that would announce values twice', () => {
    const markup = render({ subjects: [subject()] });
    expect(markup).not.toContain('df-register__label');
  });
});

describe('table semantics', () => {
  it('captions the table and scopes every header', () => {
    const markup = render({ subjects: [subject()] });
    expect(markup).toContain('<caption');
    expect(markup).toContain(`<th scope="col">${messages['members.columns.person']}</th>`);
    expect(markup).toContain('<th scope="row"');
  });

  it('labels the invite controls and describes the chosen role', () => {
    const markup = render();
    expect(markup).toMatch(/<label[^>]*for="[^"]+"[^>]*>Email address<\/label>/u);
    expect(markup).toContain(messages['members.invite.role']);
    expect(markup).toContain(messages['members.role.member.explain']);
  });

  it('shows no internal identifier, correlation id, or server code', () => {
    const markup = render({
      rooms: [ROOM],
      subjects: [subject({ assignments: [{ roomId: ROOM.roomId, roomRole: 'manager' }] })],
    });
    expect(markup).not.toContain('a'.repeat(32));
    expect(markup).not.toContain(ROOM.roomId);
    expect(markup).not.toMatch(/corr_|FORBIDDEN|42501|SQLSTATE/u);
  });
});

describe('ownership transfer preview', () => {
  const IMPACT: OwnershipTransferImpact = {
    previewId: 'p'.repeat(32),
    targetEmailDisplay: 'successor@example.test',
    confirmation: 'TRANSFER OWNERSHIP',
    message: 'server message',
    expectedRevision: 2,
    revokedAssignmentCount: 7,
    revokedAssignments: [
      { roomId: ROOM.roomId, roomTitle: 'Series A', roomRole: 'contributor' },
    ],
    revokedAssignmentsTruncated: true,
  };

  function preview(
    overrides: Partial<Parameters<typeof OwnershipTransferPreview>[0]> = {},
  ): string {
    return renderToStaticMarkup(
      <OwnershipTransferPreview
        impact={IMPACT}
        loading={false}
        pending={false}
        failure={null}
        typed=""
        describedById="consequence"
        onTypedChange={() => undefined}
        {...overrides}
      />,
    );
  }

  it('states the consequence to the acting Owner before the confirmation field', () => {
    const markup = preview();
    const consequence = markup.indexOf(messages['members.transfer.consequence']);
    expect(consequence).toBeGreaterThan(-1);
    expect(consequence).toBeLessThan(markup.indexOf('to confirm'));
  });

  it('describes the dialog by the consequence paragraph', () => {
    expect(preview()).toContain('id="consequence"');
  });

  it('names the rooms the promotion revokes, with the exact count', () => {
    const markup = preview();
    expect(markup).toContain('7 room assignment');
    expect(markup).toContain('Series A');
    expect(markup).toContain(messages['members.assign.contributor']);
    expect(markup).toContain(messages['members.transfer.revokesWhy']);
  });

  it('says the named list is capped rather than letting it read as the whole impact', () => {
    expect(preview()).toContain(messages['members.transfer.revokesTruncated']);
    expect(
      preview({ impact: { ...IMPACT, revokedAssignmentsTruncated: false } }),
    ).not.toContain(messages['members.transfer.revokesTruncated']);
  });

  it('labels both cells of the revocation table for the stacked layout', () => {
    const markup = preview();
    expect(markup).toContain(`data-label="${messages['members.transfer.columns.room']}"`);
    expect(markup).toContain(`data-label="${messages['members.transfer.columns.role']}"`);
  });

  it('keeps the real column headers rather than relying on the labels alone', () => {
    const markup = preview();
    expect(markup).toContain(
      `<th scope="col">${messages['members.transfer.columns.room']}</th>`,
    );
    expect(markup).toContain(
      `<th scope="col">${messages['members.transfer.columns.role']}</th>`,
    );
  });

  it('offers no confirmation field before the impact loads', () => {
    const markup = preview({ impact: null, loading: true });
    expect(markup).toContain(messages['members.transfer.loading']);
    expect(markup).not.toContain('to confirm');
    expect(markup).not.toContain('<input');
  });

  it('explains a near miss while it is typed, not after a rejected submit', () => {
    const near = preview({ typed: 'transfer ownership' });
    expect(near).toContain(messages['members.transfer.mismatch']);
    expect(near).toContain('aria-invalid="true"');

    const exact = preview({ typed: 'TRANSFER OWNERSHIP' });
    expect(exact).not.toContain(messages['members.transfer.mismatch']);
    expect(exact).not.toContain('aria-invalid');
  });

  it('reports a stale preview as a changed target, not a generic conflict', () => {
    const markup = preview({
      failure: {
        kind: 'conflict',
        title: messages['error.conflict.title'],
        body: messages['error.conflict.body'],
        offerReload: true,
      },
    });
    expect(markup).toContain(messages['members.transfer.stale']);
    expect(markup).not.toContain(messages['error.conflict.body']);
  });

  it('states no room count when the successor holds no assignments', () => {
    const markup = preview({
      impact: {
        ...IMPACT,
        revokedAssignmentCount: 0,
        revokedAssignments: [],
        revokedAssignmentsTruncated: false,
      },
    });
    expect(markup).toContain(messages['members.transfer.revokesNone']);
    expect(markup).not.toContain(messages['members.transfer.revokesWhy']);
  });
});

describe('a failure belongs to the operation that caused it', () => {
  const CONFLICT: PresentedFailure = {
    kind: 'conflict',
    title: messages['error.conflict.title'],
    body: messages['error.conflict.body'],
    offerReload: true,
  };

  it('reports a failed row mutation at the table, where it happened', () => {
    const member = subject();
    const markup = render({
      subjects: [member],
      changeFailure: CONFLICT,
    });
    expect(markup).toContain(messages['error.conflict.body']);
  });

  it('keeps reporting a row failure that is still true', () => {
    const member = subject();
    const markup = render({
      subjects: [member],
      changeFailure: CONFLICT,
    });
    expect(markup).toContain(messages['error.conflict.body']);
    expect(markup).toContain(messages['error.conflict.reload']);
  });
});

describe('room assignment form', () => {
  function form(overrides: Partial<Parameters<typeof MemberRoomsForm>[0]> = {}): string {
    return renderToStaticMarkup(
      <MemberRoomsForm
        rooms={[ROOM]}
        roomsComplete
        roomsLoadingMore={false}
        onLoadMoreRooms={() => undefined}
        draft={{}}
        pending={false}
        changed={false}
        withinLimit
        entryCount={0}
        entryLimit={100}
        failure={null}
        onDraftChange={() => undefined}
        {...overrides}
      />,
    );
  }

  it('warns that assignment signs the member out, before the controls', () => {
    const markup = form();
    const warning = markup.indexOf(messages['members.assign.signOutWarning']);
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(markup.indexOf('<select'));
  });

  it('labels each room control by that room and offers removal as a role', () => {
    const markup = form();
    expect(markup).toContain('Role in Series A');
    expect(markup).toContain(messages['members.assign.none']);
    expect(markup).toContain(messages['members.assign.manager']);
    expect(markup).toContain(messages['members.assign.contributor']);
  });

  it('says a draft that changes nothing changes nothing', () => {
    expect(form({ changed: false })).toContain(messages['members.assign.unchanged']);
    expect(form({ changed: true })).not.toContain(messages['members.assign.unchanged']);
  });

  /*
   * A DRAFT OVER THE BATCH BOUND SAYS SO, WITH NUMBERS.
   *
   * The server bounds assignments and revocations together, but the route's schema bounded
   * each array separately, so 60 staffings plus 60 removals passed validation and came back
   * a 400. The count and the limit are both named: "too many changes" without a number
   * leaves the administrator removing entries until it happens to work.
   */
  it('says how many changes one save may carry when the draft exceeds it', () => {
    const over = form({ changed: true, withinLimit: false, entryCount: 120, entryLimit: 100 });
    expect(over).toContain('120');
    expect(over).toContain('100');
    expect(form({ changed: true, withinLimit: true })).not.toContain('one save may carry');
  });

  it('says so when only part of the room list loaded, and offers the rest', () => {
    const markup = form({ roomsComplete: false });
    expect(markup).toContain(messages['members.assign.partialRooms']);
    expect(markup.indexOf(messages['members.assign.partialRooms'])).toBeLessThan(
      markup.indexOf('<select'),
    );
    expect(markup).toContain(messages['rooms.more']);
  });

  it('names the room continuation as pending and disables it while it runs', () => {
    const markup = form({ roomsComplete: false, roomsLoadingMore: true });
    expect(markup).toContain(messages['rooms.loadingMore']);
    expect(markup).toContain('data-busy="true"');
  });

  it('claims nothing about completeness when the whole register loaded', () => {
    const markup = form({ roomsComplete: true });
    expect(markup).not.toContain(messages['members.assign.partialRooms']);
    expect(markup).not.toContain(messages['rooms.more']);
  });

  it('reports a refused batch inside the form, with the draft intact', () => {
    const markup = form({
      failure: {
        kind: 'conflict',
        title: messages['error.conflict.title'],
        body: messages['error.conflict.body'],
        offerReload: true,
      },
    });
    expect(markup).toContain(messages['error.conflict.body']);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('<select');
  });

  it('states plainly when there are no rooms to staff anyone into', () => {
    const markup = form({ rooms: [] });
    expect(markup).toContain(messages['members.assign.noRooms']);
    expect(markup).not.toContain('<select');
  });

  it('shows no room identifier', () => {
    expect(form()).not.toContain(ROOM.roomId);
  });
});
