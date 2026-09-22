import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UploadPanel } from './UploadPanel.tsx';

describe('UploadPanel', () => {
  it('offers multi-file and directory selection before the reviewed queue', () => {
    const markup = renderToStaticMarkup(
      <UploadPanel
        pending={false}
        states={new Map()}
        failure={null}
        doneCount={0}
        onUpload={() => undefined}
        onCancel={() => undefined}
        onReload={() => undefined}
      />,
    );

    expect([...markup.matchAll(/type="file"/gu)]).toHaveLength(2);
    expect([...markup.matchAll(/multiple=""/gu)]).toHaveLength(2);
    expect(markup).toContain('webkitdirectory=""');
    expect(markup).toContain('review every title');
  });
});
