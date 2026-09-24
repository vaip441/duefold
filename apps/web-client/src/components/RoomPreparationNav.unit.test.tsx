import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { messages } from '../i18n/en.ts';
import { RoomPreparationNav } from './RoomPreparationNav.tsx';

function render(canManage: boolean, sectionId = 'structure'): string {
  return renderToStaticMarkup(
    <RoomPreparationNav
      canManage={canManage}
      sectionId={sectionId}
      onSelect={() => undefined}
      onPublish={() => undefined}
    />,
  );
}

describe('room preparation path', () => {
  it('offers a Room Manager every step, ending in Publish', () => {
    const markup = render(true);
    for (const key of [
      'workspace.steps.collection',
      'workspace.steps.access',
      'workspace.steps.review',
      'workspace.steps.publish',
    ] as const)
      expect(markup).toContain(messages[key]);
  });

  it('offers a Contributor only the steps they can take', () => {
    // Access and Publish would only lead a Contributor to a refusal.
    const markup = render(false);
    expect(markup).toContain(messages['workspace.steps.collection']);
    expect(markup).toContain(messages['workspace.steps.review']);
    expect(markup).not.toContain(messages['workspace.steps.access']);
    expect(markup).not.toContain(messages['workspace.steps.publish']);
  });

  it('marks Collection current while adding documents', () => {
    const markup = render(true, 'upload');
    expect(markup).toMatch(/aria-current="step"[^>]*>.*Collection/u);
  });
});
