import { describe, expect, it } from 'vitest';
import type { ViewerDocument } from '../api/client.ts';
import { documentFor, type LoadedDocument } from './useDocumentReader.ts';

const twoPages: ViewerDocument = {
  documentId: 'A'.repeat(32),
  displayTitle: 'Investor model',
  publishedVersionId: 'V'.repeat(32),
  pageCount: 2,
  downloadPolicy: 'allow',
};
const loaded: LoadedDocument = {
  documentId: twoPages.documentId,
  load: { kind: 'ready', value: twoPages },
};

describe('documentFor', () => {
  it('reads as loading under another document, so its page count cannot clamp the new page', () => {
    expect(documentFor(loaded, 'B'.repeat(32))).toStrictEqual({ kind: 'loading' });
    expect(documentFor(loaded, null)).toStrictEqual({ kind: 'loading' });
  });

  it('answers the metadata read for the open document', () => {
    expect(documentFor(loaded, twoPages.documentId)).toStrictEqual(loaded.load);
  });
});
