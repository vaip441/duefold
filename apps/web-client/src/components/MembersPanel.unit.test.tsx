/**
 * Member administration surface tests.
 *
 * Rendered through `react-dom/server`, which exercises the real component tree
 * without adding a DOM environment dependency, matching `AppShell.unit.test.tsx`.
 * Focus behaviour and dialog interaction belong to the Playwright suite, where a real
 * browser can make those assertions.
 *
 * What is asserted here is what the markup CLAIMS about access. Each case pins a
 * statement that would otherwise be false: an invitation rendered as a member, a
 * short page rendered as everyone, a refusal rendered as emptiness, or a state
 * carried by colour with no words behind it.
 */

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
import { classifyLoad } from '../workspace/views/load-state.ts';
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

const NOOPS = {
  onInvite: () => undefined,
  onRevokeInvitation: () => undefined,
  onRoleChange: () => undefined,
  onStateChange: () => undefined,
  onAssign: () => undefined,
  onReviewTransfer: () => undefined,
  onApplyTransfer: () => undefined,
  onCancelTransfer: () => undefined,
  onLoadMore: () => undefined,
  onReload: () => undefined,
  onSessionEnded: () => undefined,
} as const;

function render(overrides: Partial<MembersPanelProps> = {}): string {
  return renderToStaticMarkup(
    <MembersPanel
      subjects={[]}
      rooms={[]}
      loading={false}
      denied={false}
      failedLoad={false}
      loadRecovery="none"
      failure={null}
      roomsComplete
      roomsLoadingMore={false}
      onLoadMoreRooms={() => undefined}
      hasMore={false}
      loadingMore={false}
      inviteFailure={null}
      invitePending={false}
      busySubjectId={null}
      changeFailure={null}
      changeFailureOrigin={null}
      transferImpact={null}
      transferImpactPending={false}
      transferPending={false}
      transferFailure={null}
      assignmentsApplied={0}
      {...NOOPS}
      {...overrides}
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

  /*
   * Each failure class is its own state. Every one of them used to arrive as "not
   * available to your role", which named an authorization cause the failure did not have,
   * suppressed its real copy, and offered no way forward.
   */
  describe('a failed load is not a denial', () => {
    function failed(kind: PresentedFailure['kind'], body: string): string {
      return render({
        failedLoad: true,
        /* The recovery comes from `classifyLoad`, so the panel is rendered with the same
           pairing the view produces rather than one invented here. */
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
      // Retrying on a session that no longer exists produces another 401, so a reload
      // button would be an action that cannot succeed.
      const markup = failed('session-ended', messages['error.expired.body']);
      expect(markup).toContain(messages['error.expired.body']);
      expect(markup).toContain(messages['error.freshSignIn.action']);
      expect(markup).not.toContain(messages['members.failed.retry']);
      expect(markup).not.toContain(messages['members.denied']);
    });

    /*
     * The stale-authentication case is its own class with its own recovery. It read
     * "this change needs a fresh sign-in" above a button labelled "Load members again":
     * the copy named the right recovery and the only control offered the wrong one, so
     * following it reproduced the refusal and the instruction was unreachable.
     */
    it('offers sign-in for a stale-authentication refusal, matching its own copy', () => {
      const markup = failed('fresh-oidc', messages['error.freshSignIn.body']);
      expect(markup).toContain(messages['error.freshSignIn.body']);
      expect(markup).toContain(messages['error.freshSignIn.action']);
      expect(markup).not.toContain(messages['members.failed.retry']);
      // Not an ordinary denial: the member's role is not what refused this.
      expect(markup).not.toContain(messages['members.denied']);
    });

    it('shows no table or invite form for any failure class', () => {
      // The list was not read, so nothing may be presented as if it had been.
      const markup = failed('plain', messages['error.unavailable.body']);
      expect(markup).not.toContain('<table');
      expect(markup).not.toContain(messages['members.invite.submit']);
      expect(markup).not.toContain('person@example.test');
    });

    it('falls back to its own copy when no failure was presented', () => {
      const markup = render({ failedLoad: true, failure: null, loadRecovery: 'retry' });
      expect(markup).toContain(messages['members.failed']);
      /* A cause nobody established still earns a retry: the request may succeed, and
         claiming an authorization cause would be a statement nobody determined. */
      expect(markup).toContain(messages['members.failed.retry']);
    });
  });

  it('renders the denied state without disclosing whether members exist', () => {
    /*
     * The server answers a denial uniformly so it cannot be used to discover who
     * exists. An empty table beside a refusal would say "nobody", and a populated one
     * would say the opposite; neither is the surface's to claim.
     */
    const markup = render({ denied: true, subjects: [subject()] });
    expect(markup).toContain(messages['members.denied']);
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('@');
    expect(markup).not.toContain(messages['members.empty']);
    expect(markup).not.toContain(messages['members.invite.submit']);
    /* No retry: retrying a refusal is refused again, so offering one would present an
       action that cannot succeed and imply the denial might be transient. */
    expect(markup).not.toContain(messages['members.failed.retry']);
  });

  it('keeps a page failure separate from the denied state', () => {
    // A further page failed while earlier pages are on screen. Those stay, because
    // they are complete for the subjects they name.
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
    // An Admin reaches every room with no assignment. "No rooms" would be false.
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
    /*
     * Omitting it would understate this member's access, which is the one thing this
     * cell must never do. It is named as outside the loaded register instead.
     */
    const markup = render({
      rooms: [],
      subjects: [subject({ assignments: [{ roomId: 'z'.repeat(32), roomRole: 'manager' }] })],
    });
    expect(markup).toContain(messages['members.rooms.unknown']);
    expect(markup).toContain(messages['members.assign.manager']);
    expect(markup).not.toContain(messages['members.rooms.none']);
  });

  it('offers the Owner no role or access control', () => {
    // Ownership moves only through the audited transfer and the Owner cannot be
    // disabled, so either control would offer an action the server refuses.
    const markup = render({ subjects: [subject({ globalRole: 'owner' })] });
    expect(markup).not.toContain(messages['members.role.toMember']);
    expect(markup).not.toContain(messages['members.state.disable']);
    expect(markup).not.toContain(messages['members.transfer']);
  });

  it('offers re-enabling a disabled member but no transfer to them', () => {
    const markup = render({ subjects: [subject({ state: 'disabled' })] });
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
    /*
     * A page bounded by the server's assignment budget is shorter than the limit and
     * still continues, so a short table must not read as everyone.
     */
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
  /*
   * At narrow widths the stylesheet block-stacks every cell. Without a per-cell label a
   * stacked cell was an unlabelled value and an unexplained button at 320px, and the
   * stylesheet's claim that cells were labelled was not true of the markup.
   */
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
    /*
     * The headers are visually hidden by CSS at narrow widths, never `display:none`,
     * which can drop the header association from the accessibility tree. They must
     * therefore still be present in the markup for the stacked layout to be safe.
     */
    const markup = render({ subjects: [subject()] });
    expect(markup).toContain('<thead>');
    expect([...markup.matchAll(/<th scope="col">/gu)].length).toBeGreaterThanOrEqual(4);
  });

  it('renders no second visible label element that would announce values twice', () => {
    // The label is generated content from `data-label`, so there is no element carrying
    // it that a screen reader would read alongside the real header.
    const markup = render({ subjects: [subject()] });
    expect(markup).not.toContain('df-register__label');
  });
});

describe('table semantics', () => {
  it('captions the table and scopes every header', () => {
    const markup = render({ subjects: [subject()] });
    expect(markup).toContain('<caption');
    expect(markup).toContain(`<th scope="col">${messages['members.columns.person']}</th>`);
    // The person is the row header, so each cell is announced against a name.
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

  /*
   * The preview body is rendered directly rather than through its dialog. The dialog
   * is a Base UI portal, which renders nothing on the server, so asserting this copy
   * through the shell would pass against an empty string and prove nothing. Focus
   * trapping, dismissal, and the disabled submit belong to the browser suite.
   */
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
    /*
     * An Owner reaches every room, so the successor's assignments are superseded. A
     * preview that described only the role change would ask for consent to a
     * revocation it never mentioned.
     */
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

  /*
   * The revocation table stacks at 320px like every `.df-register`, and it sits in the
   * one dialog where the Owner approves an irreversible privilege loss. Without per-cell
   * labels the stacked form was a room title with an unexplained role beneath it.
   */
  it('labels both cells of the revocation table for the stacked layout', () => {
    const markup = preview();
    expect(markup).toContain(`data-label="${messages['members.transfer.columns.room']}"`);
    expect(markup).toContain(`data-label="${messages['members.transfer.columns.role']}"`);
  });

  it('keeps the real column headers rather than relying on the labels alone', () => {
    /* The headers are visually hidden at narrow widths, never removed, so the
       programmatic association survives and the labels stay presentation. */
    const markup = preview();
    expect(markup).toContain(
      `<th scope="col">${messages['members.transfer.columns.room']}</th>`,
    );
    expect(markup).toContain(
      `<th scope="col">${messages['members.transfer.columns.role']}</th>`,
    );
  });

  it('offers no confirmation field before the impact loads', () => {
    // The phrase cannot be typed before there is something for it to confirm.
    const markup = preview({ impact: null, loading: true });
    expect(markup).toContain(messages['members.transfer.loading']);
    expect(markup).not.toContain('to confirm');
    expect(markup).not.toContain('<input');
  });

  it('explains a near miss while it is typed, not after a rejected submit', () => {
    // The submit is disabled until the phrase matches, so an error shown only on
    // submit could never appear at all.
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

/**
 * Whose failure the assignment dialog is allowed to show.
 *
 * `changeFailure` is shared by role, state, invitation-revocation and assignment, so
 * without provenance the dialog displayed whatever was reported last. After any failed row
 * mutation, opening room assignment — for that member or a different one — showed the
 * unrelated error as if the draft on screen had just been rejected.
 *
 * The dialog is a Base UI portal and renders nothing on the server, so what is asserted
 * here is the table-level notice and the ORIGIN RULE the panel applies. The live dialog
 * body is covered by the browser journey.
 */
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
      changeFailureOrigin: { operation: 'role', subjectId: member.subjectId },
    });
    expect(markup).toContain(messages['error.conflict.body']);
  });

  it('keeps reporting a row failure that is still true', () => {
    /* Cleared on the next attempt by the hook, not by opening an unrelated surface: a
       refusal that has not been superseded is still the last thing that happened. */
    const member = subject();
    const markup = render({
      subjects: [member],
      changeFailure: CONFLICT,
      changeFailureOrigin: { operation: 'state', subjectId: member.subjectId },
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
    /*
     * Removal is the "not staffed" option, so assignment and revocation are chosen in
     * the same control and the resulting set is the one on screen.
     */
    const markup = form();
    expect(markup).toContain('Role in Series A');
    expect(markup).toContain(messages['members.assign.none']);
    expect(markup).toContain(messages['members.assign.manager']);
    expect(markup).toContain(messages['members.assign.contributor']);
  });

  it('says a draft that changes nothing changes nothing', () => {
    // A batch with no change still revokes the member's sessions, so an inert submit
    // has to be explained rather than silently doing nothing.
    expect(form({ changed: false })).toContain(messages['members.assign.unchanged']);
    expect(form({ changed: true })).not.toContain(messages['members.assign.unchanged']);
  });

  /*
   * The register is paged, so "Not staffed" is an answer about the rooms shown. A prefix
   * presented as the whole list would let a room the administrator never received read as
   * a room this member is not in.
   */
  it('says so when only part of the room list loaded, and offers the rest', () => {
    const markup = form({ roomsComplete: false });
    expect(markup).toContain(messages['members.assign.partialRooms']);
    // Before the controls, so the caveat is read while the choice is made.
    expect(markup.indexOf(messages['members.assign.partialRooms'])).toBeLessThan(
      markup.indexOf('<select'),
    );
    /*
     * The ACTION that resolves the caveat, inside the dialog where staffing is decided.
     * The register used to be walked to an arbitrary page cap and stored as terminal, so
     * this notice disclosed a limitation the administrator could do nothing about while
     * rooms past the cap could not be staffed at all.
     */
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
    /* No continuation control: the server proved there is nothing further to load. */
    expect(markup).not.toContain(messages['rooms.more']);
  });

  it('reports a refused batch inside the form, with the draft intact', () => {
    /*
     * The dialog stays open until the batch resolves. Reporting the failure behind the
     * table would have discarded a multi-room draft and asked for it again from memory.
     */
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
    // The controls are still there, so the draft can be corrected and resubmitted.
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
