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
#
# Base: node:24-trixie-slim (Debian 13 + Node 24, official upstream).
# Same family as signalk-updater-server / signalk-doctor-server. Swapped
# from Wolfi after the 0.6.4/0.6.5 SIGILL chain — Wolfi's nodejs-24 build
# triggered undici crashes (illegal instruction) on Cortex-A76 / Pi 5.
# Trixie ships the official upstream Node binary which the project
# test-builds against, so the SIGILL root cause goes away at the base
# layer instead of being papered over with `http.get` in callsites.
# Trade-off: ~210MB final vs ~110MB on Wolfi — irrelevant on a Pi/NVMe.

ARG VERSION=0.1.0

# =============================================================================
# Stage 1: Build backend (TypeScript → ESM)
# =============================================================================
FROM node:24-trixie-slim AS backend-builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm exec tsc

# =============================================================================
# Stage 2: Production image
# =============================================================================
FROM node:24-trixie-slim

# tini    — PID-1 signal handling.
# ca-certificates — TLS for HTTPS pulls (kopia, rclone, GHCR).
# wget / unzip — required by the kopia and rclone install steps below;
#                purged afterward to keep the image lean.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates wget unzip \
 && rm -rf /var/lib/apt/lists/*

# Install Kopia (content-addressable deduplicated snapshots)
ARG KOPIA_VERSION=0.23.1
ARG TARGETARCH
RUN KOPIA_ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "x64") && \
    wget -q "https://github.com/kopia/kopia/releases/download/v${KOPIA_VERSION}/kopia-${KOPIA_VERSION}-linux-${KOPIA_ARCH}.tar.gz" -O /tmp/kopia.tar.gz && \
    mkdir -p /usr/local/bin && \
    tar xzf /tmp/kopia.tar.gz --strip-components=1 -C /usr/local/bin/ && \
    chmod +x /usr/local/bin/kopia && \
    rm /tmp/kopia.tar.gz

# Install rclone (Google Drive sync transport)
ARG RCLONE_VERSION=1.74.3
RUN wget -q "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${TARGETARCH}.zip" \
        -O /tmp/rclone.zip && \
    unzip -j /tmp/rclone.zip '*/rclone' -d /usr/local/bin/ && \
    chmod +x /usr/local/bin/rclone && \
    rm /tmp/rclone.zip

# Purge the install-only tools now that kopia + rclone are in /usr/local/bin.
RUN apt-get purge -y --auto-remove wget unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install prod deps with npm, then remove npm itself: the runtime only runs
# `node dist/server.js`, never a package manager. npm bundles its own copies
# of tar/undici etc. under node_modules/npm, which Trivy flags as CVEs even
# though they are never invoked here. Dropping npm clears those findings and
# trims the image. Done in one layer so the removed files leave no trace.
COPY package*.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm /usr/local/bin/npx

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

# Kept on http.get even though the trixie base no longer SIGILLs in undici —
# this matches the 0.6.4 fix line, leaves no fetch() calls in the runtime
# command surface, and survives any future regression.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "const r=require('http').get('http://127.0.0.1:3010/api/health',res=>{res.resume();process.exit(res.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(5000,()=>{r.destroy();process.exit(1)})"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]

ARG VERSION
LABEL org.opencontainers.image.title="signalk-backup-server" \
      org.opencontainers.image.description="Headless backup engine for the signalk-backup plugin" \
      org.opencontainers.image.source="https://github.com/dirkwa/signalk-backup-server" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
