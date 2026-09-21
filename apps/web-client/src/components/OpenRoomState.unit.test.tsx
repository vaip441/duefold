/**
 * The open room's three answers, told apart.
 *
 * The distinction under test is the one a member feels: a room still arriving and a room they
 * cannot reach must not look the same. Reduced to one state, an unreachable room presented as
 * perpetually loading, with every revision-dependent control inside it inert and no reason
 * given and no way back.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { messages } from '../i18n/en.ts';
import type { MemberRoom } from '../api/client.ts';
import type { Load } from '../workspace/state.ts';
import { OpenRoomState } from './OpenRoomState.tsx';

const noop = (): void => undefined;
const render = (load: Load<MemberRoom>) =>
  renderToStaticMarkup(<OpenRoomState load={load} onRetry={noop} onLeave={noop} />);

describe('OpenRoomState', () => {
  it('says the room is opening while its row is still arriving', () => {
    const html = render({ kind: 'loading' });
    expect(html).toContain(messages['rooms.opening']);
    /* A live region, so the wait is announced rather than only drawn. */
    expect(html).toContain('role="status"');
  });

  it('gives the reason and two ways out when the room cannot be reached', () => {
    const html = render({ kind: 'failed', failure: messages['rooms.unavailable'] });
    expect(html).toContain(messages['rooms.unavailable']);
    expect(html).toContain(messages['app.retry']);
    expect(html).toContain(messages['rooms.backToRegister']);
    expect(html).toContain('role="alert"');
    /* Not the loading copy: that is the confusion this component exists to prevent. */
    expect(html).not.toContain(messages['rooms.opening']);
  });

  it('renders nothing once the row is ready, leaving the room to the room', () => {
    const room: MemberRoom = {
      roomId: 'r'.repeat(32),
      title: 'Series A',
      description: '',
      state: 'draft',
      revision: 3,
      workingRevision: 3,
      publishedRevision: 0,
      accessSource: 'global_role',
      roomRole: null,
      canPublish: true,
    };
    expect(render({ kind: 'ready', value: room })).toBe('');
  });
});
