# signalk-backup-server

Headless backup engine container for the [signalk-backup](https://github.com/dirkwa/signalk-backup) plugin. Runs Kopia for content-addressable deduplicated snapshots and rclone for optional Google Drive sync.

You normally don't run this container directly — install the [signalk-backup](https://github.com/dirkwa/signalk-backup) plugin into your SignalK server. The plugin asks [signalk-container](https://github.com/dirkwa/signalk-container) to pull and start this image, plumbs in the right env vars, and exposes the engine's UI as a SignalK webapp.

## What it does

- **Snapshot** SignalK config files (and optionally history) using [Kopia](https://kopia.io/) — content-addressable, deduplicated, encrypted at rest
- **Schedule** hourly / daily / weekly / startup tiers with independent retention
- **Sync** to Google Drive via [rclone](https://rclone.org/) with `drive.file` scope (the app only sees files it created)
- **Restore** with safety-backup rollback (every restore creates a snapshot of current state first)
- **Expose** an Express HTTP API + a Vite React UI on a single port (default 3010)

## Image

`ghcr.io/dirkwa/signalk-backup-server:<version>` (multi-arch: linux/amd64, linux/arm64)

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
| `NODE_ENV`          | `production`            | Pino-pretty in `development`                                                                                                                                         |
| `MAX_UPLOAD_SIZE`   | `1073741824` (1 GB)     | Cap on ZIP imports                                                                                                                                                   |

## API

All routes mounted under `/api/`. Full OpenAPI spec at `/api/openapi.json` and Swagger UI at `/api/docs`.

| Group      | Notable routes                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| Backups    | `GET/POST/DELETE /api/backups[/:id]`, `POST /api/backups/:id/restore`, `POST /api/backups/upload`             |
| Scheduler  | `GET/POST /api/backups/scheduler[/start                                                                       | /stop]` |
| Cloud sync | `GET /api/cloud/status`, `POST /api/cloud/sync`, `GET /api/cloud/installs`, `POST /api/cloud/restore[/prepare | /start  | /reset]`, `POST /api/cloud/gdrive/{connect,disconnect,auth-state,auth-callback,cancel}` |
| Settings   | `GET /api/settings`, `PUT /api/settings`                                                                      |
| Operations | `GET /api/operations`, `GET /api/operations/:id`                                                              |
| Health     | `GET /api/health`                                                                                             |
| GUI URL    | `GET /api/gui-url`                                                                                            |

## Direct run (debugging)

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
cd src/ui && npm install && cd ../..
npm run dev          # tsx watch + Vite UI build is separate (cd src/ui && npm run dev)
```

## License

Apache-2.0

## Acknowledgements

- [Kopia](https://kopia.io/) — backup engine
- [rclone](https://rclone.org/) — cloud transport
- Container base: [Wolfi](https://wolfi.dev/) (Chainguard) — glibc, security-hardened
- Origin: extracted from [signalk-universal-installer/keeper](https://github.com/signalk/signalk-universal-installer/tree/main/keeper) (Apache-2.0)
