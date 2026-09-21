import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { messages } from '../i18n/en.ts';
import {
  ConfirmationBody,
  submitEnabled,
  type Confirmation,
  type ConfirmationContent,
} from './ConfirmationDialog.tsx';

const noop = (): void => undefined;
const body = (content: ConfirmationContent, failure = null) =>
  renderToStaticMarkup(
    <ConfirmationBody
      content={content}
      consequenceId="c"
      typed=""
      pending={false}
      failure={failure}
      onTypedChange={noop}
      onReload={noop}
    />,
  );

describe('ConfirmationBody', () => {
  it('states the consequence before the field that unlocks the action', () => {
    const html = body({
      kind: 'ready',
      consequence: <p>Viewers lose access.</p>,
      confirmation: { phrase: 'ARCHIVE ROOM', confirm: () => Promise.resolve(null) },
    });
    expect(html.indexOf('Viewers lose access.')).toBeLessThan(html.indexOf('ARCHIVE ROOM'));
  });

  it('asks for nothing to be typed when the change has no phrase', () => {
    const html = body({
      kind: 'ready',
      consequence: <p>Every viewer loses access now.</p>,
      confirmation: { phrase: null, confirm: () => Promise.resolve(null) },
    });
    expect(html).not.toContain('<input');
  });

  it('reports a failed review rather than an empty dialog', () => {
    const html = body({
      kind: 'failed',
      failure: { kind: 'conflict', title: null, body: 'Changed meanwhile.', offerReload: true },
    });
    expect(html).toContain('Changed meanwhile.');
    expect(html).toContain(messages['failure.reload']);
  });
});

/**
 * The gate the dialog presses through, asserted on the same decision the button reads. A
 * typed confirmation is the last thing between an operator and a broad, hard-to-reverse
 * change, so the rule is pinned here rather than only in a browser journey.
 */
describe('submitEnabled', () => {
  const typedPhrase: Confirmation = {
    phrase: 'ALLOW ORIGINAL DOWNLOADS',
    confirm: () => Promise.resolve(null),
  };
  const singlePress: Confirmation = {
    phrase: null,
    confirm: () => Promise.resolve(null),
  };

  it('refuses until the phrase matches exactly', () => {
    expect(submitEnabled(typedPhrase, '', false)).toBe(false);
    expect(submitEnabled(typedPhrase, 'ALLOW ORIGINAL', false)).toBe(false);
    expect(submitEnabled(typedPhrase, 'allow original downloads', false)).toBe(false);
    expect(submitEnabled(typedPhrase, ' ALLOW ORIGINAL DOWNLOADS ', false)).toBe(false);
    expect(submitEnabled(typedPhrase, 'ALLOW ORIGINAL DOWNLOADS', false)).toBe(true);
  });

  it('refuses while a press is in flight, however the phrase reads', () => {
    expect(submitEnabled(typedPhrase, 'ALLOW ORIGINAL DOWNLOADS', true)).toBe(false);
    expect(submitEnabled(singlePress, '', true)).toBe(false);
  });

  it('offers a single press when no phrase is asked for, and nothing at all while reviewing', () => {
    expect(submitEnabled(singlePress, '', false)).toBe(true);
    expect(submitEnabled(null, '', false)).toBe(false);
  });
});
