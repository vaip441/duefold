/**
 * Adding a document: intent, direct multipart transfer, finalize.
 *
 * Progress is REAL. Each part upload reports its own `progress` events and the
 * aggregate is bytes actually acknowledged by the storage provider, not an
 * animation on a timer. A fake progress bar on a slow upload is worse than none,
 * because it tells a member the transfer is moving when it may have stalled.
 *
 * `XMLHttpRequest` is used for the part PUTs specifically because `fetch` cannot
 * report upload progress. The presigned URLs come from the server; nothing here
 * constructs a storage URL, and no credential is present in the browser.
 *
 * The file name is used only to declare the original filename to the server, which
 * needs it to validate the extension. Readers see the member-chosen TITLE, and the
 * title field says so, so a file called `draft-final-v3-REAL.pdf` does not become
 * the reader-visible name.
 */

import { useId, useRef, useState } from 'react';
import { translate } from '../i18n/translate.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { Notice } from './Notice.tsx';

/** Provider limit mirrored from the server contract. */
const MAX_PARTS = 50;
const MIN_PART_BYTES = 5 * 1024 * 1024;

export interface UploadPlanPart {
  readonly partNumber: number;
  readonly size: number;
}

/** Splits a file into parts the server's intent schema accepts. */
export function planParts(size: number): readonly UploadPlanPart[] {
  if (size <= 0) return [];
  const target = Math.max(MIN_PART_BYTES, Math.ceil(size / MAX_PARTS));
  const parts: UploadPlanPart[] = [];
  let offset = 0;
  let partNumber = 1;
  while (offset < size && partNumber <= MAX_PARTS) {
    const length = Math.min(target, size - offset);
    parts.push({ partNumber, size: length });
    offset += length;
    partNumber += 1;
  }
  return parts;
}

export interface UploadPanelProps {
  readonly pending: boolean;
  readonly progressPercent: number | null;
  readonly failure: PresentedFailure | null;
  readonly done: boolean;
  readonly onUpload: (input: { readonly file: File; readonly title: string }) => void;
  readonly onCancel: () => void;
  readonly onReload: () => void;
}

export function UploadPanel({
  pending,
  progressPercent,
  failure,
  done,
  onUpload,
  onCancel,
  onReload,
}: UploadPanelProps): React.ReactElement {
  const headingId = useId();
  const fieldId = useId();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [attempted, setAttempted] = useState(false);

  return (
    <section aria-labelledby={headingId}>
      <h2 className="df-section__heading" id={headingId}>
        {translate('upload.heading')}
      </h2>
      <p className="df-field__help">{translate('upload.note')}</p>

      {failure === null ? null : (
        <Notice
          tone="problem"
          role="alert"
          {...(failure.title === null ? {} : { title: failure.title })}
        >
          {failure.body}{' '}
          {failure.offerReload ? (
            <button type="button" className="df-textlink" onClick={onReload}>
              {translate('error.conflict.reload')}
            </button>
          ) : null}
        </Notice>
      )}

      {done ? (
        <Notice tone="action" role="status">
          {translate('upload.done')}
        </Notice>
      ) : null}

      <div className="df-field">
        <label className="df-field__label" htmlFor={`${fieldId}-file`}>
          {translate('upload.pick')}
        </label>
        <input
          id={`${fieldId}-file`}
          className="df-field__input"
          type="file"
          ref={fileInput}
          disabled={pending}
          aria-invalid={attempted && file === null ? 'true' : undefined}
          onChange={(event) => {
            const chosen = event.target.files?.[0] ?? null;
            setFile(chosen);
            // A sensible default title, still editable and clearly labelled.
            if (chosen !== null && title.trim() === '')
              setTitle(chosen.name.replace(/\.[^.]+$/u, ''));
          }}
        />
        {attempted && file === null ? (
          <p className="df-field__error" role="alert">
            {translate('upload.noFile')}
          </p>
        ) : null}
      </div>

      <div className="df-field">
        <label className="df-field__label" htmlFor={`${fieldId}-title`}>
          {translate('upload.title.label')}
        </label>
        <input
          id={`${fieldId}-title`}
          className="df-field__input"
          value={title}
          disabled={pending}
          aria-describedby={`${fieldId}-title-help`}
          aria-invalid={attempted && title.trim() === '' ? 'true' : undefined}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
        <p className="df-field__help" id={`${fieldId}-title-help`}>
          {translate('upload.title.help')}
        </p>
      </div>

      {pending && progressPercent !== null ? (
        <>
          {/* A real progress element with a real value. */}
          <progress className="df-progress" max={100} value={progressPercent}>
            {translate('upload.progress', { percent: progressPercent })}
          </progress>
          <p className="df-field__help" data-numeric="true">
            {translate('upload.progress', { percent: progressPercent })}
          </p>
        </>
      ) : null}

      <div className="df-panel__actions">
        <button
          type="button"
          className="df-button df-button--primary"
          data-busy={pending ? 'true' : 'false'}
          disabled={pending}
          onClick={() => {
            setAttempted(true);
            if (file === null || title.trim() === '') return;
            onUpload({ file, title: title.trim() });
          }}
        >
          {pending ? translate('upload.pending') : translate('upload.submit')}
        </button>
        {pending ? (
          <button type="button" className="df-button" onClick={onCancel}>
            {translate('upload.cancel')}
          </button>
        ) : null}
      </div>
    </section>
  );
}
