/**
 * Room structure controls: create folder, move to a destination, edit
 * document metadata, and bulk selection.
 *
 * ORDERING AND BULK SELECTION HAVE NO DRAG DEPENDENCY. Move up, move down, and a
 * numeric position field are ordinary controls, and selection is a real checkbox
 * per row plus select-all. Drag is not offered at all here, so there is nothing a
 * keyboard user is locked out of — the accessible path IS the path.
 *
 * Every mutation carries the revisions the server needs to detect a concurrent
 * edit, and a rejected write surfaces as a refresh prompt. The client never
 * resends a stale revision.
 *
 * Bulk actions apply SEQUENTIALLY and report how many succeeded if one fails
 * partway, because silently stopping would leave a member believing the whole
 * selection changed.
 */

import { Collapsible } from '@base-ui/react/collapsible';
import { useEffect, useId, useRef, useState } from 'react';
import type { DocumentEntry, WorkingEntry } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import { Notice } from './Notice.tsx';

export interface CreateFolderInput {
  readonly parentFolderId: string | null;
  readonly displayName: string;
  readonly description: string;
}

export interface MoveInput {
  readonly entry: WorkingEntry;
  readonly destinationFolderId: string | null;
  readonly targetPosition: number;
}

export interface MetadataInput {
  readonly entry: DocumentEntry;
  readonly title: string;
  readonly description: string;
}

export interface StructureControlsProps {
  readonly entries: readonly WorkingEntry[];
  readonly folders: readonly WorkingEntry[];
  readonly pending: boolean;
  readonly selection: readonly string[];
  readonly bulkProgress: { readonly done: number; readonly total: number } | null;
  readonly onCreateFolder: (input: CreateFolderInput) => void;
  readonly onSelectionChange: (selection: readonly string[]) => void;
  readonly onBulkStageRemoval: () => void;
}

