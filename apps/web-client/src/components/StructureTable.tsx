/**
 * The document worktable: the working structure, with each entry's relationship to
 * what viewers currently see.
 *
 * Requirement: a member must never be confused about whether a change is live. So
 * every row states its status in WORDS — live, not visible, staged, staged for
 * removal — and `changeKinds` comes from the server expression the publish preview
 * shares. A pending marker here and the publish preview cannot disagree.
 *
 * Ordering has no drag dependency. Move up / move down are ordinary buttons, and a
 * position field accepts a target directly, so the whole ordering model is operable
 * from the keyboard. `canMoveUp`/`canMoveDown` come from the server's view of the
 * sibling order rather than being inferred from array index, which would be wrong
 * as soon as a staged-removed sibling is present.
 */

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { translate, type MessageKey } from '../i18n/translate.ts';
import type { PublicationChangeKind, WorkingEntry } from '../api/client.ts';
import {
  MetadataForm,
  MoveForm,
  type MetadataInput,
  type MoveInput,
} from './StructureControls.tsx';

const CHANGE_LABEL: Readonly<Record<PublicationChangeKind, MessageKey>> = {
  add: 'workspace.change.add',
  remove: 'workspace.change.remove',
  rename: 'workspace.change.rename',
  move: 'workspace.change.move',
  reorder: 'workspace.change.reorder',
  description: 'workspace.change.description',
  version: 'workspace.change.version',
  replace: 'workspace.change.replace',
};

export interface StructureTableProps {
  readonly entries: readonly WorkingEntry[];
  readonly busyEntryId: string | null;
  /** Entry ids currently selected for a bulk action. */
  readonly selection?: readonly string[];
  readonly onSelectionChange?: (selection: readonly string[]) => void;
  readonly folders?: readonly WorkingEntry[];
  readonly onRename: (entry: WorkingEntry, displayName: string) => void;
  readonly onReorder: (entry: WorkingEntry, targetPosition: number) => void;
  readonly onStageRemoval: (entry: WorkingEntry) => void;
  readonly onMove?: (input: MoveInput) => void;
  readonly onMetadata?: (input: MetadataInput) => void;
}

function statusText(entry: WorkingEntry): string {
  if (entry.stagedRemoved) return translate('workspace.stagedRemoval');
  if (entry.changeKinds.length > 0) return translate('workspace.pending');
  return entry.isPublished ? translate('workspace.live') : translate('workspace.notLive');
}

