# The Deployer's image (design §8.2, §8.6). Node runs the server's TypeScript directly (type stripping) with its
# built-in node:sqlite; the page is built here under DEPLOYER_BASE_PATH, so an image serves one base path. The
# container gets no Docker socket and no registry credentials: the executors on the hosts do all of that. The labels
# tell the executor that upgrades it (D16) which version this is and which executor protocols it speaks.
#   bin/build-image.sh [registry]
FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY src ./src
ARG DEPLOYER_BASE_PATH=/deploy
RUN DEPLOYER_BASE_PATH="$DEPLOYER_BASE_PATH" npm run build:web \
 && npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
ARG VERSION=dev
ARG REVISION=unknown
ARG DEPLOYER_BASE_PATH=/deploy
LABEL org.opencontainers.image.title="Open Atlas Deployer" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION \
      org.open-atlas.version=$VERSION \
      org.open-atlas.executor-protocols="2"
WORKDIR /opt/open-atlas-deployer
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist/web ./dist/web
COPY package.json ./
COPY src/server ./src/server
COPY src/compose ./src/compose
COPY src/env ./src/env
COPY src/manifest ./src/manifest
COPY schema ./schema
COPY templates ./templates
COPY manifests ./manifests
COPY agents ./agents
COPY bin ./bin
# The state (deployer.db, environment.json, templates kept from assessments) lives in /data/deployer, a host
# directory owned by 1000:1000; files the settings point at (tokens, keys) must be readable by 1000 too.
RUN mkdir -p /data/deployer && chown 1000:1000 /data/deployer
ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    DEPLOYER_DATA=/data/deployer \
    DEPLOYER_BIND=0.0.0.0 \
    DEPLOYER_PORT=8095 \
    DEPLOYER_BASE_PATH=$DEPLOYER_BASE_PATH \
    DEPLOYER_VERSION=$VERSION
USER 1000:1000
EXPOSE 8095
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DEPLOYER_PORT||8095)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server/index.ts"]
