import { errorCodes } from 'fastify';
import { describe, expect, it } from 'vitest';
import { InvalidEmailError } from '@duefold/shared/email';
import { InvalidSupportContactError } from '@duefold/shared/support-contact';
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
  it('names both database and application stale-OIDC refusals', () => {
    /*
     * Both are SQLSTATE 42501, so status alone cannot separate them. The client
     * must not infer the cause from which operation it called -- that labelled
     * ordinary denials "sign in again", a false recovery instruction.
     */
    const stale = classifyFailure(pgError('42501', 'fresh OIDC required'));
    expect(stale?.status).toBe(403);
    expect(stale?.body.code).toBe('FRESH_AUTHENTICATION_REQUIRED');
    expect(classifyFailure(new Error('FRESH_OIDC_REQUIRED'))).toEqual(stale);

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
    /* A cursor timestamp PostgreSQL cannot cast, or one out of range. */
    for (const sqlState of ['22007', '22008'])
      expect(
        classifyFailure(pgError(sqlState, 'invalid input syntax for type timestamp')),
      ).toMatchObject({ status: 400, body: { code: 'REQUEST_INVALID' } });
    for (const bound of ['bulk item bound exceeded', 'sibling rebalance bound exceeded'])
      expect(classifyFailure(pgError('54000', bound))).toEqual({
        status: 400,
        body: { code: 'REQUEST_INVALID', message: 'The request could not be accepted.' },
      });
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

  it('names an export too large to archive instead of a generic invalid request', () => {
    expect(classifyFailure(pgError('54000', 'EXPORT_TOO_LARGE'))).toEqual({
      status: 400,
      body: { code: 'EXPORT_TOO_LARGE', message: 'The export is too large for one archive.' },
    });
  });

  it('answers an unavailable protected page as not found, whether absent or denied', () => {
    expect(classifyFailure(new Error('PROTECTED_PAGE_UNAVAILABLE'))).toEqual({
      status: 404,
      body: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
    });
  });

  it('answers ordinary refusals with uniform copy instead of a fault', () => {
    expect(classifyFailure(new InvalidEmailError())).toEqual({
      status: 400,
      body: { code: 'REQUEST_INVALID', message: 'The request could not be accepted.' },
    });
    expect(classifyFailure(new Error('ROOM_WORKSPACE_FORBIDDEN'))).toEqual({
      status: 403,
      body: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
    expect(classifyFailure(new Error('STRUCTURE_ENTRY_UNREACHABLE'))).toEqual({
      status: 409,
      body: {
        code: 'CONFLICT',
        message: 'The resource changed before this request completed. Reload and try again.',
      },
    });
    expect(classifyFailure(new Error('ORDER_BOUNDS_INVALID'))).toMatchObject({
      status: 409,
      body: { code: 'CONFLICT' },
    });
  });

  it('answers download and upload refusals uniformly instead of as faults', () => {
    // The reading room shows its expired-download copy for this denial.
    expect(classifyFailure(new Error('DOWNLOAD_UNAVAILABLE'))).toEqual({
      status: 403,
      body: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
    });
    for (const code of [
      'UPLOAD_FORBIDDEN',
      'UPLOAD_IDENTITY_MISMATCH',
      'BRANDING_UPLOAD_FORBIDDEN',
    ])
      expect(classifyFailure(new Error(code)), code).toMatchObject({
        status: 403,
        body: { code: 'FORBIDDEN' },
      });
    for (const code of ['UPLOAD_INTENT_INVALID', 'UPLOAD_INTENT_EXPIRED'])
      expect(classifyFailure(new Error(code)), code).toMatchObject({
        status: 409,
        body: { code: 'CONFLICT' },
      });
    for (const code of [
      'RANGE_INVALID',
      'SOURCE_TYPE_REJECTED',
      'SOURCE_NAME_REJECTED',
      'DISPLAY_TITLE_REJECTED',
      'FORMAT_DISABLED_BY_RELEASE',
      'PART_PLAN_REJECTED',
      'PART_CHECKSUM_REJECTED',
      'UPLOAD_PARTS_MISMATCH',
      'UPLOAD_STORAGE_METADATA_MISMATCH',
      'BRANDING_UPLOAD_PARTS_MISMATCH',
      'BRANDING_UPLOAD_METADATA_MISMATCH',
    ])
      expect(classifyFailure(new Error(code)), code).toEqual({
        status: 400,
        body: { code: 'REQUEST_INVALID', message: 'The request could not be accepted.' },
      });
  });

  it('answers route-reachable validation and eligibility refusals instead of faults', () => {
    for (const code of [
      'MANUAL_RETRY_FORBIDDEN',
      'FAILED_SOURCE_DELETE_FORBIDDEN',
      'EXPORT_DOWNLOAD_FORBIDDEN',
    ])
      expect(classifyFailure(new Error(code)), code).toEqual({
        status: 403,
        body: { code: 'FORBIDDEN', message: 'This action is not available to you.' },
      });
    for (const error of [
      ...[
        'STRUCTURE_NAME_REJECTED',
        'STRUCTURE_DESCRIPTION_REJECTED',
        'BRAND_ORGANIZATION_INVALID',
        'BRAND_SENDER_INVALID',
        'BRAND_INTRODUCTION_INVALID',
        'BRAND_SUPPORT_INVALID',
        'BRAND_ACCENT_CONTRAST_FAILED',
        'EXTERNAL_LINK_UNSAFE',
        'EXPORT_SELECTION_INVALID',
        'GRANT_ID_REQUIRED',
      ].map((code) => new Error(code)),
      new InvalidSupportContactError(),
    ])
      expect(classifyFailure(error), error.message).toEqual({
        status: 400,
        body: { code: 'REQUEST_INVALID', message: 'The request could not be accepted.' },
      });
  });

  it('answers every Fastify request error as an invalid request', () => {
    for (const error of [
      new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE(),
      new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE(),
    ])
      expect(classifyFailure(error), error.code).toEqual({
        status: 400,
        body: { code: 'REQUEST_INVALID', message: 'The request could not be accepted.' },
      });
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
    // A stored order key that does not parse is corrupt data, not a moved entry.
    expect(classifyFailure(new Error('STRUCTURE_ORDER_KEY_INVALID'))).toBeNull();
    for (const code of ['STORAGE_KEY_MISMATCH', 'DOWNLOAD_STREAM_LENGTH_MISMATCH'])
      expect(classifyFailure(new Error(code)), code).toBeNull();
    expect(
      classifyFailure(Object.assign(new Error('upstream'), { statusCode: 503 })),
    ).toBeNull();
  });
});
