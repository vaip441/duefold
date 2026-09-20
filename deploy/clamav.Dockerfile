# ClamAV image with a deterministic signature-freshness startup.
#
# WHY THIS EXISTS. Duefold rejects signatures older than 24 hours and fails
# closed, so a scanner that answers on port 3310 while serving the signatures
# baked into the image is an outage, not a warning. The upstream entrypoint makes
# that the normal cold-start outcome:
#
#   1. freshclam starts BEFORE clamd and downloads the current daily database;
#   2. it then tries to notify clamd through /tmp/clamd.sock, which does not
#      exist yet, and logs
#      "WARNING: Clamd was NOT notified: Can't connect to clamd through
#      /tmp/clamd.sock: No such file or directory";
#   3. clamd starts afterwards and loads whatever was on disk when it began.
#
# Observed on a deployed service: clamd reported signature 28123 from image build
# time while /var/lib/clamav/daily.cld on the same container was already 28129.
# Duefold correctly refused to publish anything. It self-heals only on freshclam's
# next scheduled cycle, which is up to an hour later and invisible.
#
# The fix is ordering, not a longer timeout: start clamd first, wait for its
# socket, and only then run one foreground freshclam that CAN notify it. The
# daemon starts after that, so every later update is notified too.
ARG CLAMAV_IMAGE=clamav/clamav-debian:1.5@sha256:cc16781fe005e49de6a8fc1231b63b265f74b18fc2a6347c670c35716914c3b6
FROM ${CLAMAV_IMAGE}

# The upstream entrypoint's own freshclam daemon is disabled, because this script
# owns update ordering. Leaving both running would reintroduce the unnotified
# first update it exists to prevent.
ENV CLAMAV_NO_FRESHCLAMD=true

COPY deploy/clamav-entrypoint.sh /usr/local/bin/duefold-clamav-entrypoint.sh
RUN chmod 0755 /usr/local/bin/duefold-clamav-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/duefold-clamav-entrypoint.sh"]
