import type { Pool } from 'pg';
import type { GlobalRole, MemberIdentity, RoomRole } from './authorization.ts';
import {
  MAX_MEMBER_ASSIGNMENTS,
  MAX_MEMBER_PAGE_LIMIT,
  MEMBER_PAGE_LIMIT,
  type AssignableGlobalRole,
  type MemberPage,
  type MemberState,
  type MemberSubject,
  type RoomAssignment,
  type SubjectCapabilities,
} from './administration-types.ts';

interface MemberRow {
  readonly subject_kind: string;
  readonly subject_id: string;
  readonly email_display: string;
  readonly global_role: string;
  readonly state: string;
  readonly revision: number;
  readonly created_at: Date;
  readonly cursor_created_at: string;
  readonly assignments: readonly { readonly roomId: string; readonly roomRole: string }[];
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly continues: boolean;
}

const GLOBAL_ROLES: readonly GlobalRole[] = ['owner', 'admin', 'member'];
const MEMBER_STATES: readonly MemberState[] = ['active', 'disabled'];
const ASSIGNABLE_ROLES: readonly AssignableGlobalRole[] = ['admin', 'member'];
const ROOM_ROLES: readonly RoomRole[] = ['manager', 'contributor'];

function oneOf<T extends string>(allowed: readonly T[], value: string, failure: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new Error(failure);
  return value as T;
}

function parseAssignments(row: MemberRow): readonly RoomAssignment[] {
  if (row.assignments.length > MAX_MEMBER_ASSIGNMENTS)
    throw new Error('MEMBER_ASSIGNMENT_BOUND_EXCEEDED');
  return row.assignments.map((assignment) => ({
    roomId: assignment.roomId,
    roomRole: oneOf(ROOM_ROLES, assignment.roomRole, 'ROOM_ROLE_UNKNOWN'),
  }));
}

function parseCapabilities(row: MemberRow): SubjectCapabilities {
  const flag = (key: keyof SubjectCapabilities): boolean => {
    const value = row.capabilities[key];
    if (typeof value !== 'boolean') throw new Error('MEMBER_CAPABILITY_UNKNOWN');
    return value;
  };
  return {
    setRole: flag('setRole'),
    setState: flag('setState'),
    assignRooms: flag('assignRooms'),
    transfer: flag('transfer'),
  };
}

function parseSubjectRow(row: MemberRow): MemberSubject {
  const identity = {
    subjectId: row.subject_id,
    emailDisplay: row.email_display,
    revision: row.revision,
    createdAt: row.created_at,
  };
  if (row.subject_kind === 'member')
    return {
      subjectKind: 'member',
      ...identity,
      globalRole: oneOf(GLOBAL_ROLES, row.global_role, 'GLOBAL_ROLE_UNKNOWN'),
      state: oneOf(MEMBER_STATES, row.state, 'MEMBER_STATE_UNKNOWN'),
      assignments: parseAssignments(row),
      capabilities: parseCapabilities(row),
    };
  if (row.subject_kind === 'invitation') {
    if (row.state !== 'pending') throw new Error('MEMBER_STATE_UNKNOWN');
    if (row.assignments.length > 0) throw new Error('INVITATION_ASSIGNMENTS_PRESENT');
    return {
      subjectKind: 'invitation',
      ...identity,
      state: 'pending',
      globalRole: oneOf(ASSIGNABLE_ROLES, row.global_role, 'INVITATION_ROLE_UNKNOWN'),
    };
  }
  throw new Error('MEMBER_SUBJECT_KIND_UNKNOWN');
}

export async function readMembers(input: {
  readonly pool: Pool;
  readonly identity: MemberIdentity;
  readonly afterCreatedAt?: string | null;
  readonly afterSubjectId?: string | null;
  readonly limit?: number;
}): Promise<MemberPage> {
  const limit = input.limit ?? MEMBER_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MEMBER_PAGE_LIMIT)
    throw new Error('MEMBER_PAGE_LIMIT_REJECTED');

  const page = await input.pool.query<MemberRow>('SELECT * FROM read_members($1,$2,$3,$4)', [
    input.identity.id,
    input.afterCreatedAt ?? null,
    input.afterSubjectId ?? null,
    limit,
  ]);
  const lastRow = page.rows.at(-1);
  return {
    subjects: page.rows.map(parseSubjectRow),
    ...(lastRow?.continues === true
      ? {
          nextCursor: {
            createdAt: lastRow.cursor_created_at,
            subjectId: lastRow.subject_id,
          },
        }
      : {}),
  };
}
