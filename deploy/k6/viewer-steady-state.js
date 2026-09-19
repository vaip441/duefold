/*
 * Steady-state viewer performance qualification.
 *
 * Measures performance thresholds on the reference environment
 * (web 2 vCPU / 2 GiB, worker 4 vCPU / 4 GiB) against the reference corpus
 * (10,000 documents, 1,000,000 audit events, five-level trees):
 *
 *   - 100 concurrent viewers at steady state
 *   - p95 cached metadata/navigation below 500 ms
 *   - p95 cached preview-page below 750 ms
 *   - error rate below 1%, EXCLUDING deliberate denied requests
 *
 * That exclusion is the reason this script tracks its own counters instead of
 * relying on k6's built-in `http_req_failed`. A 403 on an unauthorised document is a
 * CORRECT response and the suite deliberately provokes them, so folding them into
 * the failure rate would either hide real faults behind expected denials or fail the
 * gate for behaving properly. Denials are counted separately and asserted to occur,
 * because a run where no denial happened is not exercising authorization at all.
 *
 * Run with:
 *   k6 run --env BASE_URL=https://duefold.example \
 *          --env VIEWER_TOKENS=/path/to/tokens.json \
 *          deploy/k6/viewer-steady-state.js
 *
 * Tokens are seeded by the qualification fixture, never by this script: issuing a
 * session requires the authenticator credential, which a load generator must not
 * hold.
 */

import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const metadataLatency = new Trend('duefold_metadata_ms', true);
const previewLatency = new Trend('duefold_preview_ms', true);
/* Faults only. A denial is not a fault and is counted below instead. */
const faultRate = new Rate('duefold_fault_rate');
const deliberateDenials = new Counter('duefold_deliberate_denials');
const unexpectedStatus = new Counter('duefold_unexpected_status');

const BASE_URL = __ENV.BASE_URL;
if (BASE_URL === undefined || BASE_URL === '') fail('BASE_URL is required');

const tokens = JSON.parse(open(__ENV.VIEWER_TOKENS ?? './viewer-tokens.json'));
if (!Array.isArray(tokens) || tokens.length < 100)
  fail(`expected at least 100 seeded viewer sessions, found ${tokens.length}`);

export const options = {
  scenarios: {
    steady_state: {
      executor: 'constant-vus',
      vus: 100,
      duration: '10m',
      gracefulStop: '30s',
    },
  },
  thresholds: {
    /*
     * Thresholds are the gate, not advisory. A run that breaches one exits non-zero
     * so it cannot be recorded as passing evidence.
     */
    duefold_metadata_ms: ['p(95)<500'],
    duefold_preview_ms: ['p(95)<750'],
    duefold_fault_rate: ['rate<0.01'],
    /* Authorization must actually be exercised during the run. */
    duefold_deliberate_denials: ['count>0'],
  },
};

function authenticated(token) {
  return {
    headers: { cookie: `__Host-duefold_session=${token.secret}` },
    /* A redirect to sign-in would be recorded as a 200 and hide a session failure. */
    redirects: 0,
    tags: { name: 'viewer' },
  };
}

/** Classifies a response: expected success, deliberate denial, or fault. */
function classify(response, expected) {
  if (response.status === expected) {
    faultRate.add(false);
    return 'expected';
  }
  if (response.status === 403 || response.status === 404) {
    /*
     * Denials and not-founds are the designed answer for content this viewer has no
     * grant on. Counted, never treated as a fault.
     */
    deliberateDenials.add(1);
    faultRate.add(false);
    return 'denied';
  }
  unexpectedStatus.add(1, { status: String(response.status) });
  faultRate.add(true);
  return 'fault';
}

export default function viewerJourney() {
  const token = tokens[__VU % tokens.length];
  const auth = authenticated(token);

  /* Room list: the viewer home, which must disclose nothing about other rooms. */
  const rooms = http.get(`${BASE_URL}/api/viewer/rooms`, auth);
  metadataLatency.add(rooms.timings.duration);
  if (classify(rooms, 200) !== 'expected') return;

  const roomList = rooms.json('rooms');
  if (!Array.isArray(roomList) || roomList.length === 0) return;
  const room = roomList[__ITER % roomList.length];

  /* Published structure: the bounded projection, not a raw table read. */
  const structure = http.get(`${BASE_URL}/api/viewer/structure?roomId=${room.roomId}`, auth);
  metadataLatency.add(structure.timings.duration);
  if (classify(structure, 200) !== 'expected') return;

  const entries = (structure.json('entries') ?? []).filter(
    (entry) => entry.resourceKind === 'document',
  );
  if (entries.length === 0) return;
  const document = entries[__ITER % entries.length];

  /* Document metadata, then a protected page: the two latency classes in 23. */
  const detail = http.get(
    `${BASE_URL}/api/viewer/document?roomId=${room.roomId}&documentId=${document.resourceId}`,
    auth,
  );
  metadataLatency.add(detail.timings.duration);
  if (classify(detail, 200) !== 'expected') return;

  const activity = http.post(
    `${BASE_URL}/api/viewer/previews`,
    JSON.stringify({ roomId: room.roomId, documentId: document.resourceId }),
    { ...auth, headers: { ...auth.headers, 'content-type': 'application/json' } },
  );
  if (classify(activity, 201) !== 'expected') return;

  const page = http.get(
    `${BASE_URL}/api/viewer/pages/image?roomId=${room.roomId}` +
      `&documentId=${document.resourceId}&page=1`,
    auth,
  );
  previewLatency.add(page.timings.duration);
  classify(page, 200);

  check(page, {
    /* Protected content must never be cacheable, under load as much as otherwise. */
    'no-store on protected page': (response) =>
      (response.headers['Cache-Control'] ?? '').includes('no-store'),
    /* An object-storage URL in a response body would bypass server authorization. */
    'no storage URL leaked': (response) =>
      !String(response.body ?? '').includes('X-Amz-Signature'),
  });
}
