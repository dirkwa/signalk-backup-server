# signalk-backup-server

Headless backup engine container for the [signalk-backup](https://github.com/dirkwa/signalk-backup) plugin. Runs Kopia for content-addressable deduplicated snapshots and rclone for optional Google Drive sync.

You normally don't run this container directly — install the [signalk-backup](https://github.com/dirkwa/signalk-backup) plugin into your SignalK server. The plugin asks [signalk-container](https://github.com/dirkwa/signalk-container) to pull and start this image, plumbs in the right env vars, and exposes the engine's UI as a SignalK webapp.

## What it does

- **Snapshot** SignalK config files (and optionally history) using [Kopia](https://kopia.io/) — content-addressable, deduplicated, encrypted at rest
- **Schedule** hourly / daily / weekly / startup tiers with independent retention
- **Sync** to a local destination (USB drive, NAS, any mounted volume) or to Google Drive via [rclone](https://rclone.org/) with `drive.file` scope (the app only sees files it created)
- **Restore** with safety-backup rollback — every full restore creates a snapshot of current state first; partial restores stash the existing target before overwriting
- **Selective restore** — browse any snapshot's file tree (`GET /api/backups/:id/tree`), download a single file or whole subdirectory (`/download-subtree`), or restore one sub-path in-place under signalkDataPath (`/restore-partial`). The plugin's host-side writer handles restores to arbitrary host paths outside the container's view
- **Expose** an Express HTTP API (default port 3010). Headless — the user-facing UI is the [signalk-backup](https://github.com/dirkwa/signalk-backup) plugin's webapp, mounted into SignalK at `/signalk-backup/`

## Image

`ghcr.io/dirkwa/signalk-backup-server` (multi-arch: linux/amd64, linux/arm64).

Tags:

- `:X.Y.Z` — pinned stable release (e.g. `:0.4.0`). The signalk-backup plugin's default `imageTag: "auto"` resolves to the `BACKUP_SERVER_VERSION` constant hard-coded in [signalk-backup/src/config/image-tag.ts](https://github.com/dirkwa/signalk-backup/blob/main/src/config/image-tag.ts), so a plugin release pins a known-good server version. Plugin and server are released independently — bumping that constant is a deliberate act in its own PR.
- `:latest` — floating tag pointing at the most recent stable release. Users can set `imageTag: "latest"` to follow the freshest server release without changing the plugin.
- `:X.Y.Z-beta.N` — prereleases for opt-in testing. Not promoted to `:latest`. Testers set `imageTag` explicitly in the plugin config.

## Configuration (env)

The signalk-backup plugin sets all of these for you. Listed here for reference / direct-run debugging:

| Variable            | Default                 | Description                                                                                                                                                          |
| ------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`              | `3010`                  | HTTP listen port (must match `signalkAccessiblePorts` in the plugin)                                                                                                 |
| `DATA_DIR`          | `/data`                 | Where the engine persists its own state (settings.json, kopia repo, rclone.conf, install-id). Plugin sets this to `/signalk-data/plugin-config-data/signalk-backup`. |
| `SIGNALK_DATA_PATH` | `/signalk-data`         | Path inside the container where the SignalK data dir is mounted. Used as the source for backups.                                                                     |
| `SIGNALK_VERSION`   | `unknown`               | SignalK server version (used to tag backups). Plugin reads from ServerAPI and forwards.                                                                              |
| `GUI_PUBLIC_URL`    | (computed from request) | Public URL the user's browser uses to reach the UI. Plugin sets this from `signalk-container.resolveContainerAddress`.                                               |
| `LOG_LEVEL`         | `info`                  | Pino log level: trace/debug/info/warn/error/fatal                                                                                                                    |
| `NODE_ENV`          | `production`            | Set to `development` for pretty-printed pino logs                                                                                                                    |
| `MAX_UPLOAD_SIZE`   | `1073741824` (1 GB)     | Cap on ZIP imports                                                                                                                                                   |
| `HOME`              | `/data`                 | Home directory for kopia and rclone (`~/.cache`, `~/.config`). Defaults to `DATA_DIR` so child processes find a writable home regardless of the runtime uid.         |

## API

All routes mounted under `/api/`. Full OpenAPI spec at `/api/openapi.json` and Swagger UI at `/api/docs`.

| Group               | Notable routes                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backups             | `GET /api/backups`, `POST /api/backups`, `GET /api/backups/:id`, `DELETE /api/backups/:id`, `POST /api/backups/:id/restore`, `POST /api/backups/upload`, `GET /api/backups/:id/download` |
| Selective restore   | `GET /api/backups/:id/tree`, `GET /api/backups/:id/download-subtree`, `POST /api/backups/:id/restore-partial`                                                                            |
| Partial-restore SSE | `GET /api/backups/restore-partial/status`, `GET /api/backups/restore-partial/stream`, `POST /api/backups/restore-partial/reset`                                                         |
| Scheduler           | `GET /api/backups/scheduler`, `POST /api/backups/scheduler/start`, `POST /api/backups/scheduler/stop`                                                                                   |
| Cloud sync          | `GET /api/cloud/status`, `POST /api/cloud/sync`, `GET /api/cloud/installs`, `POST /api/cloud/restore/prepare`, `POST /api/cloud/restore/start`, `POST /api/cloud/restore/reset`          |
| GDrive              | `POST /api/cloud/gdrive/connect`, `POST /api/cloud/gdrive/disconnect`, `POST /api/cloud/gdrive/auth-state`, `POST /api/cloud/gdrive/auth-callback`, `POST /api/cloud/gdrive/cancel`      |
| Settings            | `GET /api/settings`, `PUT /api/settings`                                                                                                                                                |
| Operations          | `GET /api/operations`, `GET /api/operations/:id`                                                                                                                                        |
| Health              | `GET /api/health`                                                                                                                                                                       |
| GUI URL             | `GET /api/gui-url` *(legacy — the plugin's webapp now serves the user-facing UI; this route is kept for backwards compat with older signalk-backup releases)*                           |

## Direct run (debugging)

The container needs two mounts:

- `SIGNALK_DATA_PATH` — bind-mount the SignalK data dir you want to back up (read at runtime).
- `DATA_DIR` — engine state (kopia repo, settings.json, rclone.conf). Must be writable by whatever uid the container runs as.

For local cloud-sync destinations the engine looks at `/host-media` (bind from `/media`) and `/host-mnt` (bind from `/mnt`) — add those mounts if you want to test the local provider directly.

`HOME` defaults to `DATA_DIR` so kopia and rclone find a writable home regardless of the runtime uid; under the signalk-backup plugin signalk-container starts this image as the SignalK user via `--user` (or `--userns=keep-id` on rootless Podman). Running the image without `--user`, like the example below, lets it run as root inside the container — fine for debugging, but written files land owned by root on the host.

```bash
docker run --rm -p 3010:3010 \
  -v "$HOME/.signalk:/signalk-data" \
  -v signalk-backup-state:/data \
  -e SIGNALK_DATA_PATH=/signalk-data \
  -e DATA_DIR=/data \
  -e LOG_LEVEL=debug \
  ghcr.io/dirkwa/signalk-backup-server:latest

# Then browse to http://localhost:3010/
```

## Build locally

```bash
docker build -t signalk-backup-server:dev .
# Multi-arch (requires buildx):
docker buildx build --platform linux/amd64,linux/arm64 -t signalk-backup-server:dev .
```

## Develop

```bash
npm install
npm run dev          # tsx watch on src/server.ts — restarts on every edit
```

The dev server listens on `PORT` (default 3010). It's an API-only Express app — the user-facing UI lives in the [signalk-backup](https://github.com/dirkwa/signalk-backup) plugin's webapp, so iterating on UI is a separate workflow over there.

For quick API probing while developing:

- Swagger UI: <http://localhost:3010/api/docs>
- OpenAPI JSON: <http://localhost:3010/api/openapi.json>

Lint/format/test:

```bash
npm run format       # prettier --write + eslint --fix
npm run build:all    # lint + tsc + vitest
```

## License

Apache-2.0

## Acknowledgements

- [Kopia](https://kopia.io/) — backup engine
- [rclone](https://rclone.org/) — cloud transport
- Container base: [Wolfi](https://wolfi.dev/) (Chainguard) — minimal, security-hardened Linux distribution
- Origin: extracted from [signalk-universal-installer/keeper](https://github.com/signalk/signalk-universal-installer/tree/main/keeper) (Apache-2.0)
