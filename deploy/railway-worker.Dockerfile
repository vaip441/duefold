# Duefold worker image for hosts without namespace support (Railway, and similar
# managed container platforms).
#
# READ docs/railway.md BEFORE USING THIS. Identical tool set to
# deploy/worker.Dockerfile, one critical difference: the converters run through
# setpriv instead of bubblewrap, because Railway's runtime denies namespace
# creation (no CAP_SYS_ADMIN, measured 2026-09-20).
#
# This is the image where the difference bites hardest. LibreOffice and MuPDF
# parse attacker-supplied bytes, and here they do so with a view of the container
# filesystem and the network. They run as a throwaway UID (duefold-conv0..7)
# rather than as the worker, so they cannot read the worker's
# /proc/<pid>/environ and recover its credentials; they cannot gain privileges;
# and every process owned by that UID is killed when the job ends, which a
# process-group kill alone would not achieve because setsid escapes it.
# A converter exploit becomes code execution as an unprivileged throwaway UID
# with network access.
#
# The digest pin carries the same meaning as the namespaced image: the tools that
# document-format policy was qualified against must not change silently.
ARG NODE_IMAGE=node:26.5.0-trixie@sha256:0473e7dc433a1310f436edee02aa79737ec78a4b345433ab0963d4a256f9ad85
FROM ${NODE_IMAGE} AS base

COPY deploy/debian-snapshot.sources /etc/apt/sources.list.d/debian.sources

# Same converter set as the namespaced worker, for the same reasons:
#   mupdf-tools   PDF page rasterisation and text extraction
#   libreoffice   office-format conversion to PDF
#   imagemagick   raster branding and watermark composition
#   bubblewrap    retained so this image still works on a capable host
#   util-linux    setpriv, which drops privileges in both modes
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

# Load-bearing here. Without a namespace, the SVG/MSVG coders and the URL/HTTPS
# coders are a direct path from a crafted upload to outbound requests and local
# file reads, so this policy is the remaining barrier rather than a second one.
COPY deploy/imagemagick-policy.xml /etc/ImageMagick-7/policy.xml

WORKDIR /srv/duefold
COPY . .
# The services run node directly; npm and its bundled dependencies are not needed
# at runtime, so they are removed rather than shipped.
RUN npm ci --omit=dev \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Invariant 17: an omitted module must be ABSENT from the artifact, not merely
# unreachable. This generates the registries and then deletes the source of every
# omitted module, failing the build if any directory survives.
RUN node packages/composition/src/cli.ts prune

# Converter identities for degraded isolation. LibreOffice, MuPDF, and
# ImageMagick run as one of these rather than as the service user, so an exploited
# converter cannot read the worker's /proc/<pid>/environ and recover the database
# URL, storage credentials, or key material. Eight identities also bound how many
# untrusted converters can run at once.
RUN for offset in 0 1 2 3 4 5 6 7; do \
      uid=$((10200 + offset)); \
      groupadd --system --gid "$uid" "duefold-conv$offset"; \
      useradd --system --uid "$uid" --gid "$uid" --no-create-home \
        --shell /usr/sbin/nologin "duefold-conv$offset"; \
    done

RUN mkdir -p /var/lib/duefold/scratch && chmod 0700 /var/lib/duefold/scratch

# Deliberately root, unlike the namespaced worker image, which runs as uid 10001.
# Privilege separation needs CAP_SETUID to drop the converter to another uid, and
# that separation is what keeps credentials out of reach of a converter exploit
# when no namespace is available. The converters themselves never run as root.
ENTRYPOINT ["node", "apps/worker/src/main.ts"]
