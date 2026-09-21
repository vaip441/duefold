/**
 * Which rooms one member works in, and in what role.
 *
 * Applied as ONE batch, not one call per room. Every `room_assignment` row change
 * revokes all of that member's sessions, so staffing someone across four rooms as four
 * calls would sign them out four times. This form collects the whole change, and says
 * plainly — before the controls that cause it — that the member will be signed out.
 *
 * Removal is the "not staffed" option rather than a separate destructive action, so
 * assignment and revocation are chosen in the same control and the resulting set is
 * the one the administrator can see.
 *
 * A plain component rather than part of the dialog, because the portal is a browser
 * mechanism and these statements should be testable without one.
 */

import { useId } from 'react';
import type { MemberRoom } from '../api/client.ts';
import { translate } from '../i18n/translate.ts';
import type { AssignmentDraft, DraftRole } from '../workspace/administration.ts';
import type { PresentedFailure } from '../workspace/failures.ts';
import { Notice } from './Notice.tsx';

export interface MemberRoomsFormProps {
  readonly rooms: readonly MemberRoom[];
  /** False when the paged register stopped short; see `MemberRoomsDialog`. */
  readonly roomsComplete: boolean;
  readonly roomsLoadingMore: boolean;
  readonly onLoadMoreRooms: () => void;
  readonly draft: AssignmentDraft;
  readonly pending: boolean;
  /** False when the draft matches what the member already holds. */
  readonly changed: boolean;
  /** The last submitted batch's failure, reported here with the draft intact. */
  readonly failure: PresentedFailure | null;
  readonly onDraftChange: (roomId: string, role: DraftRole) => void;
}

export function MemberRoomsForm({
  rooms,
  roomsComplete,
  roomsLoadingMore,
  onLoadMoreRooms,
  draft,
  pending,
  changed,
  failure,
  onDraftChange,
}: MemberRoomsFormProps): React.ReactElement {
  const fieldId = useId();
  const roleFor = (roomId: string): DraftRole => draft[roomId] ?? 'none';

  return (
    <>
      <p className="df-modal__lead">{translate('members.assign.explain')}</p>

      {/* Before the controls, not after: a member about to be signed out of every
          device should know that while the choice is being made. */}
      <Notice tone="caution">{translate('members.assign.signOutWarning')}</Notice>

      {/* The failure stays HERE, with the draft, so a refused batch can be corrected
          and resubmitted rather than reconstructed from memory. */}
      {failure === null ? null : (
        <Notice
          tone="problem"
          role="alert"
          {...(failure.title === null ? {} : { title: failure.title })}
        >
          {failure.body}
        </Notice>
      )}

      {/* Before the controls: "Not staffed" means something narrower when the list is a
          prefix, and the administrator should know that while choosing. The action to
          complete the list sits with the caveat, so the limitation is resolvable here
          rather than merely disclosed. */}
      {roomsComplete ? null : (
        <Notice tone="caution">
          {translate('members.assign.partialRooms')}{' '}
          <button
            type="button"
            className="df-textlink"
            data-busy={roomsLoadingMore ? 'true' : 'false'}
            disabled={roomsLoadingMore}
            onClick={onLoadMoreRooms}
          >
            {roomsLoadingMore ? translate('rooms.loadingMore') : translate('rooms.more')}
          </button>
        </Notice>
      )}

      {rooms.length === 0 ? (
        <p className="df-field__help">{translate('members.assign.noRooms')}</p>
      ) : (
        rooms.map((room, index) => (
          /* The control id is positional rather than the room id: an opaque
             identifier in the DOM is one more place it could reach a surface, and
             uniqueness within this form is all the label needs. */
          <div className="df-field" key={room.roomId}>
            <label className="df-field__label" htmlFor={`${fieldId}-${String(index)}`}>
              {translate('members.assign.roomRole', { room: room.title })}
            </label>
            <select
              id={`${fieldId}-${String(index)}`}
              className="df-field__input"
              value={roleFor(room.roomId)}
              disabled={pending}
              onChange={(event) => {
                const value = event.target.value;
                onDraftChange(
                  room.roomId,
                  value === 'manager'
                    ? 'manager'
                    : value === 'contributor'
                      ? 'contributor'
                      : 'none',
                );
              }}
            >
              <option value="none">{translate('members.assign.none')}</option>
              <option value="manager">{translate('members.assign.manager')}</option>
              <option value="contributor">{translate('members.assign.contributor')}</option>
            </select>
          </div>
        ))
      )}

      {/* Stated rather than left to a silently inert button: a batch that changes
          nothing still fires the session revocation, so confirming one by accident
          would sign a colleague out for no reason. */}
      {rooms.length === 0 || changed ? null : (
        <p className="df-field__help">{translate('members.assign.unchanged')}</p>
      )}
    </>
  );
}
