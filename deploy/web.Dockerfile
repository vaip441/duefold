# Duefold web image.
#
# The web process is credential-bearing and executes no unconstrained document tools.
# Watermark composition executes in an isolated child sandbox (bubblewrap) with an
# empty root, no network egress, private mounts, and dropped capabilities
# (setpriv --no-new-privs), so untrusted page parsing and image composition cannot
# access the web process's credentials or database pools. The heavy converters
# (LibreOffice, MuPDF) and malware scanner remain worker-only.
#
# Digest-pinned for the same reason as the worker image.
ARG NODE_IMAGE=node:26.5.0-trixie@sha256:0473e7dc433a1310f436edee02aa79737ec78a4b345433ab0963d4a256f9ad85
FROM ${NODE_IMAGE} AS build

WORKDIR /srv/duefold
COPY . .
RUN npm ci
# Composition first: the client bundle imports the generated browser entries, so an
# omitted module must be absent from the bundle itself.
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

# Invariant 17: generating registries removes import edges, but omitted module
# source must also be absent from the runtime artifact.
RUN node packages/composition/src/cli.ts prune

RUN useradd --system --uid 10002 duefold
USER duefold

# Fails closed when DUEFOLD_DATABASE_URL and DUEFOLD_AUTH_DATABASE_URL resolve to the
# same role: assertDistinctDatabaseRoles compares current_user across both pools at
# startup, so a misconfiguration that collapses the authenticator into the runtime
# role refuses to boot rather than silently allowing session forgery.
# The web process requires its own fixed watermark executable and font; startup
# fails if either declared path is absent.
ENTRYPOINT ["node", "apps/web/src/main.ts"]
