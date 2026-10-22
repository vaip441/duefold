import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UploadPanel, pendingUploads, queueUploads } from './UploadPanel.tsx';

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

  it('declares a CSV by its extension when the browser reports an Excel type', () => {
    const csv = new File(['a,b\n1,2\n'], 'Q1, Q2 report.csv', {
      type: 'application/vnd.ms-excel',
    });
    // Node's File lacks the browser's always-present relative path.
    Object.defineProperty(csv, 'webkitRelativePath', { value: '' });

    expect(queueUploads([csv]).map(({ mediaType, title }) => ({ mediaType, title }))).toEqual([
      { mediaType: 'text/csv', title: 'Q1, Q2 report' },
    ]);
  });

  it('keeps the whole name as the title of a file named only by its extension', () => {
    const files = ['.pdf', ' .pdf'].map((name) => {
      const file = new File(['%PDF-1.7'], name, { type: 'application/pdf' });
      Object.defineProperty(file, 'webkitRelativePath', { value: '' });
      return file;
    });

    expect(queueUploads(files).map(({ title }) => title)).toEqual(['.pdf', ' .pdf']);
  });

  it('sends again only the files the server has not accepted', () => {
    const items = ['accepted.pdf', 'failed.pdf', 'cancelled.pdf'].map((name) => {
      const file = new File(['%PDF-1.7'], name, { type: 'application/pdf' });
      Object.defineProperty(file, 'webkitRelativePath', { value: '' });
      return file;
    });
    const [accepted, failed, cancelled] = queueUploads(items);
    if (accepted === undefined || failed === undefined || cancelled === undefined)
      throw new Error('queue missing');

    expect(
      pendingUploads(
        [accepted, failed, cancelled],
        new Map([
          [accepted.id, { kind: 'done' }],
          [failed.id, { kind: 'failed', message: 'Refused' }],
          [cancelled.id, { kind: 'cancelled' }],
        ]),
      ).map(({ title }) => title),
    ).toEqual(['failed', 'cancelled']);
  });
});
