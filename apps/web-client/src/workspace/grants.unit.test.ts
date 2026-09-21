/**
 * Grant presentation and draft validation.
 *
 * The cases here are the ones where being wrong misleads a Manager about who can
 * read what: an expired grant presented as live access, a grant hidden entirely,
 * or an expiry the client accepts that the server will refuse. Every negative
 * assertion sits beside a populated positive one, so a bug that breaks both arms
 * cannot pass by making everything empty.
 */

import { describe, expect, it } from 'vitest';
import {
  counterpartyNameTaken,
  describeGrant,
  expiryInstant,
  grantableTargets,
  granteeRequest,
  hasExpiredGrant,
  isBroadChange,
  validateGrantDraft,
  type GrantDraft,
} from './grants.ts';
import type { Participant, ParticipantGrant, WorkingEntry } from '../api/client.ts';

function grant(overrides: Partial<ParticipantGrant> = {}): ParticipantGrant {
  return {
    grantId: 'g'.repeat(32),
    source: 'direct',
    targetKind: 'document',
    folderId: null,
    documentId: 'd'.repeat(32),
    expiresAt: null,
    effective: true,
    revision: 1,
    ...overrides,
  };
}

function participant(grants: readonly ParticipantGrant[]): Participant {
  return {
    viewerId: 'v'.repeat(32),
    email: 'reader@example.com',
    membershipState: 'active',
    membershipRevision: 1,
    counterpartyId: null,
    counterpartyName: null,
    grants,
  };
}

describe('describeGrant', () => {
  it('states an expired grant AS expired while an effective grant reads as active', () => {
    // Positive arm: an effective grant with an end date says "until", not "expired".
    const live = describeGrant(
      grant({ expiresAt: '2030-06-01T23:59:59.999Z', effective: true }),
      null,
    );
    expect(live.expired).toBe(false);
    expect(live.expiry).toContain('Until');
    expect(live.expiry).not.toContain('Expired');

    // Negative arm on the SAME shape: only `effective` differs.
    const expired = describeGrant(
      grant({ expiresAt: '2020-06-01T23:59:59.999Z', effective: false }),
      null,
    );
    expect(expired.expired).toBe(true);
    expect(expired.expiry).toContain('Expired');
    // The date is still stated, so a Manager can see WHEN it lapsed.
    expect(expired.expiry).toMatch(/2020/u);
  });

  it('names a grant with no end date rather than leaving the expiry blank', () => {
    const described = describeGrant(grant({ expiresAt: null }), null);
    expect(described.expiry).toBe('No end date');
    expect(described.expiry).not.toBe('');
  });

  it('attributes a counterparty grant to its counterparty and a direct grant to itself', () => {
    expect(describeGrant(grant({ source: 'counterparty' }), 'Northwind').origin).toContain(
      'Northwind',
    );
    expect(describeGrant(grant({ source: 'direct' }), 'Northwind').origin).toBe(
      'Granted directly',
    );
  });

  it('describes each target kind distinctly', () => {
    const labels = (['room', 'folder', 'document'] as const).map(
      (targetKind) => describeGrant(grant({ targetKind }), null).target,
    );
    expect(new Set(labels).size).toBe(3);
    expect(labels[0]).toContain('whole room');
  });
});

describe('hasExpiredGrant', () => {
  it('reports an expired grant among effective ones, and none when all are effective', () => {
    expect(hasExpiredGrant(participant([grant(), grant({ effective: false })]))).toBe(true);
    expect(hasExpiredGrant(participant([grant(), grant()]))).toBe(false);
    expect(hasExpiredGrant(participant([]))).toBe(false);
  });
});

describe('validateGrantDraft', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const base: GrantDraft = {
    changeAction: 'grant',
    targetKind: null,
    folderId: null,
    documentId: null,
    expiresOn: '',
  };

  it('requires a target for a grant but not for a revoke', () => {
    expect(validateGrantDraft(base, now)).toContain('target-required');
    // Populated positive arm: a complete grant draft is accepted.
    expect(validateGrantDraft({ ...base, targetKind: 'room' }, now)).toEqual([]);
    // A revoke resolves its target server-side, so none is required here.
    expect(validateGrantDraft({ ...base, changeAction: 'revoke' }, now)).toEqual([]);
  });

  it('requires the specific folder or document once that target kind is chosen', () => {
    expect(validateGrantDraft({ ...base, targetKind: 'folder' }, now)).toContain(
      'target-required',
    );
    expect(
      validateGrantDraft({ ...base, targetKind: 'folder', folderId: 'f'.repeat(32) }, now),
    ).toEqual([]);
    expect(validateGrantDraft({ ...base, targetKind: 'document' }, now)).toContain(
      'target-required',
    );
    expect(
      validateGrantDraft({ ...base, targetKind: 'document', documentId: 'd'.repeat(32) }, now),
    ).toEqual([]);
  });

  it('rejects a past expiry and accepts a future one', () => {
    const past = validateGrantDraft(
      { ...base, targetKind: 'room', expiresOn: '2025-12-31' },
      now,
    );
    expect(past).toContain('expiry-past');
    const future = validateGrantDraft(
      { ...base, targetKind: 'room', expiresOn: '2026-06-01' },
      now,
    );
    expect(future).toEqual([]);
  });

  it('accepts TODAY as an expiry, because the day is used through its end', () => {
    /*
     * A member picking today means "through today". Treating the date as midnight
     * would make their own choice invalid the moment they made it.
     */
    expect(
      validateGrantDraft({ ...base, targetKind: 'room', expiresOn: '2026-01-01' }, now),
    ).toEqual([]);
  });

  it('requires an end date for an expiry change, which is its whole purpose', () => {
    expect(validateGrantDraft({ ...base, changeAction: 'expiry' }, now)).toContain(
      'expiry-required',
    );
    expect(
      validateGrantDraft({ ...base, changeAction: 'expiry', expiresOn: '2026-06-01' }, now),
    ).toEqual([]);
  });
});

