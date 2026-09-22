# Duefold worker image.
#
# The worker is the ONLY component that executes third-party binaries against
# untrusted document bytes, so this image exists to make the sandbox preflight in
# modules/rooms-documents/src/processing/preflight.ts report `supported: true`.
# That preflight probes real enforcement -- it launches a child and inspects its
# namespaces, NoNewPrivs, cgroup limits, and mount visibility -- so nothing here can
# satisfy it by merely installing a package.
#
# Pinned by digest, not tag: a tag is mutable and would silently change the
# converter set that document-format policy is qualified against. The
# disabled/enabled release-policy digests in release-policy.ts pin the POLICY; these
# pin the TOOLS.
#
# Pinned to the multi-arch index digest of Node.js 26.5.0.
ARG NODE_IMAGE=node:26.5.0-trixie@sha256:0473e7dc433a1310f436edee02aa79737ec78a4b345433ab0963d4a256f9ad85
FROM ${NODE_IMAGE} AS base

COPY deploy/debian-snapshot.sources /etc/apt/sources.list.d/debian.sources

# Third-party binaries the processing pipeline spawns. Each is credential-free: the
# sandbox passes bytes on stdin and reads stdout, and no environment variable
# carrying a secret crosses the boundary (see sandboxEnvironmentKeys).
#
#   mupdf-tools   PDF page rasterisation and text extraction
#   libreoffice   office-format conversion to PDF
#   imagemagick   raster branding and watermark composition
#   bubblewrap    the unprivileged sandbox itself
#   util-linux    setpriv, used to drop capabilities before exec
# Upgrade the base image's own packages from the same pinned snapshot, so the
# image carries the snapshot's security fixes rather than the base image's.
RUN apt-get update \
  && apt-get upgrade --yes --with-new-pkgs --no-install-recommends \
  && apt-get install --yes --no-install-recommends \
    bubblewrap \
    fonts-noto-cjk \
    fonts-noto-mono \
    imagemagick \
    libreoffice-calc \
    libreoffice-writer \
    mupdf-tools \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

# ImageMagick's default policy permits formats Duefold must never decode. SVG and
# MSVG are script-bearing, and the URL/HTTPS coders would let a crafted file make an
# outbound request from inside processing.
COPY deploy/imagemagick-policy.xml /etc/ImageMagick-7/policy.xml

WORKDIR /srv/duefold
COPY . .
# The services run node directly; npm and its bundled dependencies are not needed
# at runtime, so they are removed rather than shipped.
RUN npm ci --omit=dev \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# The composed registry is a build-time artifact: an omitted module must be absent
# from the image, not merely disabled at runtime. `prune` verifies the registries
# and removes omitted module source from the runtime filesystem.
RUN node packages/composition/src/cli.ts prune

# Unprivileged. The sandbox drops further privileges per invocation, but the worker
# process itself must never run as root.
RUN useradd --system --create-home --uid 10001 duefold \
  && mkdir -p /var/lib/duefold/scratch \
  && chown -R duefold:duefold /var/lib/duefold
USER duefold

ENTRYPOINT ["node", "apps/worker/src/main.ts"]
