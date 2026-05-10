# AGENTS.md

Notes for AI coding agents working on this repository. Human-facing usage and screenshots live in [README.md](README.md); this file is the orientation an agent needs before making non-trivial changes.

## What this is

A headless backup-engine HTTP service, packaged as a multi-stage Wolfi container (`ghcr.io/dirkwa/signalk-backup-server`). It is launched and managed by the [signalk-backup](https://github.com/dirkwa/signalk-backup) SignalK plugin via signalk-container's `ensureRunning()` — this image is the heavy backend (Kopia native code, rclone subprocesses, Vite/React UI bundle), kept out-of-process so SignalK itself stays light.

The image bundles two third-party binaries:

- **Kopia** — content-addressable deduplicated snapshots. Source of truth for backup storage; the same repo can be encrypted, mounted, browsed, and rolled back without us reimplementing those features.
- **rclone** — Google Drive transport for `kopia repository sync-to`. We don't use rclone directly for snapshots; it's purely the cloud upload pipe.

The repo is self-contained: there is no companion plugin in `node_modules` here — the SignalK relationship is entirely runtime, via env vars set by the plugin (`DATA_DIR`, `SIGNALK_DATA_PATH`, `GUI_PUBLIC_URL`, `SIGNALK_VERSION`). Locally the service is just an Express app you can `npm run dev`.

## File layout

- [src/server.ts](src/server.ts) — Express entrypoint. Mounts the route prefixes (`/api/health`, `/api/backups`, `/api/cloud`, `/api/settings`, `/api/operations`, `/`), wires CORS (loopback + RFC1918 + sibling `sk-*` containers), starts the scheduler, exposes Swagger UI at `/api/docs`. Listens on `PORT` (default 3010), bound to all interfaces — protection is at the network layer, not in-app auth.
- [src/config/index.ts](src/config/index.ts) — typebox-validated runtime config from env. `DATA_DIR` (kopia repo + settings.json + rclone.conf live here), `SIGNALK_DATA_PATH` (where the snapshotted ~/.signalk lives), `KOPIA_*`, `RCLONE_*`. Failure to validate env exits the process — there are no runtime defaults for required paths.
- [src/api/](src/api/) — one router per concern. `backup-routes.ts` is the largest (list / create / restore / upload / scheduler control / storage stats); others are thin and thematic. **Route order matters** — specific paths like `/scheduler` must precede parameterised paths like `/:id`.
- [src/services/backup-service.ts](src/services/backup-service.ts) — backup orchestrator. `createBackup()` writes a `.kopiaignore` from architectural defaults + DB-plugin defaults + user exclusions, snapshots `signalkDataPath`, enforces retention. **`ALWAYS_EXCLUDED` is the load-bearing list** — it keeps us from snapshotting our own kopia repo (which would grow without bound) but deliberately leaves `database-exports/` snapshottable so the signalk-backup plugin can stage Parquet exports there.
- [src/services/kopia-client.ts](src/services/kopia-client.ts) — typed wrapper over the kopia CLI. `createSnapshot`, `listSnapshots`, `restoreSnapshot` (with progress callbacks), `connect`/`disconnect` for cloud mode. All commands go through `runKopia` which knows about timeouts and "we're connected to a cloud repo, every command starts a fresh rclone subprocess" (45s timeout for cloud commands vs. 600s default).
- [src/services/backup-machine.ts](src/services/backup-machine.ts) — XState machine for restore-with-rollback. States: `idle → preparing → extracting → installing → restarting → verifying → completed | failed → rolling_back → rolled_back`. Every restore creates a "safety backup" before clobbering anything.
- [src/services/restore-service.ts](src/services/restore-service.ts) — drives the machine. Takes a snapshot id, validates, runs the safety backup, restores files, restarts SignalK (via signalk-container if available), health-checks, rolls back on any failure.
- [src/services/cloud-sync-service.ts](src/services/cloud-sync-service.ts) — `kopia repository sync-to rclone:<remote>` for Google Drive. Modes: `off` / `manual` / `daily` / `weekly` / `after_backup`. The `after_backup` hook fires from `backup-routes.ts` after each successful create.
- [src/services/gdrive-auth-service.ts](src/services/gdrive-auth-service.ts) — wraps `rclone authorize drive`. Spawns the rclone subprocess, captures the OAuth callback URL, polls for completion. The callback listener binds port 53682 — see Gotchas.
- [src/services/backup-scheduler.ts](src/services/backup-scheduler.ts) — `setTimeout`-based scheduler for hourly/daily/weekly/startup automatic backups. Settings live in `settings.json` via `settings-service.ts`.
- [src/ui/](src/ui/) — Vite + React frontend. Built by stage 1 of the Dockerfile and served as static assets by `gui-routes.ts`. Independent npm package (separate `package.json` + lockfile).
- [tests/](tests/) — vitest. Currently covers `kopia-client` and `openapi-registry`. The bulk of the surface is tested manually + via the plugin-side smoke test.

## Build, lint, test

```bash
npm run dev          # tsx watch — fastest iteration when developing locally
npm run build        # tsc + ui build (stages 1+2 of the Dockerfile)
npm run lint         # eslint (--max-warnings 0)
npm run format       # prettier write + eslint --fix
npm run test         # vitest
npm run build:all    # lint + build + test
```

The container build is in [Dockerfile](Dockerfile) — three stages (frontend / backend / runtime), all on `cgr.dev/chainguard/wolfi-base`. Wolfi gives us glibc + a current Node 24 + zero CVE noise. Pinned `KOPIA_VERSION` and `RCLONE_VERSION` ARGs make the image reproducible.

## Local dev loop

`npm run dev` runs the server on `PORT=3010` against whatever `DATA_DIR`/`SIGNALK_DATA_PATH` you set in the env. For UI-only iteration:

```bash
cd src/ui && npm run dev    # Vite dev server with HMR, talks to backend at :3010
```

To exercise the full container path the same way the plugin does:

```bash
podman build -t signalk-backup-server:dev .
podman run --rm -e DATA_DIR=/data -e SIGNALK_DATA_PATH=/sk \
  -v ~/.signalk:/sk -v /tmp/backup-data:/data -p 3010:3010 \
  signalk-backup-server:dev
```

A live, plugin-launched container is at `sk-signalk-backup-server`:

```bash
podman ps --filter name=sk-signalk-backup-server
podman logs -f sk-signalk-backup-server
```

## Debugging recipes

Inspect the kopia repo state directly inside the container:

```bash
podman exec sk-signalk-backup-server kopia --config-file=$KOPIA_CONFIG_PATH repository status
podman exec sk-signalk-backup-server kopia --config-file=$KOPIA_CONFIG_PATH snapshot list
```

Check what `.kopiaignore` was actually written for the last snapshot:

```bash
podman exec sk-signalk-backup-server cat $SIGNALK_DATA_PATH/.kopiaignore
```

Confirm the rclone Drive remote works and the OAuth token isn't expired:

```bash
podman exec sk-signalk-backup-server rclone --config $RCLONE_CONFIG_PATH lsd gdrive:
```

Watch a restore run end-to-end via the operation tracker:

```bash
curl http://127.0.0.1:3010/api/operations | jq .
```

OpenAPI doc (also browseable at `/api/docs`):

```bash
curl http://127.0.0.1:3010/api/openapi.json | jq .
```

## Gotchas

- **`ALWAYS_EXCLUDED` is the contract with the signalk-backup plugin.** It excludes our own kopia repo and rclone config (snapshot-of-snapshot would grow without bound) but deliberately leaves `plugin-config-data/signalk-backup/database-exports/` snapshottable so the plugin's QuestDB exporter can drop Parquet files there. **Don't simplify back to `plugin-config-data/signalk-backup/`** — that breaks v0.2 silently (kopia ignores the parquets, restore looks empty).
- **`DB_PLUGIN_DEFAULT_EXCLUSIONS` excludes live database files.** QuestDB / Grafana / etc. plugin data dirs are excluded by default because filesystem-level snapshots of a running DB are silently inconsistent — the files are there but corrupted. Users who want history backup must use the DB plugin's own export path (signalk-questdb's `/api/full-export`) which the signalk-backup plugin orchestrates.
- **Cloud-mode kopia commands need a tighter timeout.** Each kopia command starts a fresh rclone subprocess that authenticates with Google Drive. The default 600s timeout would mask runaway connection attempts; cloud-connected commands use 45s instead. Don't unify these timeouts.
- **rclone OAuth callback binds port 53682.** `rclone authorize drive` opens a browser-side callback listener on this fixed port. The plugin declares it in `signalkAccessiblePorts` so signalk-container exposes it back to the user's browser. If 53682 is in use, signalk-container picks the next free port and the UI surfaces the actual auth URL — but expect this case to confuse users.
- **Restore restarts SignalK.** The restore machine's `restarting` state spawns `podman restart sk-signalk` (or whatever the SignalK container is named). The active session that triggered the restore will lose its websocket — UI must reconnect after restart. There is no "restore without restart" path; the half-state would be unsafe.
- **`config.dataDir` and `config.signalkDataPath` are different mounts.** `dataDir` is where _our_ state lives (kopia repo, settings.json, rclone.conf, install-id). `signalkDataPath` is the SignalK config root being _backed up_. Mixing them up has caused snapshot-of-self bugs. Plugin sets both via env at container start.
- **`createBackup`'s `.kopiaignore` write is destructive.** It overwrites whatever was at `<signalkDataPath>/.kopiaignore`. If a user manually authored one, it's gone after the next backup. We accept this — the file is regenerated from settings + flags every time.
- **History pieces are stubbed.** Comments like `// keeper used historyBackupService here` mark places where the original codebase (this repo descends from another) had InfluxDB/Grafana history backup. signalk-backup-server inherits the placeholder but the host plugin is expected to do history capture (see signalk-backup's database-export module). **Don't re-implement history backup here** — keep the boundary.
- **Kopia retention is enforced after every snapshot, not on a separate timer.** `enforceRetention()` runs at the end of `createBackup`. If you want to test retention you must trigger a backup; there is no standalone job.
- **The CORS allowlist is open enough to confuse you.** It allows any loopback, any RFC1918 (so the LAN can reach us), and `https?://sk-*` (so sibling containers in the same podman network can reach us). It does **not** rely on origin-based auth — the network layer is the security boundary. Don't add JWT or origin restrictions thinking it'll harden things; it'll just break the plugin.

## Conventions

- **No comments restating what the code does.** Comments should explain the _why_ of something non-obvious (e.g. "cloud kopia commands need a tighter timeout"), not narrate the diff.
- **Angular conventional commits** (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `test:`, `refactor:`). Subject in imperative mood. **No `Co-Authored-By` lines.**
- **Branch names use hyphens, not slashes.** Signal K maintainers' convention.
- **TypeScript is strict.** Don't add `as any` to silence errors — fix the type.
- **One logical change per PR.** Refactors, behavior changes, dep bumps belong in separate PRs. The `chore(release): X.Y.Z` commit is its own PR.
- **PR descriptions:** `## Summary` (bullets, why-not-what) and `## Tested` (only what was actually verified — no speculative test plans, no checkbox lists).
- **The image must build for `linux/amd64` AND `linux/arm64`.** Pi 5 is the primary target. The Dockerfile uses `$TARGETARCH` for both kopia and rclone downloads — keep that.
- **Don't write multi-line comment blocks or docstrings.** A short single-line comment for a non-obvious WHY is fine; everything else is noise.
