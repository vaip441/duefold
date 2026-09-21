import { describe, expect, it } from 'vitest';
import { classifyFailure } from './failure-mapping.ts';

/**
 * These errors are the exact shapes PostgreSQL raises through `pg`: SQLSTATE on
 * `code`, the RAISE text on `message`. The messages are copied from the installed
 * migrations, so a wording change in SQL that breaks the stale-OIDC distinction
 * shows up here.
 */
function pgError(code: string, message: string): unknown {
  return Object.assign(new Error(message), { code });
}

describe('failure classification', () => {
  it('names a stale-OIDC refusal distinctly from an ordinary denial', () => {
    /*
     * Both are SQLSTATE 42501, so status alone cannot separate them. The client
     * must not infer the cause from which operation it called -- that labelled
     * ordinary denials "sign in again", a false recovery instruction.
     */
    const stale = classifyFailure(pgError('42501', 'fresh OIDC required'));
    expect(stale?.status).toBe(403);
    expect(stale?.body.code).toBe('FRESH_AUTHENTICATION_REQUIRED');

    const ordinary = classifyFailure(pgError('42501', 'room management forbidden'));
    expect(ordinary?.status).toBe(403);
    expect(ordinary?.body.code).toBe('FORBIDDEN');
  });

  it('never forwards the database wording and keeps 403 copy uniform', () => {
    /*
     * A denial must not disclose whether the room, folder, or document exists, so
     * every ordinary 403 reads identically regardless of which predicate refused.
     */
    const messages = [
      'room management forbidden',
      'stale or forbidden room policy',
      'installation download policy is mutation-function only',
    ].map((message) => classifyFailure(pgError('42501', message)));
    for (const [index, classified] of messages.entries()) {
      expect(classified?.body.message).toBe(messages[0]?.body.message);
      expect(classified?.body.message, String(index)).not.toContain('room management');
      expect(classified?.body.message).not.toContain('policy');
    }
  });

  it('separates validation, conflict, and unrecognized faults', () => {
    expect(classifyFailure(pgError('22023', 'invalid grant shape'))).toMatchObject({
      status: 400,
      body: { code: 'REQUEST_INVALID' },
    });
    expect(classifyFailure(pgError('23514', 'grant document room mismatch'))?.status).toBe(400);
    expect(classifyFailure(pgError('40001', 'stale room revision'))).toMatchObject({
      status: 409,
      body: { code: 'CONFLICT' },
    });
    expect(classifyFailure(pgError('55000', 'audit is append-only'))?.status).toBe(409);
    /* An already-invited or already-provisioned address. `invite_member` raises this
       deliberately, and while it was unmapped the Admin received a 500 for a refusal the
       surface should state plainly. */
    expect(
      classifyFailure(pgError('23505', 'member invitation already pending')),
    ).toMatchObject({
      status: 409,
      body: {
        code: 'CONFLICT',
        message: 'The resource changed before this request completed. Reload and try again.',
      },
    });
    // A Fastify schema rejection is a request problem, not a fault.
    expect(
      classifyFailure(Object.assign(new Error('bad'), { validation: [{}], statusCode: 400 }))
        ?.status,
    ).toBe(400);
  });

  it('returns null for a genuine fault so it stays a 500', () => {
    /*
     * The point of the mapping is that a refusal is not a fault. The inverse must
     * also hold: an unexpected error must NOT be dressed up as a clean refusal,
     * or a real defect becomes invisible.
     */
    expect(classifyFailure(new Error('connection terminated unexpectedly'))).toBeNull();
    expect(classifyFailure(pgError('08006', 'connection failure'))).toBeNull();
    expect(classifyFailure('not an error at all')).toBeNull();
  });
});