/** Create-folder, plus the bulk-selection summary and actions. */
export function StructureControls({
  entries,
  folders,
  pending,
  selection,
  bulkProgress,
  onCreateFolder,
  onSelectionChange,
  onBulkStageRemoval,
}: StructureControlsProps): React.ReactElement {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parent, setParent] = useState('');
  const [attempted, setAttempted] = useState(false);
  const nameField = useRef<HTMLInputElement | null>(null);
  const selectable = entries.filter((entry) => !entry.stagedRemoved);

  /* Opening the panel is a request to name a folder, so the name field takes focus;
     leaving it on the trigger sent typing nowhere and Enter closed the panel again. */
  useEffect(() => {
    if (open) nameField.current?.focus();
  }, [open]);

  const createFolder = (): void => {
    setAttempted(true);
    if (name.trim() === '') return;
    onCreateFolder({
      parentFolderId: parent === '' ? null : parent,
      displayName: name.trim(),
      description,
    });
    setName('');
    setDescription('');
    setAttempted(false);
    setOpen(false);
  };

  return (
    <Collapsible.Root className="df-controls" open={open} onOpenChange={setOpen}>
      <div className="df-controls__row">
        <Collapsible.Trigger className="df-button" disabled={pending}>
          {translate('structure.createFolder')}
        </Collapsible.Trigger>

        {/* Bulk selection: real checkboxes, keyboard-operable, no drag anywhere. */}
        <button
          type="button"
          className="df-button df-button--quiet"
          disabled={pending || selectable.length === 0}
          onClick={() => {
            onSelectionChange(selectable.map((entry) => entry.entryId));
          }}
        >
          {translate('bulk.selectAll')}
        </button>
        <button
          type="button"
          className="df-button df-button--quiet"
          disabled={pending || selection.length === 0}
          onClick={() => {
            onSelectionChange([]);
          }}
        >
          {translate('bulk.clear')}
        </button>
        <button
          type="button"
          className="df-button df-button--quiet"
          disabled={pending || selection.length === 0}
          onClick={onBulkStageRemoval}
        >
          {translate('bulk.action.stageRemoval')}
        </button>
      </div>

      <p className="df-field__help" data-numeric="true">
        {selection.length === 0
          ? translate('bulk.none')
          : translate('bulk.selected', {
              count: selection.length,
              total: selectable.length,
            })}
      </p>

      {bulkProgress === null ? null : (
        <Notice tone="neutral" role="status">
          {bulkProgress.done === bulkProgress.total
            ? translate('bulk.pending', { count: bulkProgress.total })
            : translate('bulk.partial', {
                done: bulkProgress.done,
                total: bulkProgress.total,
              })}
        </Notice>
      )}

      <Collapsible.Panel className="df-controls__panel">
        <form
          className="df-panel__block"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending) createFolder();
          }}
        >
          <div className="df-field">
            <label className="df-field__label" htmlFor={`${fieldId}-name`}>
              {translate('structure.createFolder.name')}
            </label>
            <input
              ref={nameField}
              id={`${fieldId}-name`}
              className="df-field__input"
              value={name}
              disabled={pending}
              aria-invalid={attempted && name.trim() === '' ? 'true' : undefined}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            {attempted && name.trim() === '' ? (
              <p className="df-field__error" role="alert">
                {translate('structure.createFolder.nameRequired')}
              </p>
            ) : null}
          </div>
          <div className="df-field">
            <label className="df-field__label" htmlFor={`${fieldId}-parent`}>
              {translate('structure.createFolder.parent')}
            </label>
            <select
              id={`${fieldId}-parent`}
              className="df-field__input"
              value={parent}
              disabled={pending}
              onChange={(event) => {
                setParent(event.target.value);
              }}
            >
              <option value="">{translate('structure.move.destinationRoot')}</option>
              {folders.map((folder) => (
                <option key={folder.resourceId} value={folder.resourceId}>
                  {folder.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="df-field">
            <label className="df-field__label" htmlFor={`${fieldId}-description`}>
              {translate('structure.createFolder.description')}
            </label>
            <input
              id={`${fieldId}-description`}
              className="df-field__input"
              value={description}
              disabled={pending}
              onChange={(event) => {
                setDescription(event.target.value);
              }}
            />
          </div>
          <div className="df-panel__actions">
            <button
              type="submit"
              className="df-button df-button--primary"
              data-busy={pending ? 'true' : 'false'}
              disabled={pending}
            >
              {pending
                ? translate('structure.createFolder.pending')
                : translate('structure.createFolder.submit')}
            </button>
            <button
              type="button"
              className="df-button"
              disabled={pending}
              onClick={() => {
                setOpen(false);
                setAttempted(false);
              }}
            >
              {translate('structure.cancel')}
            </button>
          </div>
        </form>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

export interface MoveFormProps {
  readonly entry: WorkingEntry;
  readonly folders: readonly WorkingEntry[];
  readonly pending: boolean;
  readonly onMove: (input: MoveInput) => void;
  readonly onCancel: () => void;
}

/**
 * Move to a destination and position.
 *
 * The position is a 1-based sibling index the SERVER resolves into an ordering
 * key. The client never constructs an ordering value, and the reader never
 * discloses one, so there is nothing here a member could post to corrupt sibling
 * order.
 */
export function MoveForm({
  entry,
  folders,
  pending,
  onMove,
  onCancel,
}: MoveFormProps): React.ReactElement {
  const fieldId = useId();
  const [destination, setDestination] = useState(entry.parentFolderId ?? '');
  const [position, setPosition] = useState(String(entry.position));
  const parsed = Number.parseInt(position, 10);
  const valid = Number.isFinite(parsed) && parsed >= 1;

  const move = (): void => {
    onMove({
      entry,
      destinationFolderId: destination === '' ? null : destination,
      targetPosition: parsed,
    });
  };

  return (
    <form
      className="df-inline-form df-inline-form--stacked"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && valid) move();
      }}
    >
      <div className="df-field">
        <label className="df-field__label" htmlFor={`${fieldId}-destination`}>
          {translate('structure.move.destination')}
        </label>
        <select
          id={`${fieldId}-destination`}
          className="df-field__input"
          value={destination}
          disabled={pending}
          onChange={(event) => {
            setDestination(event.target.value);
          }}
        >
          <option value="">{translate('structure.move.destinationRoot')}</option>
          {folders
            .filter((folder) => folder.resourceId !== entry.resourceId)
            .map((folder) => (
              <option key={folder.resourceId} value={folder.resourceId}>
                {folder.displayName}
              </option>
            ))}
        </select>
      </div>
      <div className="df-field">
        <label className="df-field__label" htmlFor={`${fieldId}-position`}>
          {translate('structure.move.position')}
        </label>
        <input
          id={`${fieldId}-position`}
          className="df-field__input"
          type="number"
          min={1}
          inputMode="numeric"
          value={position}
          disabled={pending}
          aria-invalid={valid ? undefined : 'true'}
          onChange={(event) => {
            setPosition(event.target.value);
          }}
        />
      </div>
      <div className="df-panel__actions">
        <button
          type="submit"
          className="df-button df-button--primary"
          data-busy={pending ? 'true' : 'false'}
          disabled={pending || !valid}
        >
          {pending ? translate('structure.move.pending') : translate('structure.move.submit')}
        </button>
        <button type="button" className="df-button" disabled={pending} onClick={onCancel}>
          {translate('structure.cancel')}
        </button>
      </div>
    </form>
  );
}

export interface MetadataFormProps {
  readonly entry: DocumentEntry;
  readonly pending: boolean;
  readonly onSave: (input: MetadataInput) => void;
  readonly onCancel: () => void;
}

/** Document title and description. Readers see the title, never a filename. */
export function MetadataForm({
  entry,
  pending,
  onSave,
  onCancel,
}: MetadataFormProps): React.ReactElement {
  const fieldId = useId();
  const [title, setTitle] = useState(entry.displayName);
  const [description, setDescription] = useState(entry.description);

  return (
    <form
      className="df-inline-form df-inline-form--stacked"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && title.trim() !== '')
          onSave({ entry, title: title.trim(), description });
      }}
    >
      <div className="df-field">
        <label className="df-field__label" htmlFor={`${fieldId}-title`}>
          {translate('structure.metadata.title')}
        </label>
        <input
          id={`${fieldId}-title`}
          className="df-field__input"
          value={title}
          disabled={pending}
          aria-invalid={title.trim() === '' ? 'true' : undefined}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </div>
      <div className="df-field">
        <label className="df-field__label" htmlFor={`${fieldId}-description`}>
          {translate('structure.metadata.description')}
        </label>
        <textarea
          id={`${fieldId}-description`}
          className="df-field__input df-field__input--area"
          rows={3}
          value={description}
          disabled={pending}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </div>
      <div className="df-panel__actions">
        <button
          type="submit"
          className="df-button df-button--primary"
          data-busy={pending ? 'true' : 'false'}
          disabled={pending || title.trim() === ''}
        >
          {pending
            ? translate('structure.metadata.pending')
            : translate('structure.metadata.submit')}
        </button>
        <button type="button" className="df-button" disabled={pending} onClick={onCancel}>
          {translate('structure.cancel')}
        </button>
      </div>
    </form>
  );
}
