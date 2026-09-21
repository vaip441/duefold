import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { messages } from '../i18n/en.ts';
import { canSubmitRoomTitle, NewRoomForm } from './NewRoomDialog.tsx';

const noop = (): void => undefined;
const form = (overrides: Partial<Parameters<typeof NewRoomForm>[0]> = {}) =>
  renderToStaticMarkup(
    <NewRoomForm
      formId="f"
      title=""
      description=""
      pending={false}
      failure={null}
      onTitleChange={noop}
      onDescriptionChange={noop}
      onSubmit={noop}
      {...overrides}
    />,
  );

describe('NewRoomForm', () => {
  it('says the room starts as a draft before anything is submitted', () => {
    expect(form()).toContain(messages['rooms.new.explain']);
  });

  it('shows a refusal inside the form it belongs to', () => {
    const html = form({
      failure: { kind: 'denied', title: null, body: 'Refused here.', offerReload: false },
    });
    expect(html).toContain('Refused here.');
  });
});

describe('canSubmitRoomTitle', () => {
  it('refuses only a blank title; every other rule is the server’s', () => {
    expect(canSubmitRoomTitle('   ')).toBe(false);
    expect(canSubmitRoomTitle('Series B')).toBe(true);
  });
});
