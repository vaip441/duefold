#!/bin/sh
# Duefold host isolation probe.
#
# Answers one question about a candidate host: can Duefold's production sandbox
# exist there? It carries no credentials, touches no database, and stores
# nothing, so it is safe to run on a platform that has not been trusted yet.
#
# The per-feature report comes from the product's own preflight, the same code
# the worker refuses to start against. Everything after it is diagnostic
# evidence for WHY a feature is absent, because "namespaces=absent" alone does
# not distinguish a blocked syscall from a missing binary, and the distinction
# decides whether a host is fixable by configuration or not at all.
#
# Usage:
#   sh deploy/preflight-probe.sh                 report, then idle (container entrypoint)
#   sh deploy/preflight-probe.sh --report-only   report, then exit with the verdict
#
# Prefer --report-only over a container log. Some platforms do not capture an
# entrypoint's stdout, and a silent log reads like a crash; run it over the
# platform's exec/SSH facility instead and you always get the text.
set -eu

printf '=== duefold preflight sandbox ===\n'
verdict=0
node apps/cli/src/main.ts preflight sandbox || verdict=$?

printf '\n=== bubblewrap (why namespaces may be absent) ===\n'
# The product preflight deliberately swallows sandbox errors and reports
# `absent`. A host evaluation needs the message itself: "Permission denied" from
# a blocked clone is a different problem from a missing binary or a failed mount.
if /usr/bin/bwrap --unshare-user --unshare-pid --unshare-net --unshare-ipc \
  --unshare-uts --unshare-cgroup --die-with-parent --new-session \
  --ro-bind /bin /bin --ro-bind /usr /usr --ro-bind /lib /lib \
  --proc /proc /bin/true 2>&1; then
  printf 'bwrap created a namespace successfully\n'
else
  printf 'bwrap exit=%s (message above, if any)\n' "$?"
fi

printf '\n=== namespace permission per type ===\n'
# Separates a platform filter from a kernel setting. If the sysctls below permit
# user namespaces but every type is denied here, the denial belongs to the
# container runtime's capability set and seccomp filter, not the host kernel.
for flag in --user --mount --pid --net --ipc --uts --cgroup; do
  if /usr/bin/unshare "$flag" /bin/true 2>/dev/null; then
    printf '%s=allowed\n' "$flag"
  else
    printf '%s=denied (%s)\n' "$flag" \
      "$(/usr/bin/unshare "$flag" /bin/true 2>&1 | head -1 || true)"
  fi
done

printf '\n=== capabilities ===\n'
# CAP_SYS_ADMIN is the one bubblewrap needs to build the inner mount namespace.
grep -E '^(CapEff|CapBnd|CapPrm):' /proc/self/status 2>/dev/null || printf 'unreadable\n'

printf '\n=== cgroup limits (bounded resources) ===\n'
for file in /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/pids.max; do
  printf '%s=%s\n' "$file" "$(cat "$file" 2>/dev/null || printf 'unreadable')"
done
printf 'cgroup=%s\n' "$(cat /proc/self/cgroup 2>/dev/null || printf 'unreadable')"

printf '\n=== scratch mounts (bounded tmpfs) ===\n'
# A bounded tmpfs is what the worker requires for /tmp and the scratch root.
# A platform disk volume mounted at the same path is NOT equivalent: it has no
# size= option in mountinfo and is not memory-backed.
grep -E ' (/tmp|/var/lib/duefold/scratch) ' /proc/self/mountinfo || printf 'no matching mount\n'

printf '\n=== kernel ===\n'
printf 'uname=%s\n' "$(uname -srm)"
printf 'seccomp=%s\n' "$(grep -E '^Seccomp:' /proc/self/status 2>/dev/null || printf 'unreadable')"
printf 'nonewprivs=%s\n' "$(grep -E '^NoNewPrivs:' /proc/self/status 2>/dev/null || printf 'unreadable')"
printf 'max_user_namespaces=%s\n' "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || printf 'unreadable')"
printf 'userns_clone=%s\n' "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || printf 'unset')"
printf 'uid=%s\n' "$(id -u)"

printf '\n=== probe complete ===\n'

# Exits with the preflight's verdict so a pipeline can gate on it.
if [ "${1:-}" = '--report-only' ]; then
  exit "$verdict"
fi

# As a container entrypoint, stays resident instead. A one-shot container on a
# restart-looping platform would repeat the report indefinitely; this prints it
# once and idles so the output stays retrievable. Delete the service when done.
exec sleep infinity
