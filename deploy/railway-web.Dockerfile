# Duefold web image for hosts without namespace support (Railway, and similar
# managed container platforms).
#
# READ docs/railway.md BEFORE USING THIS. It differs from deploy/web.Dockerfile in
# exactly one respect, and that respect is a security boundary: watermark
# composition runs through setpriv instead of bubblewrap, because Railway's
# runtime denies namespace creation (no CAP_SYS_ADMIN, measured 2026-09-20).
#
# The child runs as a throwaway UID (duefold-conv0..7), unprivileged, with
# no-new-privileges, bounded by the parent's timeout and output limits, and swept
# on exit. That UID separation is what keeps the service's credentials out of
# reach: /proc/<pid>/environ is readable by the owning UID, so a converter running
# as the service user could read the web process's environment directly.
#
# It is NOT filesystem- or network-isolated. A malicious document that exploits
# ImageMagick gets code execution as that throwaway UID with network access.
#
# bubblewrap is still installed so the same image can run the namespaced boundary
# on a capable host, and so `preflight sandbox` reports the truth rather than a
# missing binary.
ARG NODE_IMAGE=node:26.5.0-trixie@sha256:0473e7dc433a1310f436edee02aa79737ec78a4b345433ab0963d4a256f9ad85
FROM ${NODE_IMAGE} AS build

WORKDIR /srv/duefold
COPY . .
RUN npm ci
# Composition first: the client bundle imports the generated browser entries, so
# an omitted module must be absent from the bundle itself.
RUN npm run compose && npm run build --workspace @duefold/web-client

FROM ${NODE_IMAGE} AS runtime
WORKDIR /srv/duefold

COPY deploy/debian-snapshot.sources /etc/apt/sources.list.d/debian.sources

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    bubblewrap \
    fonts-noto-cjk \
    fonts-noto-mono \
    imagemagick \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

# Still enforced, and it matters more here than in the namespaced image: without
# filesystem isolation, ImageMagick's SVG/MSVG and URL/HTTPS coders would be the
# shortest path from a crafted upload to an outbound request or a local file read.
COPY deploy/imagemagick-policy.xml /etc/ImageMagick-7/policy.xml

COPY package.json package-lock.json ./
COPY --from=build /srv/duefold/apps ./apps
COPY --from=build /srv/duefold/modules ./modules
COPY --from=build /srv/duefold/packages ./packages
RUN npm ci --omit=dev
COPY --from=build /srv/duefold/.duefold ./.duefold
COPY --from=build /srv/duefold/composition*.manifest.json ./
COPY --from=build /srv/duefold/deploy/image-smoke.ts ./deploy/image-smoke.ts
COPY --from=build /srv/duefold/tsconfig*.json ./

# Invariant 17: an omitted module must be ABSENT from the artifact, not merely
# unreachable. Generating registries removes its import edges; this removes its
# source, and fails the build if a directory survives.
RUN node packages/composition/src/cli.ts prune

# Converter identities for degraded isolation. The watermark child runs as one of
# these instead of the service user, so it cannot read the service process's
# /proc/<pid>/environ and recover the database URL, storage keys, or OIDC secret.
RUN for offset in 0 1 2 3 4 5 6 7; do \
      uid=$((10200 + offset)); \
      groupadd --system --gid "$uid" "duefold-conv$offset"; \
      useradd --system --uid "$uid" --gid "$uid" --no-create-home \
        --shell /usr/sbin/nologin "duefold-conv$offset"; \
    done

# Deliberately root, unlike the namespaced image. Dropping to the service user
# would remove CAP_SETUID and make privilege separation impossible, which is the
# one thing keeping credentials away from an exploited converter here. The
# converter itself always runs unprivileged.
ENTRYPOINT ["node", "apps/web/src/main.ts"]
