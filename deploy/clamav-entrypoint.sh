#!/bin/sh
# Starts clamd, then updates signatures in an order where the update can actually
# reach the running daemon.
#
# The upstream entrypoint starts freshclam first, so its initial update cannot
# notify clamd (the socket does not exist yet) and clamd serves the signatures
# baked into the image until the next scheduled cycle. Duefold rejects signatures
# older than 24 hours and fails closed, so that window is a publication outage.
# See deploy/clamav.Dockerfile for the observed failure.
#
# Order here:
#   1. clamd in the background, loading whatever is on disk;
#   2. wait for its socket, so a notification can be delivered;
#   3. one foreground freshclam, which updates AND notifies, making clamd's
#      in-memory database current before readiness can pass;
#   4. the freshclam daemon for subsequent cycles, which can now always notify.
#
# Readiness is still Duefold's own check against the VERSION reply, not this
# script. This only removes the guaranteed-stale startup state.
set -eu

CLAMD_SOCKET_TIMEOUT="${CLAMD_STARTUP_TIMEOUT:-1800}"
FRESHCLAM_CHECKS="${FRESHCLAM_CHECKS:-24}"

log() {
  printf '%s duefold-clamav: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1"
}

# clamd refuses to start without a database, and a first boot has none. This
# initial download deliberately skips notification: there is nothing to notify.
if [ ! -f /var/lib/clamav/main.cvd ] && [ ! -f /var/lib/clamav/main.cld ]; then
  log 'no signature database present, performing initial download'
  sed -e 's|^\(TestDatabases \)|#\1|' \
    -e '$a TestDatabases no' \
    -e 's|^\(NotifyClamd \)|#\1|' \
    /etc/clamav/freshclam.conf >/tmp/freshclam-initial.conf
  freshclam --foreground --stdout --config-file=/tmp/freshclam-initial.conf
  rm -f /tmp/freshclam-initial.conf
fi

# A stale socket from a previous container would make the wait below succeed
# immediately against a daemon that is not running.
for socket in /run/clamav/clamd.sock /tmp/clamd.sock; do
  [ -S "$socket" ] && unlink "$socket"
done

log 'starting clamd'
clamd --foreground &
clamd_pid=$!

elapsed=0
while [ ! -S /run/clamav/clamd.sock ] && [ ! -S /tmp/clamd.sock ]; do
  # If clamd died, waiting the full timeout would hide the real error.
  if ! kill -0 "$clamd_pid" 2>/dev/null; then
    log 'clamd exited before its socket appeared'
    wait "$clamd_pid"
    exit 1
  fi
  if [ "$elapsed" -gt "$CLAMD_SOCKET_TIMEOUT" ]; then
    log "clamd socket did not appear within ${CLAMD_SOCKET_TIMEOUT}s"
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
log 'clamd socket present'

# The point of this script. clamd is listening, so this update is notified and
# clamd reloads it; Duefold's freshness check sees current signatures rather than
# the image's. A failure here is not fatal: the signatures on disk may already be
# fresh enough, and Duefold fails closed on its own if they are not. Exiting would
# turn a transient mirror problem into a crash loop.
log 'updating signatures with clamd running, so the update is notified'
if freshclam --foreground --stdout --user=clamav; then
  log 'signature update complete and clamd notified'
else
  log 'signature update failed; Duefold will reject stale signatures on its own'
fi

log 'starting the freshclam daemon for subsequent updates'
freshclam --checks="$FRESHCLAM_CHECKS" --daemon --foreground --stdout --user=clamav &

# Terminate the container when clamd stops, rather than lingering with only
# freshclam alive and the scanner port closed.
wait "$clamd_pid"
