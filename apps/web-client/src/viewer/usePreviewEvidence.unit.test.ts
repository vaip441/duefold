import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackPreviewActivity } from './usePreviewEvidence.ts';

const ACTIVITY = 'a'.repeat(32);
const target = {
  roomId: 'r'.repeat(32),
  documentId: 'd'.repeat(32),
  versionId: 'v'.repeat(32),
};

let page: EventTarget & { visibilityState: DocumentVisibilityState; cookie: string };
let tab: EventTarget;
let beginStatus: number;
let accepted: boolean;
let calls: {
  readonly path: string;
  readonly body: unknown;
  readonly signal: AbortSignal | undefined;
}[];

function respond(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    clone: () => respond(status, payload),
  } as unknown as Response;
}

function server(path: string): Response {
  if (path === '/api/viewer/previews')
    return beginStatus === 201
      ? respond(201, { activityId: ACTIVITY, correlationId: `corr_${'c'.repeat(32)}` })
      : respond(beginStatus, { error: { code: 'REFUSED', message: 'Refused.' } });
  if (path === '/api/viewer/previews/heartbeat') return respond(200, { accepted });
  return respond(200, { summarized: true });
}

const requests = (path: string): readonly unknown[] =>
  calls.filter((call) => call.path === path).map((call) => call.body);

function track() {
  const onRefused = vi.fn();
  const onRejected = vi.fn();
  return {
    activity: trackPreviewActivity({ target, onRefused, onRejected }),
    onRefused,
    onRejected,
  };
}

function setVisibility(state: DocumentVisibilityState): void {
  page.visibilityState = state;
  page.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  page = Object.assign(new EventTarget(), { visibilityState: 'visible' as const, cookie: '' });
  tab = Object.assign(new EventTarget(), {
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => {
      clearInterval(id);
    },
  });
  beginStatus = 201;
  accepted = true;
  calls = [];
  vi.stubGlobal('document', page);
  vi.stubGlobal('window', tab);
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted === true)
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    calls.push({ path, body: JSON.parse(init?.body as string) as unknown, signal });
    return Promise.resolve(server(path));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('preview activity', () => {
  it('reopens an activity the server ended while the tab was hidden, without stopping', async () => {
    const { activity, onRefused, onRejected } = track();
    await expect(activity.open()).resolves.toBe(ACTIVITY);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(requests('/api/viewer/previews/heartbeat')).toHaveLength(0);

    accepted = false;
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests('/api/viewer/previews/heartbeat')).toHaveLength(1);
    expect(requests('/api/viewer/previews')).toHaveLength(2);
    expect(onRefused).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
    activity.stop();
  });

  it('closes after two idle minutes and reopens once on the next interaction', async () => {
    const { activity } = track();
    await activity.open();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requests('/api/viewer/previews/close')).toEqual([
      { activityId: ACTIVITY, status: 'inactive' },
    ]);

    tab.dispatchEvent(new Event('pointerdown'));
    tab.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(0);
    expect(requests('/api/viewer/previews')).toHaveLength(2);
    // Reopened, so the heartbeat runs again rather than standing in for a close.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests('/api/viewer/previews/heartbeat')).toHaveLength(2);
    activity.stop();
  });

  it('retries a reopen that failed in transit on the next interaction', async () => {
    const { activity, onRefused } = track();
    await activity.open();
    accepted = false;
    beginStatus = 503;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests('/api/viewer/previews')).toHaveLength(2);

    accepted = true;
    beginStatus = 201;
    tab.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests('/api/viewer/previews')).toHaveLength(3);
    expect(requests('/api/viewer/previews/heartbeat')).toHaveLength(2);
    expect(onRefused).not.toHaveBeenCalled();
    activity.stop();
  });

  it('aborts an open still in flight when stopped, and sends none after', async () => {
    const { activity } = track();
    const pending = activity.open();
    activity.stop();
    expect(calls.map((call) => call.signal?.aborted)).toEqual([true]);
    await pending;
    await expect(activity.open()).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests('/api/viewer/previews')).toHaveLength(1);
  });

  it('reports a refused open once, as a refusal rather than lost access', async () => {
    const { activity, onRefused, onRejected } = track();
    beginStatus = 404;
    const opens = [activity.open(), activity.open()];
    for (const open of opens)
      await expect(open).rejects.toMatchObject({ failure: 'not-found' });
    expect(requests('/api/viewer/previews')).toHaveLength(1);
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(onRejected).not.toHaveBeenCalled();

    beginStatus = 401;
    await expect(activity.open()).rejects.toMatchObject({ failure: 'unauthenticated' });
    expect(onRejected.mock.calls).toEqual([['unauthenticated']]);
    activity.stop();
  });

  it('closes the open activity on stop and beats no more', async () => {
    const { activity } = track();
    await activity.open();
    activity.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requests('/api/viewer/previews/close')).toEqual([
      { activityId: ACTIVITY, status: 'closed' },
    ]);
    expect(requests('/api/viewer/previews/heartbeat')).toHaveLength(0);
  });
});
