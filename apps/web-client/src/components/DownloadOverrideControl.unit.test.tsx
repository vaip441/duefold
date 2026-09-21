import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DocumentEntry } from '../api/client.ts';
import { DownloadMarker, DownloadOverrideControl } from './DownloadOverrideControl.tsx';

const entry = {
  entryId: 'e'.repeat(32),
  resourceKind: 'document',
  resourceId: 'd'.repeat(32),
  documentRevision: 2,
  parentFolderId: null,
  displayName: 'Teaser',
  description: '',
  revision: 1,
  stagedRemoved: false,
  depth: 0,
  position: 1,
  canMoveUp: false,
  canMoveDown: false,
  changeKinds: [],
  hasPublishableVersion: true,
  isPublished: false,
} satisfies DocumentEntry;

const control = (current: 'allow' | 'deny' | null) =>
  renderToStaticMarkup(
    <DownloadOverrideControl
      entry={entry}
      current={current}
      inherited="deny"
      onChange={() => Promise.resolve(null)}
      onReload={() => undefined}
    />,
  );

describe('DownloadOverrideControl', () => {
  it('names the document it changes and what inheriting resolves to', () => {
    const html = control(null);
    expect(html).toContain('aria-label="Downloads for Teaser"');
    expect(html).toContain('Room default (denied)');
  });

  it('shows an explicit exception as the current choice', () => {
    expect(control('allow')).toMatch(/<option value="allow" selected=""/u);
  });
});

describe('DownloadMarker', () => {
  it('states an exception in words and says nothing when there is none', () => {
    expect(renderToStaticMarkup(<DownloadMarker policy="allow" />)).toContain(
      'Downloads allowed here',
    );
    expect(renderToStaticMarkup(<DownloadMarker policy={null} />)).toBe('');
  });
});
