/**
 * The room register: which rooms this member can reach, and why.
 *
 * `accessSource` is rendered, not hidden. An owner or admin reaches every room in
 * the installation through their organization role with no assignment, and
 * presenting that as though a colleague had invited them would be misleading. The
 * server decides visibility; this surface only reports the reason it gave.
 *
 * Room state is stated in words as well as position, because an archived room must
 * never read as a live working surface.
 */

import { translate, type MessageKey } from '../i18n/translate.ts';
import type { MemberRoom, RoomState } from '../api/client.ts';

const STATE_LABEL: Readonly<Record<RoomState, MessageKey>> = {
  draft: 'rooms.state.draft',
  published: 'rooms.state.published',
  archived: 'rooms.state.archived',
};
const STATE_EXPLAIN: Readonly<Record<RoomState, MessageKey>> = {
  draft: 'rooms.state.draft.explain',
  published: 'rooms.state.published.explain',
  archived: 'rooms.state.archived.explain',
};

export interface RoomRegisterProps {
  readonly rooms: readonly MemberRoom[];
  readonly onOpen: (roomId: string) => void;
}

export function RoomRegister({ rooms, onOpen }: RoomRegisterProps): React.ReactElement {
  if (rooms.length === 0)
    return (
      <div className="df-empty df-empty--worktable">
        <span className="df-empty__lead">{translate('rooms.empty')}</span>
        {translate('rooms.emptyHelp')}
      </div>
    );

  return (
    <table className="df-register">
      <caption className="df-visually-hidden">{translate('rooms.title')}</caption>
      <thead>
        <tr>
          <th scope="col">{translate('rooms.columns.room')}</th>
          <th scope="col">{translate('rooms.columns.state')}</th>
          <th scope="col">{translate('rooms.columns.access')}</th>
          <th scope="col">
            <span className="df-visually-hidden">{translate('workspace.columns.actions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rooms.map((room) => (
          <tr key={room.roomId} data-state={room.state}>
            <th scope="row" className="df-register__name">
              {room.title}
              {room.description === '' ? null : (
                <span className="df-register__meta">{room.description}</span>
              )}
            </th>
            <td>
              {/* State is named, and its consequence spelled out: colour alone
                  never carries this meaning. */}
              <span className="df-state" data-state={room.state}>
                {translate(STATE_LABEL[room.state])}
              </span>
              <span className="df-register__meta">{translate(STATE_EXPLAIN[room.state])}</span>
            </td>
            <td>
              {room.roomRole === null
                ? translate('rooms.access.globalRole')
                : `${translate(
                    room.roomRole === 'manager'
                      ? 'rooms.role.manager'
                      : 'rooms.role.contributor',
                  )} · ${translate('rooms.access.assignment')}`}
            </td>
            <td>
              <div className="df-register__actions">
                <button
                  type="button"
                  className="df-button"
                  onClick={() => {
                    onOpen(room.roomId);
                  }}
                >
                  {translate('rooms.open')}
                  <span className="df-visually-hidden"> {room.title}</span>
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
