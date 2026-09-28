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
      onPreview={() => undefined}
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
      'publish.action',
    ] as const)
      expect(markup).toContain(messages[key]);
  });

  it("ends the path in the room's one primary action", () => {
    const markup = render(true);
    expect(markup.match(/df-button--primary/gu)).toHaveLength(1);
    expect(markup).toMatch(
      new RegExp(
        `class="[^"]*df-button--primary[^"]*"[^>]*>${messages['publish.action']}</button></span></nav>$`,
        'u',
      ),
    );
  });

  it('offers a Contributor only the steps they can take', () => {
    // Access and Publish would only lead a Contributor to a refusal.
    const markup = render(false);
    expect(markup).toContain(messages['workspace.steps.collection']);
    expect(markup).toContain(messages['workspace.steps.review']);
    expect(markup).not.toContain(messages['workspace.steps.access']);
    expect(markup).not.toContain(messages['publish.action']);
    expect(markup).not.toContain(messages['preview.action']);
  });

  it('offers a Room Manager the investor preview as a quiet action just before Publish', () => {
    const markup = render(true);
    expect(markup).toMatch(
      new RegExp(
        `class="df-button df-button--quiet"[^>]*>${messages['preview.action']}</button><button[^>]*df-button--primary`,
        'u',
      ),
    );
    expect(markup.match(/df-button--primary/gu)).toHaveLength(1);
  });

  it('marks Collection current while adding documents', () => {
    const markup = render(true, 'upload');
    expect(markup).toMatch(/aria-current="step"[^>]*>.*Collection/u);
  });
});
