/**
 * Administration API parsing tests.
 *
 * These assert the properties that decide whether this surface tells the truth
 * about access, not that the parser round-trips JSON:
 *
 * - A role, state, or room role the server did not send is a FAILURE, never a
 *   rendered row. Substituting a guess would show access the server never described.
 * - The keyset cursor is echoed unmodified, because re-serializing PostgreSQL's
 *   microsecond timestamp through a millisecond `Date` would move the cursor earlier
 *   than the row it came from and skip every subject tied at that microsecond.
 * - A 401 is the documented outcome of a COMPLETED ownership transfer, and only of
 *   that one call. Anywhere else it keeps its ordinary meaning.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyOwnershipTransfer,
  dryRunOwnershipTransfer,
  loadMembers,
  revokeMemberInvitation,
  setMemberRole,
  ApiError,
} from './client.ts';

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

const calls: Call[] = [];

function respond(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    clone: () => respond(status, payload),
  } as unknown as Response;
}

function stub(reply: (call: Call) => Response): void {
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    const call: Call = {
      path,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return Promise.resolve(reply(call));
  });
}

const SUBJECT = {
  subjectKind: 'member',
  subjectId: 'a'.repeat(32),
  emailDisplay: 'Person@example.test',
  globalRole: 'member',
  state: 'active',
  revision: 3,
  createdAt: '2026-09-20T10:00:00.000Z',
  assignments: [{ roomId: 'b'.repeat(32), roomRole: 'manager' }],
};

const INVITATION = {
  subjectKind: 'invitation',
  subjectId: 'i'.repeat(32),
  emailDisplay: 'Invited@example.test',
  globalRole: 'admin',
  state: 'pending',
  revision: 1,
  createdAt: '2026-09-20T11:00:00.000Z',
};

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('document', { cookie: '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadMembers', () => {
  it('parses a page and keeps the absent cursor distinct from a present one', async () => {
    stub(() => respond(200, { subjects: [SUBJECT] }));
    const page = await loadMembers();
    expect(page.subjects).toHaveLength(1);
    const first = page.subjects[0];
    expect(first?.subjectKind === 'member' ? first.assignments : null).toStrictEqual([
      { roomId: 'b'.repeat(32), roomRole: 'manager' },
    ]);
    // Absent means "provably the last page", which is not the same as unknown.
    expect(page.nextCursor).toBeNull();
  });

  it('echoes the server cursor text unmodified rather than through a Date', async () => {
    /*
     * PostgreSQL renders microseconds and a space separator. A client that parsed
     * and re-serialized this would truncate to milliseconds, and in descending order
     * every subject tied at that microsecond would be skipped silently.
     */
    const cursor = { createdAt: '2026-09-20 10:00:00.123456+00', subjectId: 'c'.repeat(32) };
    stub(() => respond(200, { subjects: [SUBJECT], nextCursor: cursor }));
    const page = await loadMembers();
    expect(page.nextCursor).toStrictEqual(cursor);

    stub(() => respond(200, { subjects: [] }));
    await loadMembers({ after: cursor });
    const request = calls.at(-1);
    expect(request?.path).toContain(`afterCreatedAt=${encodeURIComponent(cursor.createdAt)}`);
    expect(request?.path).toContain(`afterSubjectId=${cursor.subjectId}`);
  });

  it('sends both cursor components together, never half of one', async () => {
    stub(() => respond(200, { subjects: [] }));
    await loadMembers();
    expect(calls.at(-1)?.path).toBe('/api/members');
  });

  it('refuses a global role it does not recognize instead of rendering it', async () => {
    stub(() => respond(200, { subjects: [{ ...SUBJECT, globalRole: 'superuser' }] }));
    await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses an unrecognized subject state and room role', async () => {
    stub(() => respond(200, { subjects: [{ ...SUBJECT, state: 'suspended' }] }));
    await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);

    stub(() =>
      respond(200, {
        subjects: [
          { ...SUBJECT, assignments: [{ roomId: 'b'.repeat(32), roomRole: 'owner' }] },
        ],
      }),
    );
    await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
  });

  it('keeps an invitation distinct from a member', async () => {
    stub(() => respond(200, { subjects: [INVITATION] }));
    const page = await loadMembers();
    const subject = page.subjects[0];
    expect(subject?.subjectKind).toBe('invitation');
    expect(subject?.state).toBe('pending');
    /*
     * The role an invitation names is the one they WILL hold, and it is carried under a
     * different name so no surface can read it as a role held now.
     */
    expect(subject?.subjectKind === 'invitation' ? subject.intendedRole : null).toBe('admin');
    /* No `assignments` at all: an invitation has no member row, so nothing could hold a
       room privilege against it, and an empty array would still invite the reading that
       they hold no rooms *yet*. */
    expect(subject).not.toHaveProperty('assignments');
  });

  /*
   * Each case here is a record the server should never send and that the surface must
   * never render. Validating fields independently accepted all of them, and each one is
   * a false statement about who can reach what.
   */
  describe('semantically impossible records are refused', () => {
    it('refuses an invitation that claims to be active', async () => {
      // Active means signed in. An invitation names someone who has not.
      stub(() => respond(200, { subjects: [{ ...INVITATION, state: 'active' }] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses an invitation that claims to be disabled', async () => {
      stub(() => respond(200, { subjects: [{ ...INVITATION, state: 'disabled' }] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses an invitation that claims the owner role', async () => {
      // Ownership moves only through the audited transfer, so no invitation can name it.
      stub(() => respond(200, { subjects: [{ ...INVITATION, globalRole: 'owner' }] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses an invitation carrying room assignments', async () => {
      /*
       * A room privilege attached to someone with no member row. Rendering it would put
       * a room on a row for a person who cannot hold one.
       */
      stub(() =>
        respond(200, {
          subjects: [
            {
              ...INVITATION,
              assignments: [{ roomId: 'b'.repeat(32), roomRole: 'manager' }],
            },
          ],
        }),
      );
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses an invitation carrying an EMPTY assignment array', async () => {
      /*
       * The canonical wire union closes the invitation object with
       * `additionalProperties: false`, so the server cannot send this field at all.
       * Accepting an empty array and silently dropping it made the client and the schema
       * disagree about what is representable, and repaired a malformed response instead of
       * reporting it — the exact silent substitution this parser exists to prevent.
       */
      stub(() => respond(200, { subjects: [{ ...INVITATION, assignments: [] }] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses an invitation whose assignments field is present but not an array', async () => {
      // Present at all is the contradiction; its type does not make it less of one.
      stub(() => respond(200, { subjects: [{ ...INVITATION, assignments: null }] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses a member that claims to be pending', async () => {
      // `pending` belongs to an invitation; `member.state='invited'` is unreachable.
      stub(() => respond(200, { subjects: [{ ...SUBJECT, state: 'pending' }] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses a member with no assignment field at all', async () => {
      /* A member's complete active set is required. An absent field would read as "no
         rooms", which is a claim about access rather than an absence of data. */
      const { assignments, ...withoutAssignments } = SUBJECT;
      expect(assignments).toHaveLength(1);
      stub(() => respond(200, { subjects: [withoutAssignments] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses an unknown subject kind rather than guessing one', async () => {
      stub(() => respond(200, { subjects: [{ ...SUBJECT, subjectKind: 'service-account' }] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });
  });
});

describe('revokeMemberInvitation', () => {
  it('accepts 204 without a body rather than reporting a completed revocation as a fault', async () => {
    stub(() => respond(204, null));
    await expect(revokeMemberInvitation('d'.repeat(32))).resolves.toBeUndefined();
    expect(calls.at(-1)?.body).toStrictEqual({
      action: 'revoke-invitation',
      invitationId: 'd'.repeat(32),
    });
  });
});

describe('setMemberRole', () => {
  it('returns the new revision so the next optimistic write is not stale', async () => {
    stub(() => respond(200, { memberId: 'a'.repeat(32), revision: 4 }));
    await expect(
      setMemberRole({ memberId: 'a'.repeat(32), role: 'admin', expectedRevision: 3 }),
    ).resolves.toStrictEqual({ memberId: 'a'.repeat(32), revision: 4 });
  });

  it('keeps a 401 on an ordinary call as an expired session', async () => {
    // The transfer-apply mapping must not leak to any other call: a 401 there would
    // become a false success.
    stub(() => respond(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } }));
    await expect(
      setMemberRole({ memberId: 'a'.repeat(32), role: 'admin', expectedRevision: 3 }),
    ).rejects.toMatchObject({ failure: 'unauthenticated' });
  });
});

describe('dryRunOwnershipTransfer', () => {
  const IMPACT = {
    previewId: 'e'.repeat(32),
    targetEmailDisplay: 'Successor@example.test',
    confirmation: 'TRANSFER OWNERSHIP',
    message: 'You become an Admin.',
    expectedRevision: 3,
    revokedAssignmentCount: 2,
    revokedAssignments: [
      { roomId: 'b'.repeat(32), roomTitle: 'Series A', roomRole: 'contributor' },
    ],
    revokedAssignmentsTruncated: true,
  };

  it('keeps the exact count and the truncation flag rather than deriving either', async () => {
    /*
     * The named list is capped because it carries titles; the count stays exact. A
     * client that derived the count from the list would understate a privilege
     * revocation the Owner is being asked to approve.
     */
    stub(() => respond(200, { impact: IMPACT }));
    const impact = await dryRunOwnershipTransfer('a'.repeat(32));
    expect(impact.revokedAssignmentCount).toBe(2);
    expect(impact.revokedAssignments).toHaveLength(1);
    expect(impact.revokedAssignmentsTruncated).toBe(true);
  });

  it('refuses an impact whose truncation flag is missing', async () => {
    const { revokedAssignmentsTruncated, ...partial } = IMPACT;
    expect(revokedAssignmentsTruncated).toBe(true);
    stub(() => respond(200, { impact: partial }));
    await expect(dryRunOwnershipTransfer('a'.repeat(32))).rejects.toBeInstanceOf(ApiError);
  });
});

describe('applyOwnershipTransfer', () => {
  const INPUT = {
    memberId: 'a'.repeat(32),
    previewId: 'e'.repeat(32),
    expectedRevision: 3,
    confirmation: 'TRANSFER OWNERSHIP',
  };

  it('reports a normal response as a completed transfer that ended the session', async () => {
    stub(() => respond(200, { transferred: true, sessionEnded: true }));
    await expect(applyOwnershipTransfer(INPUT)).resolves.toStrictEqual({
      outcome: 'session-ended',
    });
  });

  it('treats a 401 as the documented outcome of a completed transfer', async () => {
    /*
     * The transfer revokes the acting Owner's sessions inside its own transaction, so
     * the response can arrive after the session row is gone. That is success, and
     * rendering it as an authentication error would tell the Owner the transfer
     * failed when it did not.
     */
    stub(() => respond(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } }));
    await expect(applyOwnershipTransfer(INPUT)).resolves.toStrictEqual({
      outcome: 'session-ended',
    });
  });

  it('still reports a 409 as a conflict, not as a completed transfer', async () => {
    // The target changed after the preview, so nothing happened. Mapping this to
    // success would claim a transfer the server refused.
    stub(() => respond(409, { error: { code: 'CONFLICT', message: 'no' } }));
    await expect(applyOwnershipTransfer(INPUT)).rejects.toMatchObject({
      failure: 'conflict',
    });
  });

  it('refuses a 200 that does not state the transfer happened', async () => {
    stub(() => respond(200, { transferred: false }));
    await expect(applyOwnershipTransfer(INPUT)).rejects.toBeInstanceOf(ApiError);
  });

  it('carries the preview id, so apply cannot proceed on the phrase alone', async () => {
    stub(() => respond(200, { transferred: true, sessionEnded: true }));
    await applyOwnershipTransfer(INPUT);
    expect(calls.at(-1)?.body).toStrictEqual({ action: 'transfer-apply', ...INPUT });
  });
});
