# signalk-backup-server

Headless backup engine container for the [signalk-backup](https://github.com/dirkwa/signalk-backup) plugin. Runs Kopia for content-addressable deduplicated snapshots and rclone for optional Google Drive sync.

You normally don't run this container directly — install the [signalk-backup](https://github.com/dirkwa/signalk-backup) plugin into your SignalK server. The plugin asks [signalk-container](https://github.com/dirkwa/signalk-container) to pull and start this image, plumbs in the right env vars, and exposes the engine's UI as a SignalK webapp.

## What it does

- **Snapshot** SignalK config files (and optionally history) using [Kopia](https://kopia.io/) — content-addressable, deduplicated, encrypted at rest
- **Schedule** hourly / daily / weekly / startup tiers with independent retention
- **Sync** to a local destination (USB drive, NAS, any mounted volume) or to Google Drive via [rclone](https://rclone.org/) with `drive.file` scope (the app only sees files it created)
- **Restore** with safety-backup rollback — every full restore creates a snapshot of current state first; partial restores stash the existing target before overwriting
- **Selective restore** — browse any snapshot's file tree, download a single file or whole subdirectory, or restore one sub-path in-place under signalkDataPath. The plugin's host-side writer handles restores to arbitrary host paths outside the container's view. See the API table below for the routes.
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

| Group               | Notable routes                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backups             | `GET /api/backups`, `POST /api/backups`, `GET /api/backups/:id`, `DELETE /api/backups/:id`, `POST /api/backups/:id/restore`, `POST /api/backups/upload`, `GET /api/backups/:id/download` |
| Selective restore   | `GET /api/backups/:id/tree`, `GET /api/backups/:id/download-subtree`, `POST /api/backups/:id/restore-partial`                                                                            |
| Partial-restore SSE | `GET /api/backups/restore-partial/status`, `GET /api/backups/restore-partial/stream`, `POST /api/backups/restore-partial/reset`                                                          |
| Scheduler           | `GET /api/backups/scheduler`, `POST /api/backups/scheduler/start`, `POST /api/backups/scheduler/stop`                                                                                    |
| Events SSE          | `GET /api/backups/events/stream` — one `backup-completed` event per scheduled run; AsyncAPI doc at `/api/asyncapi.json`                                                                  |
| Cloud sync          | `GET /api/cloud/status`, `POST /api/cloud/sync`, `GET /api/cloud/installs`, `POST /api/cloud/restore/prepare`, `POST /api/cloud/restore/start`, `POST /api/cloud/restore/reset`          |
| GDrive              | `POST /api/cloud/gdrive/connect`, `POST /api/cloud/gdrive/disconnect`, `POST /api/cloud/gdrive/auth-state`, `POST /api/cloud/gdrive/auth-callback`, `POST /api/cloud/gdrive/cancel`      |
| Settings            | `GET /api/settings`, `PUT /api/settings`                                                                                                                                                 |
| Password            | `GET /api/backups/password`, `PUT /api/backups/password` (change — re-keys in place), `DELETE /api/backups/password` (reset to default)                                                  |
| Operations          | `GET /api/operations`, `GET /api/operations/:id`                                                                                                                                         |
| Health              | `GET /api/health`                                                                                                                                                                        |
| GUI URL             | `GET /api/gui-url` _(legacy — the plugin's webapp now serves the user-facing UI; this route is kept for backwards compat with older signalk-backup releases)_                            |

## Backup password

The Kopia repository is always encrypted. With no custom password set the engine uses a built-in default (so first-run backups work without any setup); a custom password is stored in `settings.json` (mode `0600`) under `DATA_DIR`.

Changing the password (`PUT /api/backups/password`) **re-keys the existing repository in place** (`kopia repository change-password`) — your existing snapshots are preserved, not discarded. The change is guarded so a failure can never lock you out:

1. The engine connects with the current password first and refuses if it can't open the repo.
2. It stashes the `kopia-config*` connection state before re-keying and restores it on any failure.
3. After re-keying it verifies the new password reconnects before persisting it.

On any failure at those steps nothing is persisted and the previous password keeps working. `DELETE /api/backups/password` resets to the default password the same way.

**Cloud copies (Google Drive / SMB) share the repository password.** A re-key only rewrites the small key-wrapper blob locally, so the cloud copy is briefly still on the previous password until one sync pushes the new wrapper up. After a re-key the engine starts that sync automatically; until it completes, do **not** restore from the cloud and do **not** delete the old cloud backups (they remain the only consistent copy if the sync fails). No full re-seed is needed — the content blobs are unchanged.

## Repository recovery

If the engine logs `Kopia command failed: unable to get repository storage: found existing data in storage location`, the repository data is intact but the engine could not _connect_ to it. The two causes:

- **Lost or stale `kopia-config`** (repo present, connection state gone). The engine reconnects automatically on the next start (≥ 0.6.7). To reconnect manually from a shell inside the container:

  ```bash
  kopia repository connect filesystem \
    --path "$DATA_DIR/kopia-repo" \
    --config-file "$DATA_DIR/kopia-config"
  # with KOPIA_PASSWORD set to your backup password — if you never set a
  # custom one, it is the engine's built-in default (DEFAULT_KOPIA_PASSWORD
  # in src/services/settings-service.ts)
  ```

- **Password mismatch** (the configured password is not the one the repo was created with). Set the original password and restart. Your backups are safe — the repository is never re-created over existing data.

Versions before 0.6.7 could mask the real cause by attempting to create a new repository over the existing one; ≥ 0.6.7 never does this and surfaces the actual reason instead.

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
