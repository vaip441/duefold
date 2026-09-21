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
  capabilities: { setRole: true, setState: true, assignRooms: true, transfer: false },
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
    expect(page.nextCursor).toBeNull();
  });

  it('carries the capability set the server decided, without inferring it', async () => {
    stub(() => respond(200, { subjects: [SUBJECT] }));
    const first = (await loadMembers()).subjects[0];
    expect(first?.subjectKind === 'member' ? first.capabilities : null).toStrictEqual({
      setRole: true,
      setState: true,
      assignRooms: true,
      transfer: false,
    });
  });

  it('refuses a member whose capability set is absent or not boolean', async () => {
    const withoutCapabilities: Record<string, unknown> = { ...SUBJECT };
    delete withoutCapabilities['capabilities'];
    stub(() => respond(200, { subjects: [withoutCapabilities] }));
    await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);

    stub(() =>
      respond(200, {
        subjects: [{ ...SUBJECT, capabilities: { ...SUBJECT.capabilities, transfer: 'yes' } }],
      }),
    );
    await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
  });

  it('echoes the server cursor text unmodified rather than through a Date', async () => {
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
    expect(subject?.subjectKind === 'invitation' ? subject.intendedRole : null).toBe('admin');
    expect(subject).not.toHaveProperty('assignments');
  });

  describe('semantically impossible records are refused', () => {
    it('refuses an invitation that claims to be active', async () => {
      stub(() => respond(200, { subjects: [{ ...INVITATION, state: 'active' }] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses an invitation that claims to be disabled', async () => {
      stub(() => respond(200, { subjects: [{ ...INVITATION, state: 'disabled' }] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses an invitation that claims the owner role', async () => {
      stub(() => respond(200, { subjects: [{ ...INVITATION, globalRole: 'owner' }] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses an invitation carrying room assignments', async () => {
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
      stub(() => respond(200, { subjects: [{ ...INVITATION, assignments: [] }] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses an invitation whose assignments field is present but not an array', async () => {
      stub(() => respond(200, { subjects: [{ ...INVITATION, assignments: null }] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses a member that claims to be pending', async () => {
      stub(() => respond(200, { subjects: [{ ...SUBJECT, state: 'pending' }] }));
      await expect(loadMembers()).rejects.toBeInstanceOf(ApiError);
    });

    it('refuses a member with no assignment field at all', async () => {
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

  it('resolves when the server states the transfer happened and ended the session', async () => {
    stub(() => respond(200, { transferred: true, sessionEnded: true }));
    await expect(applyOwnershipTransfer(INPUT)).resolves.toBeUndefined();
  });

  it('reports a 401 as an authentication failure, because the transfer never ran', async () => {
    stub(() => respond(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } }));
    await expect(applyOwnershipTransfer(INPUT)).rejects.toMatchObject({
      failure: 'unauthenticated',
    });
  });

  it('still reports a 409 as a conflict, not as a completed transfer', async () => {
    stub(() => respond(409, { error: { code: 'CONFLICT', message: 'no' } }));
    await expect(applyOwnershipTransfer(INPUT)).rejects.toMatchObject({
      failure: 'conflict',
    });
  });

  it('refuses a 200 that does not state the transfer happened', async () => {
    stub(() => respond(200, { transferred: false }));
    await expect(applyOwnershipTransfer(INPUT)).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a 200 that omits the sign-out the transfer necessarily caused', async () => {
    stub(() => respond(200, { transferred: true }));
    await expect(applyOwnershipTransfer(INPUT)).rejects.toBeInstanceOf(ApiError);
  });

  it('carries the preview id, so apply cannot proceed on the phrase alone', async () => {
    stub(() => respond(200, { transferred: true, sessionEnded: true }));
    await applyOwnershipTransfer(INPUT);
    expect(calls.at(-1)?.body).toStrictEqual({ action: 'transfer-apply', ...INPUT });
  });
});
