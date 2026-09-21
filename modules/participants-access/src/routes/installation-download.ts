import { Type } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { protectedErrorResponses } from '../../../core-security/src/routes/error-envelope.ts';
import {
  applyInstallationDownloadPolicy,
  dryRunInstallationDownloadPolicy,
} from '../installation-settings.ts';
import type { DownloadPolicy } from '../room-settings.ts';

const POLICY = Type.Union([Type.Literal('allow'), Type.Literal('deny')]);
const REVISION = Type.Integer({ minimum: 1 });
const PHRASE = Type.String({ minLength: 1, maxLength: 200 });
const closed = { additionalProperties: false } as const;

const IMPACT = Type.Object(
  {
    currentPolicy: POLICY,
    proposedPolicy: POLICY,
    inheritingRoomCount: Type.Integer({ minimum: 0 }),
    affectedDocumentCount: Type.Integer({ minimum: 0 }),
    requiresFreshAuthentication: Type.Boolean(),
    expectedRevision: REVISION,
    confirmation: Type.Union([PHRASE, Type.Null()]),
  },
  closed,
);

/**
 * The installation download default. Allowing names the phrase it was reviewed under;
 * denying has no field for one, so the pairing the SQL refuses cannot be sent.
 */
export const schema = {
  body: Type.Union([
    Type.Object({ action: Type.Literal('dry-run'), policy: POLICY }, closed),
    Type.Object(
      {
        action: Type.Literal('apply'),
        policy: Type.Literal('allow'),
        expectedRevision: REVISION,
        confirmation: PHRASE,
      },
      closed,
    ),
    Type.Object(
      {
        action: Type.Literal('apply'),
        policy: Type.Literal('deny'),
        expectedRevision: REVISION,
      },
      closed,
    ),
  ]),
  response: {
    200: Type.Union([
      Type.Object({ impact: IMPACT }, closed),
      Type.Object({ revision: REVISION }, closed),
    ]),
    ...protectedErrorResponses(),
  },
};

type Body =
  | { readonly action: 'dry-run'; readonly policy: DownloadPolicy }
  | {
      readonly action: 'apply';
      readonly policy: 'allow';
      readonly expectedRevision: number;
      readonly confirmation: string;
    }
  | { readonly action: 'apply'; readonly policy: 'deny'; readonly expectedRevision: number };

export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return async (request: FastifyRequest) => {
    const body = request.body as Body;
    const pool = runtime.pool;
    if (body.action === 'dry-run')
      return {
        impact: await dryRunInstallationDownloadPolicy({ pool, identity, policy: body.policy }),
      };
    return body.policy === 'allow'
      ? applyInstallationDownloadPolicy({
          pool,
          identity,
          policy: 'allow',
          expectedRevision: body.expectedRevision,
          confirmation: body.confirmation,
        })
      : applyInstallationDownloadPolicy({
          pool,
          identity,
          policy: 'deny',
          expectedRevision: body.expectedRevision,
        });
  };
}

export function handler(): never {
  throw new Error('installation download route runtime not initialized');
}