export function StructureTable({
  entries,
  busyEntryId,
  selection,
  onSelectionChange,
  folders,
  onRename,
  onReorder,
  onStageRemoval,
  onMove,
  onMetadata,
}: StructureTableProps): React.ReactElement {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [editingMetadata, setEditingMetadata] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const renameFieldId = useId();
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  const previousTops = useRef(new Map<string, number>());
  const selectable = selection !== undefined && onSelectionChange !== undefined;

  useLayoutEffect(() => {
    const currentTops = new Map<string, number>();
    for (const [id, row] of rows.current) currentTops.set(id, row.getBoundingClientRect().top);

    if (
      previousTops.current.size > 0 &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      for (const [id, row] of rows.current) {
        const before = previousTops.current.get(id);
        const after = currentTops.get(id);
        if (before === undefined || after === undefined || before === after) continue;
        row.animate(
          [
            { transform: `translateY(${String(before - after)}px)` },
            { transform: 'translateY(0)' },
          ],
          {
            duration: 200,
            easing: 'cubic-bezier(0.77, 0, 0.175, 1)',
          },
        );
      }
    }

    previousTops.current = currentTops;
  }, [entries]);

  if (entries.length === 0)
    return (
      <div className="df-empty df-empty--worktable">
        <span className="df-empty__lead">{translate('workspace.empty')}</span>
        {translate('workspace.emptyHelp')}
      </div>
    );

  return (
    <>
      <p className="df-field__help" id={`${renameFieldId}-reorder-help`}>
        {translate('structure.reorder.help')}
      </p>
      <table className="df-register">
        <caption className="df-visually-hidden">
          {translate('workspace.section.structure')}
        </caption>
        <thead>
          <tr>
            {selectable ? (
              <th scope="col">
                <span className="df-visually-hidden">{translate('bulk.label')}</span>
              </th>
            ) : null}
            <th scope="col">{translate('workspace.columns.name')}</th>
            <th scope="col">{translate('workspace.columns.status')}</th>
            <th scope="col">{translate('workspace.columns.order')}</th>
            <th scope="col">{translate('workspace.columns.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const busy = busyEntryId === entry.entryId;
            return (
              <tr
                ref={(node) => {
                  if (node === null) rows.current.delete(entry.entryId);
                  else rows.current.set(entry.entryId, node);
                }}
                key={entry.entryId}
                id={`entry-${entry.entryId}`}
                tabIndex={-1}
                data-staged-removed={entry.stagedRemoved ? 'true' : 'false'}
                data-pending={entry.changeKinds.length > 0 ? 'true' : 'false'}
              >
                {selectable ? (
                  <td>
                    {/* A real checkbox: selection is keyboard-operable by construction. */}
                    <input
                      type="checkbox"
                      checked={selection.includes(entry.entryId)}
                      disabled={busy || entry.stagedRemoved}
                      aria-label={translate('bulk.selectRow', { name: entry.displayName })}
                      onChange={(event) => {
                        onSelectionChange(
                          event.target.checked
                            ? [...selection, entry.entryId]
                            : selection.filter((id) => id !== entry.entryId),
                        );
                      }}
                    />
                  </td>
                ) : null}
                <th scope="row" className="df-register__name">
                  <span
                    style={{
                      paddingInlineStart: `calc(${entry.depth} * var(--space-4))`,
                      display: 'inline-block',
                    }}
                  >
                    {renaming === entry.entryId ? (
                      <span className="df-inline-form">
                        <label className="df-visually-hidden" htmlFor={renameFieldId}>
                          {translate('structure.rename.label')}
                        </label>
                        <input
                          id={renameFieldId}
                          className="df-field__input df-field__input--inline"
                          value={draftName}
                          disabled={busy}
                          onChange={(event) => {
                            setDraftName(event.target.value);
                          }}
                        />
                        <button
                          type="button"
                          className="df-button df-button--primary"
                          disabled={busy || draftName.trim() === ''}
                          onClick={() => {
                            onRename(entry, draftName.trim());
                            setRenaming(null);
                          }}
                        >
                          {translate('structure.rename.submit')}
                        </button>
                        <button
                          type="button"
                          className="df-button df-button--quiet"
                          disabled={busy}
                          onClick={() => {
                            setRenaming(null);
                          }}
                        >
                          {translate('structure.cancel')}
                        </button>
                      </span>
                    ) : (
                      entry.displayName
                    )}
                  </span>
                  {entry.resourceKind === 'document' && !entry.hasPublishableVersion ? (
                    <span className="df-register__meta">
                      {translate('workspace.needsVersion')}
                    </span>
                  ) : null}
                </th>
                <td>
                  {/* Status in words first; the data attribute only styles it. */}
                  <span
                    className="df-state"
                    data-live={
                      entry.isPublished && entry.changeKinds.length === 0 ? 'true' : 'false'
                    }
                  >
                    {statusText(entry)}
                  </span>
                  {entry.changeKinds.length > 0 ? (
                    <ul className="df-changes">
                      {entry.changeKinds.map((change) => (
                        <li key={change}>{translate(CHANGE_LABEL[change])}</li>
                      ))}
                    </ul>
                  ) : null}
                </td>
                <td data-numeric="true">{entry.position}</td>
                <td>
                  <div className="df-register__actions">
                    <button
                      type="button"
                      className="df-button df-button--quiet"
                      disabled={busy || !entry.canMoveUp}
                      onClick={() => {
                        onReorder(entry, entry.position - 1);
                      }}
                    >
                      {translate('structure.moveUp')}
                      <span className="df-visually-hidden"> {entry.displayName}</span>
                    </button>
                    <button
                      type="button"
                      className="df-button df-button--quiet"
                      disabled={busy || !entry.canMoveDown}
                      onClick={() => {
                        onReorder(entry, entry.position + 1);
                      }}
                    >
                      {translate('structure.moveDown')}
                      <span className="df-visually-hidden"> {entry.displayName}</span>
                    </button>
                    <button
                      type="button"
                      className="df-button df-button--quiet"
                      disabled={busy}
                      onClick={() => {
                        setRenaming(entry.entryId);
                        setDraftName(entry.displayName);
                      }}
                    >
                      {translate('structure.rename')}
                      <span className="df-visually-hidden"> {entry.displayName}</span>
                    </button>
                    {entry.stagedRemoved ? null : (
                      <button
                        type="button"
                        className="df-button df-button--quiet"
                        disabled={busy}
                        onClick={() => {
                          onStageRemoval(entry);
                        }}
                      >
                        {translate('structure.stageRemoval')}
                        <span className="df-visually-hidden"> {entry.displayName}</span>
                      </button>
                    )}
                    {onMove === undefined || folders === undefined ? null : (
                      <button
                        type="button"
                        className="df-button df-button--quiet"
                        disabled={busy}
                        onClick={() => {
                          setMoving(entry.entryId);
                          setEditingMetadata(null);
                        }}
                      >
                        {translate('structure.move')}
                        <span className="df-visually-hidden"> {entry.displayName}</span>
                      </button>
                    )}
                    {onMetadata === undefined || entry.resourceKind !== 'document' ? null : (
                      <button
                        type="button"
                        className="df-button df-button--quiet"
                        disabled={busy}
                        onClick={() => {
                          setEditingMetadata(entry.entryId);
                          setMoving(null);
                        }}
                      >
                        {translate('structure.metadata')}
                        <span className="df-visually-hidden"> {entry.displayName}</span>
                      </button>
                    )}
                    {moving === entry.entryId &&
                    onMove !== undefined &&
                    folders !== undefined ? (
                      <MoveForm
                        entry={entry}
                        folders={folders}
                        pending={busy}
                        onMove={(input) => {
                          onMove(input);
                          setMoving(null);
                        }}
                        onCancel={() => {
                          setMoving(null);
                        }}
                      />
                    ) : null}
                    {editingMetadata === entry.entryId && onMetadata !== undefined ? (
                      <MetadataForm
                        entry={entry}
                        pending={busy}
                        onSave={(input) => {
                          onMetadata(input);
                          setEditingMetadata(null);
                        }}
                        onCancel={() => {
                          setEditingMetadata(null);
                        }}
                      />
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="df-field__help">{translate('structure.stageRemoval.help')}</p>
    </>
  );
}
