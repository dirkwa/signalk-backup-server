# signalk-backup-server — Container Image
# Multi-stage build with Wolfi (glibc) base for minimal size and security
#
# This image runs the headless backup engine. It is launched and managed
# by the signalk-backup plugin via signalk-container's `ensureRunning()`.
# The plugin sets DATA_DIR, SIGNALK_DATA_PATH, GUI_PUBLIC_URL, and
# SIGNALK_VERSION at start. Persisted state lives at DATA_DIR.

ARG VERSION=0.1.0

# =============================================================================
# Stage 1: Build frontend (Vite React UI)
# =============================================================================
FROM cgr.dev/chainguard/wolfi-base:latest AS frontend-builder

ARG VERSION

RUN apk add --no-cache nodejs-24 npm \
    && rm -f /usr/lib/node_modules/npm/npmrc

WORKDIR /app/ui

COPY src/ui/package*.json ./
RUN npm install

COPY src/ui/ ./
ENV VITE_APP_VERSION=${VERSION}
RUN npm run build

# =============================================================================
# Stage 2: Build backend (TypeScript → ESM)
# =============================================================================
FROM cgr.dev/chainguard/wolfi-base:latest AS backend-builder

RUN apk add --no-cache nodejs-24 npm \
    && rm -f /usr/lib/node_modules/npm/npmrc

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm exec tsc

# =============================================================================
# Stage 3: Production image
# =============================================================================
FROM cgr.dev/chainguard/wolfi-base:latest

# Node 24 + tini for proper PID-1 signal handling. No dbus (keeper used it
# for systemd self-upgrade, which we don't do — the plugin handles upgrades
# via signalk-container's update mechanism).
RUN apk add --no-cache nodejs-24 npm tini \
    && rm -f /usr/lib/node_modules/npm/npmrc

# Install Kopia (content-addressable deduplicated snapshots)
ARG KOPIA_VERSION=0.22.3
ARG TARGETARCH
RUN KOPIA_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "x64") && \
    apk add --no-cache wget && \
    wget -q "https://github.com/kopia/kopia/releases/download/v${KOPIA_VERSION}/kopia-${KOPIA_VERSION}-linux-${KOPIA_ARCH}.tar.gz" -O /tmp/kopia.tar.gz && \
    mkdir -p /usr/local/bin && \
    tar xzf /tmp/kopia.tar.gz --strip-components=1 -C /usr/local/bin/ && \
    chmod +x /usr/local/bin/kopia && \
    rm /tmp/kopia.tar.gz && \
    apk del wget

# Install rclone (Google Drive sync transport)
ARG RCLONE_VERSION=1.69.2
RUN apk add --no-cache wget unzip && \
    wget -q "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${TARGETARCH}.zip" \
        -O /tmp/rclone.zip && \
    unzip -j /tmp/rclone.zip '*/rclone' -d /usr/local/bin/ && \
    chmod +x /usr/local/bin/rclone && \
    rm /tmp/rclone.zip && \
    apk del wget unzip

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=backend-builder /app/dist ./dist
COPY --from=frontend-builder /app/ui/dist ./src/ui/dist

# DATA_DIR is the only path that needs to exist before start; everything
# else (kopia repo, rclone.conf, install-id) is created on demand under it.
RUN mkdir -p /data

ENV NODE_ENV=production \
    PORT=3010 \
    DATA_DIR=/data \
    SIGNALK_DATA_PATH=/signalk-data \
    LOG_LEVEL=info

EXPOSE 3010

# rclone OAuth callback (only used during Drive setup; quiet otherwise)
EXPOSE 53682

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:3010/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]

ARG VERSION
LABEL org.opencontainers.image.title="signalk-backup-server" \
      org.opencontainers.image.description="Headless backup engine for the signalk-backup plugin" \
      org.opencontainers.image.source="https://github.com/dirkwa/signalk-backup-server" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
