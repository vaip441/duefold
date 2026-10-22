/**
 * The open document's pages with find, page turns and zoom, shared by the reading room
 * and the investor preview. They differ only in where pages come from and in what a
 * link or a refused page does.
 */

import { translate } from '../i18n/translate.ts';
import type { PageSource } from '../viewer/page-source.ts';
import type { DocumentReader } from '../viewer/useDocumentReader.ts';
import { DocumentPager } from './DocumentPager.tsx';
import { FindBar } from './FindBar.tsx';
import { PageReader, type PageReaderProps } from './PageReader.tsx';

export interface DocumentPagesProps {
  readonly reader: DocumentReader;
  readonly roomId: string;
  readonly documentId: string;
  readonly pageNumber: number;
  readonly pageCount: number;
  /** Null until pages can be delivered; the reading room waits for its preview evidence. */
  readonly source: PageSource | null;
  readonly onLinkActivate: PageReaderProps['onLinkActivate'];
  readonly onUnauthorized: PageReaderProps['onUnauthorized'];
}

export function DocumentPages({
  reader,
  roomId,
  documentId,
  pageNumber,
  pageCount,
  source,
  onLinkActivate,
  onUnauthorized,
}: DocumentPagesProps): React.ReactElement {
  return (
    <>
      <FindBar {...reader.findBar} />
      <DocumentPager
        pageNumber={pageNumber}
        pageCount={pageCount}
        zoom={reader.zoom}
        onPage={reader.goToPage}
        onZoom={reader.setZoom}
      />
      {source === null ? (
        <p className="df-field__help">{translate('viewer.document.loading')}</p>
      ) : (
        <div className="df-page-zoom" data-zoom={reader.zoom}>
          <PageReader
            roomId={roomId}
            documentId={documentId}
            pageNumber={pageNumber}
            totalPages={pageCount}
            source={source}
            matches={reader.matches}
            currentMatch={reader.currentMatch}
            onTextLayer={reader.onTextLayer}
            onLinkActivate={onLinkActivate}
            onUnauthorized={onUnauthorized}
          />
        </div>
      )}
    </>
  );
}
