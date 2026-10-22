/**
 * A grant change audits the grantee stored on the grant, whatever grantee a revoke or
 * expiry request names.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpaqueId } from '@duefold/shared/ids';
import {
  migrationPool,
  directViewerId,
  deniedViewerId,
  counterpartyId,
  counterpartyGrantId,
  documentId,
  changeGrant,
  grant,
  closeParticipantGrantPools,
  seedParticipantGrants,
} from './support/participant-grants-fixture.ts';

beforeAll(seedParticipantGrants);
afterAll(closeParticipantGrantPools);

async function auditedSubject(
  action: 'revoke' | 'expiry',
  grantId: string,
  namedViewerId: string | null,
  expiresAt: Date | null,
): Promise<string | null | undefined> {
  const { auditId } = await changeGrant([
    action,
    grantId,
    null,
    namedViewerId,
    null,
    null,
    null,
    null,
    expiresAt,
  ]);
  return (
    await migrationPool.query<{ subject_id: string | null }>(
      'SELECT subject_id FROM audit_event WHERE id=$1',
      [auditId],
    )
  ).rows[0]?.subject_id;
}

describe('grant change audit subject', () => {
  it('records the viewer on the grant when the request names another viewer or none', async () => {
    const grantId = createOpaqueId();
    await grant({
      id: grantId,
      granteeKind: 'viewer',
      viewerId: deniedViewerId,
      targetKind: 'document',
      documentId,
    });
    expect(
      await auditedSubject(
        'expiry',
        grantId,
        directViewerId,
        new Date(Date.now() + 86_400_000),
      ),
    ).toBe(deniedViewerId);
    expect(await auditedSubject('revoke', grantId, null, null)).toBe(deniedViewerId);
  });

  it('records the counterparty on the grant when the request names a viewer', async () => {
    expect(await auditedSubject('revoke', counterpartyGrantId, directViewerId, null)).toBe(
      counterpartyId,
    );
  });
});
