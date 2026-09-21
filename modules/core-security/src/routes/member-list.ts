import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../authorization.ts';
import {
  readMembers,
  MAX_MEMBER_ASSIGNMENTS,
  MAX_MEMBER_PAGE_LIMIT,
  MEMBER_PAGE_LIMIT,
  type MemberSubject,
  type PendingInvitationSubject,
  type ProvisionedMemberSubject,
} from '../administration.ts';
import { protectedErrorResponses } from './error-envelope.ts';

const ID = Type.String({ pattern: '^[A-Za-z0-9_-]{32}$' });
const CURSOR = Type.Object(
  {
    createdAt: Type.String({ minLength: 20, maxLength: 64 }),
    subjectId: ID,
  },
  { additionalProperties: false },
);

const ASSIGNMENT = Type.Object(
  {
    roomId: ID,
    roomRole: Type.Union([Type.Literal('manager'), Type.Literal('contributor')]),
  },
  { additionalProperties: false },
);

const SUBJECT_IDENTITY = {
  subjectId: ID,
  emailDisplay: Type.String({ minLength: 3, maxLength: 320 }),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: Type.String({ format: 'date-time' }),
} as const;

const CAPABILITIES = Type.Object(
  {
    setRole: Type.Boolean(),
    setState: Type.Boolean(),
    assignRooms: Type.Boolean(),
    transfer: Type.Boolean(),
  },
  { additionalProperties: false },
);

const MEMBER_SUBJECT = Type.Object(
  {
    subjectKind: Type.Literal('member'),
    ...SUBJECT_IDENTITY,
    globalRole: Type.Union([
      Type.Literal('owner'),
      Type.Literal('admin'),
      Type.Literal('member'),
    ]),
    state: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
    assignments: Type.Array(ASSIGNMENT, { maxItems: MAX_MEMBER_ASSIGNMENTS }),
    capabilities: CAPABILITIES,
  },
  { additionalProperties: false },
);

const INVITATION_SUBJECT = Type.Object(
  {
    subjectKind: Type.Literal('invitation'),
    ...SUBJECT_IDENTITY,
    globalRole: Type.Union([Type.Literal('admin'), Type.Literal('member')]),
    state: Type.Literal('pending'),
  },
  { additionalProperties: false },
);

export const schema = {
  querystring: Type.Object(
    {
      limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
      afterCreatedAt: Type.Optional(Type.String({ minLength: 20, maxLength: 64 })),
      afterSubjectId: Type.Optional(ID),
    },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object(
      {
        subjects: Type.Array(Type.Union([MEMBER_SUBJECT, INVITATION_SUBJECT]), {
          maxItems: MAX_MEMBER_PAGE_LIMIT,
        }),
        nextCursor: Type.Optional(CURSOR),
      },
      { additionalProperties: false },
    ),
    ...protectedErrorResponses(),
  },
};

type Serialized<T extends { readonly createdAt: Date }> = Omit<T, 'createdAt'> & {
  readonly createdAt: string;
};

export type MemberListSubject =
  Serialized<ProvisionedMemberSubject> | Serialized<PendingInvitationSubject>;

export interface MemberListResponse {
  readonly subjects: readonly MemberListSubject[];
  readonly nextCursor?: { readonly createdAt: string; readonly subjectId: string };
}

function serialize(subject: MemberSubject): MemberListSubject {
  if (subject.subjectKind === 'invitation') {
    const { createdAt, ...invitation } = subject;
    return { ...invitation, createdAt: createdAt.toISOString() };
  }
  const { createdAt, ...member } = subject;
  return { ...member, createdAt: createdAt.toISOString() };
}

interface Query {
  readonly limit?: string;
  readonly afterCreatedAt?: string;
  readonly afterSubjectId?: string;
}

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest): Promise<MemberListResponse> => {
    const query = request.query as Query;
    const page = await readMembers({
      pool: runtime.pool,
      identity,
      limit: Number(query.limit ?? String(MEMBER_PAGE_LIMIT)),
      afterCreatedAt: query.afterCreatedAt ?? null,
      afterSubjectId: query.afterSubjectId ?? null,
    });
    return {
      subjects: page.subjects.map((subject) => serialize(subject)),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  };
}
export function handler(): never {
  throw new Error('member list route runtime not initialized');
}
