# Duefold host isolation probe image.
#
# NOT a Duefold deployment. It builds no client bundle, opens no port, and reads
# no credential. Its only purpose is to report whether a candidate host can
# support the production sandbox, before anyone configures a database, storage,
# or an identity provider there.
#
# It mirrors the worker image's sandbox-relevant layer — bubblewrap, setpriv,
# and the same Node version — so its answer transfers to the real worker. It
# deliberately omits LibreOffice, MuPDF, and ImageMagick: those decide whether
# conversion works, not whether isolation exists, and omitting them keeps the
# probe small enough to build on a constrained platform.
ARG NODE_IMAGE=node:26.5.0-trixie@sha256:0473e7dc433a1310f436edee02aa79737ec78a4b345433ab0963d4a256f9ad85
FROM ${NODE_IMAGE}

COPY deploy/debian-snapshot.sources /etc/apt/sources.list.d/debian.sources

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    bubblewrap \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/duefold
COPY . .
RUN npm ci --omit=dev

# This probe is not a production artifact and needs only the CLI plus the module
# graph it imports. Remove repository-only material so a diagnostic image cannot
# accidentally publish tests, documentation, or release workflows.
RUN rm -rf .github .agents .claude .impeccable .pi docs test test-results \
  && find apps modules packages deploy -type f \
    \( -name '*.test.ts' -o -name '*.spec.ts' -o -name '*.unit.test.tsx' \) -delete \
  && npm run compose

# Unprivileged, like the real worker. Running the probe as root would report an
# isolation boundary the production process never has.
RUN useradd --system --create-home --uid 10001 duefold \
  && mkdir -p /var/lib/duefold/scratch \
  && chown -R duefold:duefold /var/lib/duefold
USER duefold

ENTRYPOINT ["/bin/sh", "deploy/preflight-probe.sh"]