describe('expiryInstant', () => {
  it('resolves a date field to the end of that UTC day', () => {
    expect(expiryInstant('2026-06-01')?.toISOString()).toBe('2026-06-01T23:59:59.999Z');
  });

  it('rejects a malformed value rather than inventing an instant', () => {
    for (const value of ['', '2026-6-1', 'tomorrow', '2026-06-01T00:00:00Z'])
      expect(expiryInstant(value)).toBeNull();
  });
});

describe('isBroadChange', () => {
  it('treats a room grant and any counterparty grant as broad, a document grant as narrow', () => {
    const draft: GrantDraft = {
      changeAction: 'grant',
      targetKind: 'room',
      folderId: null,
      documentId: null,
      expiresOn: '',
    };
    expect(isBroadChange(draft, false)).toBe(true);
    expect(isBroadChange({ ...draft, targetKind: 'document' }, true)).toBe(true);
    expect(isBroadChange({ ...draft, targetKind: 'document' }, false)).toBe(false);
    // A revoke is resolved server-side and is not classified broad here.
    expect(isBroadChange({ ...draft, changeAction: 'revoke' }, false)).toBe(false);
  });
});

describe('granteeRequest', () => {
  it('sends exactly one grantee id, of the grantee’s kind', () => {
    expect(
      granteeRequest({ kind: 'viewer', viewerId: 'v'.repeat(32), label: 'a@example.test' }),
    ).toStrictEqual({
      granteeKind: 'viewer',
      viewerId: 'v'.repeat(32),
      counterpartyId: null,
    });
    expect(
      granteeRequest({
        kind: 'counterparty',
        counterpartyId: 'c'.repeat(32),
        label: 'Buyer A',
      }),
    ).toStrictEqual({
      granteeKind: 'counterparty',
      viewerId: null,
      counterpartyId: 'c'.repeat(32),
    });
  });
});

describe('counterpartyNameTaken', () => {
  const existing = [
    { counterpartyId: 'c'.repeat(32), name: 'Buyer A', revision: 1, viewerCount: 0 },
  ];

  it('compares after case and space normalization, as the database does', () => {
    expect(counterpartyNameTaken('  buyer a ', existing)).toBe(true);
    expect(counterpartyNameTaken('Buyer B', existing)).toBe(false);
  });

  /*
   * `canonical_structure_name` is `normalize(lower(btrim(value)), NFC)`, and PostgreSQL's
   * `btrim` strips the SPACE character alone. Trimming more here would veto a name the server
   * accepts, which is worse than letting the request go and presenting the 409: the member
   * would be told a name is taken when it is not.
   */
  it('does not treat a non-breaking space as trimmable, because the database does not', () => {
    expect(counterpartyNameTaken('\u00A0Buyer A\u00A0', existing)).toBe(false);
  });

  it('distinguishes an internal wide space, which is part of the name', () => {
    expect(counterpartyNameTaken('Buyer\u2003A', existing)).toBe(false);
  });

  /* NFC, so a decomposed accent and its composed form are one name. */
  it('treats the two spellings of an accented name as the same', () => {
    const cafe = [
      { counterpartyId: 'd'.repeat(32), name: 'Caf\u00e9', revision: 1, viewerCount: 0 },
    ];
    expect(counterpartyNameTaken('cafe\u0301', cafe)).toBe(true);
  });
});

describe('grantableTargets', () => {
  const entry = (
    id: string,
    kind: 'folder' | 'document',
    stagedRemoved: boolean,
  ): WorkingEntry =>
    ({
      entryId: id,
      resourceKind: kind,
      resourceId: id,
      documentRevision: kind === 'document' ? 2 : null,
      parentFolderId: null,
      displayName: id,
      description: '',
      revision: 1,
      stagedRemoved,
      depth: 0,
      position: 1,
      canMoveUp: false,
      canMoveDown: false,
      changeKinds: [],
      hasPublishableVersion: true,
      isPublished: true,
    }) as WorkingEntry;

  const entries = [
    entry('keep-folder', 'folder', false),
    entry('going-folder', 'folder', true),
    entry('keep-doc', 'document', false),
    entry('going-doc', 'document', true),
  ];

  /*
   * A staged removal is a pending change, so `grant_target_impact` counts nothing for it while
   * the published copy is still reachable: a review would report no affected items and the
   * grant would still expose content. Both grant surfaces have to agree on this.
   */
  it('never offers an entry staged for removal', () => {
    expect(grantableTargets(entries, 'folder').map((e) => e.entryId)).toStrictEqual([
      'keep-folder',
    ]);
    expect(grantableTargets(entries, 'document').map((e) => e.entryId)).toStrictEqual([
      'keep-doc',
    ]);
  });

  it('keeps folders and documents apart', () => {
    expect(grantableTargets(entries, 'folder').every((e) => e.resourceKind === 'folder')).toBe(
      true,
    );
  });
});
