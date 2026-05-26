# signalk-backup-server — Container Image
#
# Headless backup engine. Launched and managed by the signalk-backup
# plugin via signalk-container's `ensureRunning()`. The plugin sets
# DATA_DIR, SIGNALK_DATA_PATH, and SIGNALK_VERSION; persisted state lives
# at DATA_DIR.
#
# No UI. The user-facing UI lives in the plugin's webapp (mounted by
# SignalK at /signalk-backup/) and reaches us via the plugin's
# reverse-proxy at /plugins/signalk-backup/api/.

ARG VERSION=0.1.0

# =============================================================================
# Stage 1: Build backend (TypeScript → ESM)
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
# Stage 2: Production image
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

# DATA_DIR is the only path that needs to exist before start; everything
# else (kopia repo, rclone.conf, install-id) is created on demand under it.
RUN mkdir -p /data

# HOME=/data so kopia and rclone find a writable home regardless of the
# uid the runtime starts the container under. signalk-container emits
# `--user <hostUid>:<hostGid>` on rootful podman / docker and `--userns=
# keep-id` on rootless podman; under the former, the container process
# does not own / and the default HOME (which would be /root or unset
# entirely without a passwd entry for the host uid) is read-only, so
# `kopia` falls back to `/app/.cache` and explodes ("mkdir /app/.cache:
# permission denied"). Pointing HOME at the bind-mounted DATA_DIR makes
# `~/.cache`, `~/.config`, `~/.kopia` etc. resolve to the bind mount
# (which is always writable by the runtime uid because the host directory
# is owned by the same user). Image stays uid-agnostic; no USER directive
# or chown sweeps needed.
ENV NODE_ENV=production \
    HOME=/data \
    PORT=3010 \
    DATA_DIR=/data \
    SIGNALK_DATA_PATH=/signalk-data \
    LOG_LEVEL=info

EXPOSE 3010

# rclone OAuth callback (only used during Drive setup; quiet otherwise)
EXPOSE 53682

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3010/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]

ARG VERSION
LABEL org.opencontainers.image.title="signalk-backup-server" \
      org.opencontainers.image.description="Headless backup engine for the signalk-backup plugin" \
      org.opencontainers.image.source="https://github.com/dirkwa/signalk-backup-server" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
