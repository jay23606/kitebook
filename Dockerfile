# Kitebook's SERVER as a container: the built Worker on plain workerd (selfhost/config.capnp), data in the /data volume.
#   docker compose up -d                     (docker-compose.yml: port 127.0.0.1:7820, optional cloudflared tunnel: --profile tunnel)
#   docker run -v relay-data:/data -p 127.0.0.1:7820:7820 ghcr.io/um1b/kitebook
# The admin token / recovery code: KITEBOOK_ADMIN_TOKEN (or KITEBOOK_ADMIN_TOKEN_FILE, e.g. a Docker secret); unset, the first start makes one in
# /data/admin-token (0600, inside the volume, never printed). The runner is NOT in here on purpose: it drives the coding agents, repos,
# git credentials and keychain on your own computer, which a container can't (and shouldn't) reach; install it natively (kitebook binary).
# The release workflow publishes this image to ghcr.io/um1b/kitebook (linux/amd64 + linux/arm64).
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# the bundle workerd serves, and workerd itself: the npm package's native binary, the version package-lock.json pins
RUN npx cf build && test -s .cloudflare/output/v0/workers/default/bundle/index.js \
 && cp "$(node -p 'require("workerd").default')" /workerd && /workerd --version

FROM debian:bookworm-slim
# ca-certificates: outbound https (push, S3, OAuth metadata); curl: the healthcheck. Unpinned on purpose: bookworm security fixes land on every rebuild.
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --user-group --home-dir /data --no-create-home kitebook \
 && mkdir -p /data && chown kitebook:kitebook /data && chmod 700 /data
COPY --from=build /workerd /usr/local/bin/workerd
COPY --from=build /src/.cloudflare/output/v0/workers/default/bundle/index.js /app/.cloudflare/output/v0/workers/default/bundle/index.js
COPY selfhost/config.capnp /app/selfhost/config.capnp
COPY selfhost/docker-entrypoint.sh /usr/local/bin/kitebook-server
USER kitebook
ENV KITEBOOK_DATA=/data PORT=7820
VOLUME ["/data"]
EXPOSE 7820 7821
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/kitebook-server"]
