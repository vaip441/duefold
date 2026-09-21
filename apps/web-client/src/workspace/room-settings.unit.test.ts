import { describe, expect, it } from 'vitest';
import type { RoomSettings } from '../api/client.ts';
import {
  expiryDisplay,
  formatByteSize,
  parseExpiryField,
  readFor,
  visibilityNotes,
} from './room-settings.ts';

const base: RoomSettings = {
  roomId: 'r'.repeat(32),
  state: 'draft',
  revision: 1,
  publishedRevision: 0,
  auditRetentionYears: 7,
  defaultGrantExpiresAt: null,
  downloadPolicy: null,
  installationDownloadPolicy: 'deny',
  purge: null,
  capabilities: {
    publish: false,
    archive: true,
    returnToDraft: false,
    setRetention: false,
    schedulePurge: false,
    cancelPurge: false,
  },
};

describe('visibilityNotes', () => {
  it('explains why a never-published draft cannot be published yet', () => {
    expect(visibilityNotes(base)).toStrictEqual(['settings.visibility.publishStructureFirst']);
  });

  it('explains why a room held by its purge cannot return to draft', () => {
    expect(
      visibilityNotes({
        ...base,
        state: 'archived',
        publishedRevision: 1,
        purge: {
          purgeId: 'p'.repeat(32),
          state: 'scheduled',
          purgeAfter: '2026-10-21T00:00:00.000Z',
        },
      }),
    ).toStrictEqual(['settings.visibility.pinnedByPurge']);
  });
});

describe('readFor', () => {
  const ready = { roomId: 'a'.repeat(32), load: { kind: 'ready', value: 7 } } as const;

  it('shows nothing when no room is open', () => {
    expect(readFor(ready, null)).toBeNull();
  });

  it('shows the read that describes the room being asked about', () => {
    expect(readFor(ready, ready.roomId)).toStrictEqual(ready.load);
  });

  /*
   * THE CASE THAT MATTERS. Opening room B while room A's request is still in flight, then A
   * resolving: the reader still holds A's row, and answering it here would put one room's
   * revision, capabilities and state on another room's surface — every optimistic-concurrency
   * write from that surface would then carry the wrong expectation.
   */
  it('reports loading rather than another room\u2019s value when a late read arrives', () => {
    expect(readFor(ready, 'b'.repeat(32))).toStrictEqual({ kind: 'loading' });
  });

  it('reports loading before any read has arrived', () => {
    expect(readFor(null, 'b'.repeat(32))).toStrictEqual({ kind: 'loading' });
  });

  /* A failed read is still that room's answer, so it is shown rather than replaced by
     loading: an unreachable room must not look like one that has not answered yet. */
  it('keeps a failed read for the room it belongs to', () => {
    const failed = {
      roomId: 'c'.repeat(32),
      load: { kind: 'failed', failure: 'No.' },
    } as const;
    expect(readFor(failed, failed.roomId)).toStrictEqual(failed.load);
  });
});

describe('expiryDisplay', () => {
  /* Seconds included, because an expiry is the END of the chosen day: shown to the minute,
     the value displayed would not be the value the review promised. */
  it('always carries the exact UTC instant beside the localized one', () => {
    expect(expiryDisplay('2027-09-21T23:59:59.999+00:00').utc).toBe('2027-09-21 23:59:59 UTC');
  });
});

describe('parseExpiryField', () => {
  it('reads empty as no default and a date as the end of that UTC day', () => {
    expect(parseExpiryField('')).toStrictEqual({ ok: true, expiresAt: null });
    expect(parseExpiryField('2027-09-21')).toStrictEqual({
      ok: true,
      expiresAt: '2027-09-21T23:59:59.999Z',
    });
  });

  it('never turns an unreadable date into no default', () => {
    expect(parseExpiryField('21/09/2027')).toStrictEqual({ ok: false });
  });
});

describe('formatByteSize', () => {
  it.each([
    [512, '512 B'],
    [2_500_000, '2.5 MB'],
    [3 * 1024 ** 3, '3.2 GB'],
  ])('formats %i', (bytes, text) => {
    expect(formatByteSize(bytes)).toBe(text);
  });
});

describe('parseExpiryField', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');

  it('treats an empty field as no default rather than a mistake', () => {
    expect(parseExpiryField('', now)).toStrictEqual({ ok: true, expiresAt: null });
  });

  it('sends the end of the chosen day, so choosing today means through today', () => {
    expect(parseExpiryField('2026-12-31', now)).toStrictEqual({
      ok: true,
      expiresAt: '2026-12-31T23:59:59.999Z',
    });
  });

  /* `new Date` turns 31 February into 3 March. Storing a different day than the one chosen
     is worse than refusing, so the round trip has to agree. */
  it('refuses a date that does not exist instead of moving it', () => {
    expect(parseExpiryField('2027-02-31', now)).toStrictEqual({ ok: false });
  });

  /* The server answers 400 for a past instant. Refusing here means the reason is shown
     beside the field rather than arriving as a rejection. */
  it('refuses an instant that has already passed', () => {
    expect(parseExpiryField('2026-09-20', now)).toStrictEqual({ ok: false });
    expect(parseExpiryField('2020-01-01', now)).toStrictEqual({ ok: false });
  });

  it('refuses text that is not a date at all', () => {
    for (const value of ['tomorrow', '2026-9-1', '2026-09', '']) {
      const parsed = parseExpiryField(value, now);
      if (value === '') expect(parsed.ok).toBe(true);
      else expect(parsed).toStrictEqual({ ok: false });
    }
  });
});
