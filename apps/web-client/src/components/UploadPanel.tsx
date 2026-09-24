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

interface DirectoryInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  readonly webkitdirectory?: string;
}
import { preflightDirectoryUpload } from '../../../../modules/rooms-documents/src/preflight.ts';
import { translate, translateCount } from '../i18n/translate.ts';
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

export interface UploadItem {
  readonly id: string;
  readonly file: File;
  readonly title: string;
  readonly relativePath: string;
}

export type UploadItemState =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'active'; readonly percent: number }
  | { readonly kind: 'done' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string };

export interface UploadPanelProps {
  readonly pending: boolean;
  readonly states: ReadonlyMap<string, UploadItemState>;
  readonly failure: PresentedFailure | null;
  readonly doneCount: number;
  readonly onUpload: (items: readonly UploadItem[]) => void;
  readonly onCancel: () => void;
  readonly onReload: () => void;
}

export function UploadPanel({
  pending,
  states,
  failure,
  doneCount,
  onUpload,
  onCancel,
  onReload,
}: UploadPanelProps): React.ReactElement {
  const headingId = useId();
  const fieldId = useId();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const directoryInput = useRef<HTMLInputElement | null>(null);
  const directoryAttributes: DirectoryInputProps = { webkitdirectory: '' };
  const [items, setItems] = useState<readonly UploadItem[]>([]);
  const [attempted, setAttempted] = useState(false);
  const [preflightFailure, setPreflightFailure] = useState<string | null>(null);

  const choose = (files: FileList | null): void => {
    if (files === null) return;
    try {
      const chosen = Array.from(files);
      const normalized = preflightDirectoryUpload(
        chosen.map((file) => ({
          path: file.webkitRelativePath === '' ? file.name : file.webkitRelativePath,
          size: file.size,
        })),
      );
      const next = chosen.map((file, index) => {
        const normalizedEntry = normalized[index];
        if (normalizedEntry === undefined) throw new Error('PREFLIGHT_PATH_REJECTED');
        return {
          id: `${normalizedEntry.path}:${String(file.size)}:${String(file.lastModified)}:${String(index)}`,
          file,
          relativePath: normalizedEntry.path,
          title: file.name.replace(/\.[^.]+$/u, ''),
        };
      });
      setItems(next);
      setPreflightFailure(null);
      setAttempted(false);
    } catch (error) {
      setItems([]);
      if (
        error instanceof Error &&
        (error.message === 'PREFLIGHT_COLLISION_REJECTED' ||
          error.message === 'PREFLIGHT_CONFUSABLE_REJECTED')
      ) {
        setPreflightFailure(translate('upload.preflight.collision'));
      } else if (
        error instanceof Error &&
        (error.message === 'PREFLIGHT_FILE_SIZE_REJECTED' ||
          error.message === 'PREFLIGHT_TOTAL_SIZE_REJECTED')
      ) {
        setPreflightFailure(translate('upload.preflight.total'));
      } else {
        setPreflightFailure(
          translate(
            error instanceof Error && error.message === 'PREFLIGHT_COUNT_REJECTED'
              ? 'upload.preflight.count'
              : error instanceof Error && error.message === 'PREFLIGHT_TYPE_REJECTED'
                ? 'upload.preflight.type'
                : 'upload.preflight.path',
          ),
        );
      }
    }
  };

  const totalBytes = items.reduce((total, item) => total + item.file.size, 0);

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

      {preflightFailure === null ? null : (
        <Notice tone="problem" role="alert">
          {preflightFailure}
        </Notice>
      )}

      {doneCount > 0 ? (
        <Notice tone="action" role="status">
          {translateCount('upload.doneCount', doneCount)}
        </Notice>
      ) : null}

      <div className="df-upload-picker">
        <div className="df-field">
          <label className="df-field__label" htmlFor={`${fieldId}-file`}>
            {translate('upload.pick')}
          </label>
          <input
            id={`${fieldId}-file`}
            className="df-field__input"
            type="file"
            multiple
            ref={fileInput}
            disabled={pending}
            aria-invalid={attempted && items.length === 0 ? 'true' : undefined}
            onChange={(event) => {
              choose(event.target.files);
            }}
          />
        </div>
        <span className="df-upload-picker__or">{translate('upload.or')}</span>
        <div className="df-field">
          <label className="df-field__label" htmlFor={`${fieldId}-directory`}>
            {translate('upload.pickDirectory')}
          </label>
          <input
            id={`${fieldId}-directory`}
            className="df-field__input"
            type="file"
            multiple
            {...directoryAttributes}
            ref={directoryInput}
            disabled={pending}
            onChange={(event) => {
              choose(event.target.files);
            }}
          />
        </div>
      </div>
      {attempted && items.length === 0 ? (
        <p className="df-field__error" role="alert">
          {translate('upload.noFile')}
        </p>
      ) : null}

      {items.length === 0 ? null : (
        <div className="df-upload-review">
          <div className="df-upload-review__summary">
            <div>
              <h3 className="df-panel__subheading">{translate('upload.review')}</h3>
              <p className="df-field__help" data-numeric="true">
                {translateCount('upload.summary', items.length, {
                  size: new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
                    totalBytes / 1_000_000,
                  ),
                })}
              </p>
            </div>
            <button
              type="button"
              className="df-button df-button--quiet"
              disabled={pending}
              onClick={() => {
                setItems([]);
                setPreflightFailure(null);
                if (fileInput.current !== null) fileInput.current.value = '';
                if (directoryInput.current !== null) directoryInput.current.value = '';
              }}
            >
              {translate('upload.clear')}
            </button>
          </div>
          <ol className="df-upload-list">
            {items.map((item) => {
              const state = states.get(item.id) ?? { kind: 'waiting' as const };
              return (
                <li key={item.id} className="df-upload-list__item" data-state={state.kind}>
                  <div className="df-upload-list__identity">
                    <span className="df-upload-list__path">{item.relativePath}</span>
                    <span className="df-register__meta">
                      {new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
                        item.file.size / 1_000_000,
                      )}{' '}
                      MB
                    </span>
                  </div>
                  <div className="df-field">
                    <label className="df-field__label" htmlFor={`${fieldId}-${item.id}`}>
                      {translate('upload.title.label')}
                    </label>
                    <input
                      id={`${fieldId}-${item.id}`}
                      className="df-field__input"
                      value={item.title}
                      disabled={pending}
                      aria-invalid={attempted && item.title.trim() === '' ? 'true' : undefined}
                      onChange={(event) => {
                        const title = event.target.value;
                        setItems((current) =>
                          current.map((candidate) =>
                            candidate.id === item.id ? { ...candidate, title } : candidate,
                          ),
                        );
                      }}
                    />
                  </div>
                  <div className="df-upload-list__state" aria-live="polite">
                    {state.kind === 'active' ? (
                      <>
                        <progress className="df-progress" max={100} value={state.percent}>
                          {translate('upload.progress', { percent: state.percent })}
                        </progress>
                        <span className="df-field__help" data-numeric="true">
                          {translate('upload.progress', { percent: state.percent })}
                        </span>
                      </>
                    ) : state.kind === 'failed' ? (
                      <span className="df-field__error">{state.message}</span>
                    ) : (
                      <span
                        className="df-state"
                        data-live={state.kind === 'done' ? 'true' : 'false'}
                      >
                        {translate(`upload.state.${state.kind}`)}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <div className="df-panel__actions">
        <button
          type="button"
          className="df-button"
          data-busy={pending ? 'true' : 'false'}
          disabled={pending}
          onClick={() => {
            setAttempted(true);
            if (items.length === 0 || items.some((item) => item.title.trim() === '')) return;
            onUpload(items.map((item) => ({ ...item, title: item.title.trim() })));
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
