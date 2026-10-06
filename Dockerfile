# Stage 1: Build frontend
FROM node:22-alpine AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY vite.config.js tailwind.config.js postcss.config.js index.html ./
COPY src/ ./src/
COPY shared/ ./shared/
RUN npm run build

# Stage 2: Production image
FROM node:22-alpine
WORKDIR /app

# Install build deps for better-sqlite3, compile, then remove
RUN apk add --no-cache --virtual .build-deps python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev && apk del .build-deps

# 1Password CLI. server/hosts.js shells out to `op read` for a remote host's SSH
# key at connect time, so the key never lands in the database or a backup. The
# container already carries OP_SERVICE_ACCOUNT_TOKEN; without the binary that
# token is unusable and every SSH host probe fails with "spawn op ENOENT".
ARG OP_VERSION=2.31.1
RUN apk add --no-cache --virtual .op-deps unzip curl \
    && arch="$(uname -m)" \
    && case "$arch" in x86_64) oparch=amd64 ;; aarch64) oparch=arm64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
    && curl -fsSL -o /tmp/op.zip "https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_${oparch}_v${OP_VERSION}.zip" \
    && unzip -o -j /tmp/op.zip op -d /usr/local/bin \
    && chmod 755 /usr/local/bin/op \
    && rm -f /tmp/op.zip \
    && apk del .op-deps \
    && op --version

# Copy server code and built frontend
COPY server/ ./server/
COPY shared/ ./shared/
COPY --from=frontend /app/dist ./dist/
COPY policies/ ./policies/

ENV NODE_ENV=production
ENV POLICIES_DIR=/app/policies
ENV PORT=3002
ENV DATA_DIR=/data

EXPOSE 3002

CMD ["node", "server/index.js"]
