/**
 * Grant presentation and validation logic, kept pure so it can be tested without
 * a browser.
 *
 * The one rule that matters here: this module NEVER decides who can read what. It
 * describes what the server reported and validates the shape of a request before
 * spending a round trip. Access is the server's decision, and an expired grant is
 * presented as expired rather than filtered out, because a Manager cannot repair
 * access they cannot see.
 */

import type {
  GrantChangeAction,
  GrantTargetKind,
  Participant,
  ParticipantGrant,
} from '../api/client.ts';
import { translate, type MessageKey } from '../i18n/translate.ts';

const TARGET_LABEL: Readonly<Record<GrantTargetKind, MessageKey>> = {
  room: 'participants.grant.room',
  folder: 'participants.grant.folder',
  document: 'participants.grant.document',
};

/** Absolute server instant, formatted without arithmetic on the browser clock. */
export function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export interface GrantDescription {
  readonly target: string;
  readonly origin: string;
  /** Expiry stated in words. An expired grant says so; it is never blank. */
  readonly expiry: string;
  readonly expired: boolean;
}

/**
 * Describes one grant in words.
 *
 * `effective: false` with an expiry in the past is an EXPIRED grant, and it is
 * labelled as such. Rendering it as ordinary access would tell a Manager that a
 * reader has access they do not have; hiding it would leave a broken grant
 * invisible and unfixable.
 */
export function describeGrant(
  grant: ParticipantGrant,
  counterpartyName: string | null,
): GrantDescription {
  const expired = !grant.effective;
  return {
    target: translate(TARGET_LABEL[grant.targetKind]),
    origin:
      grant.source === 'counterparty' && counterpartyName !== null
        ? translate('participants.grant.viaCounterparty', { name: counterpartyName })
        : translate('participants.grant.direct'),
    expiry:
      grant.expiresAt === null
        ? expired
          ? translate('participants.grant.expired', { date: '' }).trim()
          : translate('participants.grant.noExpiry')
        : translate(expired ? 'participants.grant.expired' : 'participants.grant.expires', {
            date: formatDate(grant.expiresAt),
          }),
    expired,
  };
}

/** True when any grant this participant holds has stopped being effective. */
export function hasExpiredGrant(participant: Participant): boolean {
  return participant.grants.some((grant) => !grant.effective);
}

export interface GrantDraft {
  readonly changeAction: GrantChangeAction;
  readonly targetKind: GrantTargetKind | null;
  readonly folderId: string | null;
  readonly documentId: string | null;
  /** `YYYY-MM-DD` from a date input, or empty for no expiry. */
  readonly expiresOn: string;
}

export type GrantDraftProblem = 'target-required' | 'expiry-past' | 'expiry-required';

/**
 * Validates a draft before a round trip.
 *
 * This is convenience, NOT authorization: every rule here is also enforced by the
 * server, and a draft this function accepts can still be refused. It exists so an
 * obvious omission is reported instantly instead of as an opaque 400.
 */
export function validateGrantDraft(draft: GrantDraft, now: Date): readonly GrantDraftProblem[] {
  const problems: GrantDraftProblem[] = [];
  if (draft.changeAction === 'grant') {
    if (draft.targetKind === null) problems.push('target-required');
    else if (draft.targetKind === 'folder' && draft.folderId === null)
      problems.push('target-required');
    else if (draft.targetKind === 'document' && draft.documentId === null)
      problems.push('target-required');
  }
  if (draft.changeAction === 'expiry' && draft.expiresOn === '')
    problems.push('expiry-required');
  if (draft.expiresOn !== '') {
    const parsed = expiryInstant(draft.expiresOn);
    if (parsed === null || parsed.getTime() <= now.getTime()) problems.push('expiry-past');
  }
  return problems;
}

/**
 * Converts a `YYYY-MM-DD` date field into the instant the server receives.
 *
 * The END of the chosen day is used, so choosing today means "through today"
 * rather than "expired at midnight this morning" — which is what a member means
 * when they pick a date, and avoids an expiry that is already in the past the
 * moment it is submitted.
 */
export function expiryInstant(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const parsed = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A change that widens access beyond one folder or document. */
export function isBroadChange(draft: GrantDraft, granteeIsCounterparty: boolean): boolean {
  return (
    draft.changeAction === 'grant' && (draft.targetKind === 'room' || granteeIsCounterparty)
  );
}

/**
 * A reviewed grant change waiting to be applied.
 *
 * This and `draftToRequest` lived in the panel, which meant the state owner had to
 * import from a presentation component to submit a change. They belong with the
 * other grant logic.
 */
export interface GrantSubmission {
  readonly participant: Participant;
  readonly draft: GrantDraft;
  readonly grantId?: string;
}

/** Turns a draft into request fields. The server validates them again. */
export function draftToRequest(draft: GrantDraft): {
  readonly targetKind: GrantTargetKind | null;
  readonly folderId: string | null;
  readonly documentId: string | null;
  readonly expiresAt: string | null;
} {
  const instant = draft.expiresOn === '' ? null : expiryInstant(draft.expiresOn);
  return {
    targetKind: draft.targetKind,
    folderId: draft.folderId,
    documentId: draft.documentId,
    expiresAt: instant === null ? null : instant.toISOString(),
  };
}
