import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { messages } from '../i18n/en.ts';
import { ConfirmationBody, type ConfirmationContent } from './ConfirmationDialog.tsx';

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
