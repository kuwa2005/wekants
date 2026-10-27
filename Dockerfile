# syntax=docker/dockerfile:1.7

FROM rust:1-bookworm AS core
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build -p wekan-core-node --release \
    && cp target/release/libwekan_core_node.so /wekan-core-node.node

FROM node:22-bookworm-slim AS js
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/wekan-core-node/package.json packages/wekan-core-node/package.json
COPY packages/wekan-core-node/index.js packages/wekan-core-node/index.js
COPY packages/wekan-core-node/index.d.ts packages/wekan-core-node/index.d.ts
COPY --from=core /wekan-core-node.node packages/wekan-core-node/wekan-core-node.node
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages/shared ./packages/shared
RUN pnpm --filter @wekants/web build

FROM node:22-bookworm-slim AS api
WORKDIR /app
RUN corepack enable \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=js /app /app
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["pnpm", "--filter", "@wekants/api", "start"]

FROM nginx:1.27.5-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=js /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
