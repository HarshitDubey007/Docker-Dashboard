# Docker Dashboard

A lightweight, self-hosted web dashboard for monitoring and managing Docker containers across **multiple servers** (local + remote) from one UI. Built as a zero-build-step Node.js + vanilla-JS app — clone, set a secret, `docker compose up`, done.

- **Unified service control** — see and manage Docker containers, **PM2 apps**, and **systemd services** from one screen (start / stop / restart / live logs), each tagged with a source badge
- Live container logs (SSE)
- Live host and per-container CPU / memory metrics with sparklines + charts
- Start / stop / restart containers
- Multi-server: attach any number of remote Docker daemons (TCP or TCP+TLS)
- Role-based access: **admin** (full control) and **viewer** (scoped to assigned containers / services)
- Every control action is **audited** to `data/audit.log` (who / what / when / result)
- File-based datastore (`lowdb`) — no external database required

---

## Table of contents

- [Screenshots](#screenshots)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start (Docker, recommended)](#quick-start-docker-recommended)
- [Manual setup (Node.js, for development)](#manual-setup-nodejs-for-development)
- [Configuration](#configuration)
- [First login & initial setup](#first-login--initial-setup)
- [Connecting a remote Docker host](#connecting-a-remote-docker-host)
- [API reference](#api-reference)
- [Project structure](#project-structure)
- [Daily maintenance & abuse protection](#daily-maintenance--abuse-protection)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Screenshots

> Drop screenshots in `docs/screenshots/` and link them here once the UI is captured.
>
> Suggested shots:
> - `dashboard-overview.png` — main dashboard with metrics strip and container list
> - `metrics-tab.png` — the per-container CPU / memory charts
> - `servers.png` — the remote-server manager
> - `admin-users.png` — the user / role management page

---

## Architecture

```
┌─────────────────────────────┐
│  Browser (vanilla JS + SSE) │
└──────────────┬──────────────┘
               │  REST + Server-Sent Events
┌──────────────▼──────────────┐
│  Express API (Node 20)      │
│  ├─ /api/auth               │
│  ├─ /api/servers            │
│  ├─ /api/servers/:id/...    │
│  └─ /api/users              │
└──────┬────────────────┬─────┘
       │                │
┌──────▼────────┐ ┌─────▼──────────┐
│ lowdb (JSON)  │ │ dockerode      │
│  data/db.json │ │  → /var/run/   │
│               │ │    docker.sock │
└───────────────┘ │  → tcp://host  │
                  └────────────────┘
```

**Stack:** Node.js 20 · Express · dockerode · lowdb · JWT · bcrypt · plain HTML/CSS/JS on the frontend (no build step).

---

## Requirements

| Component | Version | Why |
|-----------|---------|-----|
| Docker Engine | 20.10+ | Needed to run the app, and to be monitored |
| Docker Compose v2 | — | Bundled with modern Docker Desktop / Docker CE |
| Node.js (dev only) | 20+ | Only if running outside a container |
| git | any | To clone the repo |
| Linux / macOS host | — | Windows supported via Docker Desktop (WSL2) |

---

## Two ways to run

| Mode | Command | Manages |
|------|---------|---------|
| **Docker** (isolated) | `./deploy.sh` | Docker containers only |
| **Host / native** (turnkey) | `./start.sh` | Docker **+ PM2 + systemd** |

PM2 and systemd run on the **host**, outside Docker. A container is an isolated process namespace, so it physically cannot see or control host processes without breaking that isolation — there is no zero-config way to manage host PM2/systemd *from inside a container*. To manage them, run the dashboard **on the host** with `./start.sh`. That's still clone-and-one-command:

```bash
git clone https://github.com/HarshitDubey007/Docker-Dashboard.git
cd Docker-Dashboard
sudo ./start.sh        # sudo → manage root-owned PM2 apps and all systemd units
```

`start.sh` installs deps, generates `.env` (random `JWT_SECRET`), and launches the app. Run it as the user whose PM2 daemon you want to see (PM2 is per-user); use `sudo` for root-owned apps. See [Unified service control](#unified-service-control-docker--pm2--systemd) for persistence (run under PM2 / a systemd unit) and the permissions details.

---

## Quick start (Docker, recommended for Docker-only)

> Docker mode manages **Docker containers only** — PM2/systemd need [host mode](#two-ways-to-run) above.

```bash
# 1. Clone
git clone https://github.com/HarshitDubey007/Docker-Dashboard.git
cd Docker-Dashboard

# 2. One-shot deploy (generates .env, detects docker GID, fixes perms, builds, starts)
./deploy.sh
```

Open **http://localhost:3006** and log in with:

- Username: `admin`
- Password: `admin123` (change immediately — see [First login](#first-login--initial-setup))

What `deploy.sh` does:

1. Verifies Docker + Docker Compose are installed.
2. Creates `.env` with a random `JWT_SECRET` if missing.
3. Auto-detects the host's `docker` group GID (needed so the non-root container user can read `/var/run/docker.sock`) and writes it to `.env`.
4. Creates `./data/` and `chown`s it to UID `1001` (the in-container app user).
5. Runs `docker compose up -d --build`.

### Common Docker commands

```bash
docker compose logs -f dashboard     # tail live logs
docker compose ps                    # check container health
docker compose restart dashboard     # restart without rebuilding
docker compose down                  # stop and remove the container
docker compose up -d --build         # rebuild after code changes
```

### Updating to a newer version

```bash
git pull
docker compose up -d --build
```

Your data lives in the Docker named volume `dashboard-data` and is preserved across rebuilds. To back it up or inspect it:

```bash
docker compose cp dashboard:/app/data/db.json ./db.backup.json   # copy out
docker run --rm -v docker-dashboard_dashboard-data:/d alpine ls -l /d   # list volume
```

---

## Manual setup (Node.js, for development)

Useful when hacking on the code without rebuilding a Docker image every time.

```bash
# 1. Clone & install
git clone https://github.com/HarshitDubey007/Docker-Dashboard.git
cd Docker-Dashboard
npm install

# 2. Configure env — either export vars, or create a .env file (auto-loaded):
cat > .env <<'EOF'
JWT_SECRET=replace-with-openssl-rand-hex-32
DEFAULT_ADMIN_PASSWORD=admin123
PORT=3006
EOF

# 3. Run in watch mode
npm run dev      # auto-restarts on file changes (node --watch)
# or
npm start        # single run
```

> `src/loadEnv.js` auto-loads `.env` on startup (no `dotenv` dependency), so `npm start` works without exporting anything. Real environment variables always take precedence over `.env`. Or just run `./start.sh`, which generates `.env` for you.

Your local Docker socket at `/var/run/docker.sock` is used automatically if present. On macOS with Docker Desktop this works out of the box.

Data is written to `./data/db.json`. Override the location with `DATA_DIR=/some/path`.

---

## Configuration

All configuration is via environment variables. In Docker deployments these come from `.env` (see [`.env.example`](.env.example)).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | **yes** | — | HMAC secret for signing session tokens. Generate with `openssl rand -hex 32`. |
| `DEFAULT_ADMIN_PASSWORD` | no | `admin123` | Password for the bootstrap admin user. Only used on first boot (when the DB is empty). |
| `PORT` | no | `3006` | HTTP port the API listens on. |
| `DATA_DIR` | no | `./data` (dev) / `/app/data` (Docker) | Directory for `db.json`. |
| `DOCKER_GID` | yes (Docker only) | auto-detected | GID of the host `docker` group. Required so the non-root container user can read `/var/run/docker.sock`. Find it with `getent group docker \| cut -d: -f3`. |
| `HIDDEN_CONTAINERS` | no | — | Comma-separated glob patterns; matching containers are hidden from every view for every user. See [Hiding containers](#hiding-containers). |
| `PM2_ENABLED` | no | `1` | Attach the PM2 source to the Local Server. Set `0`/`false` to hide it. Auto-skipped if the `pm2` CLI isn't on `PATH`. See [Unified service control](#unified-service-control-docker--pm2--systemd). |
| `SYSTEMD_ENABLED` | no | `1` | Attach the systemd source to the Local Server. Set `0`/`false` to hide it. Auto-skipped if `systemctl` isn't available. |
| `TRUST_PROXY` | no | `loopback` | Express `trust proxy` setting. Set to `1` (or a hop count) when running behind nginx/Cloudflare so `req.ip` resolves to the real client IP. |
| `GLOBAL_RATE_MAX` | no | `300` | Max requests per IP per `GLOBAL_RATE_WINDOW_MS` on `/api/*`. |
| `GLOBAL_RATE_WINDOW_MS` | no | `60000` | Rate-limit window in milliseconds. |
| `DDOS_REQ_PER_DAY` | no | `10000` | Daily-maintenance scanner: block IPs exceeding this many requests in 24h. |
| `DDOS_AUTH_FAIL_PER_DAY` | no | `50` | Block IPs exceeding this many `401` responses in 24h. |
| `DDOS_RATE_LIMIT_HITS_PER_DAY` | no | `100` | Block IPs exceeding this many `429` responses in 24h. |
| `BLOCK_TTL_HOURS` | no | `24` | How long a freshly-flagged IP stays blocked. |
| `BLOCK_AT_HOST` | no | `0` | When `1`, the daily script also adds `iptables -j DROP` rules in the `DOCKER-USER` chain (Linux + root + iptables required). |
| `PRUNE_VOLUMES` | no | `0` | When `1`, the daily script also runs `docker volume prune -f`. **Destructive** — only enable if no host containers rely on anonymous volumes. |
| `ACCESS_LOG_MAX_BYTES` | no | `52428800` | Rotate `data/access.log` once it exceeds this size. |
| `DASHBOARD_CONTAINER` | no | `docker-dashboard` | Container name the daily script `docker exec`s into to run the abuse scanner. |

### Hiding containers

A dashboard running on a busy host usually shouldn't show every container on that host. `HIDDEN_CONTAINERS` takes a comma-separated list of glob patterns; anything matching is treated as if it doesn't exist:

```bash
# .env
HIDDEN_CONTAINERS=nirio-*,crm-*,solar_ai_agents-*
```

- Patterns are matched **case-insensitively and anchored** against each of a container's names and against its ID (full or 12-char short form). `*` and `?` are the only wildcards — `crm` hides a container named exactly `crm`, while `crm-*` hides the whole compose project.
- Hidden containers are excluded from the container list, the unified `/services` list, `/stats`, the metrics SSE stream, the host CPU/memory aggregates, and the header/sidebar counts. Their by-ID routes (`inspect`, `logs`, `stats`, `start`/`stop`/`restart`) return `404`.
- This is host-level config, **not** a per-user view: there is no way to reveal a hidden container from the UI, admins included. It also does nothing to the containers themselves — they keep running, they're just invisible here.
- Changes require a restart (`docker compose up -d` or restart the host process).

### Regenerating `JWT_SECRET`

Rotating the secret will invalidate all existing sessions — users will be logged out and need to re-authenticate. User accounts and passwords are *not* affected.

---

## First login & initial setup

1. Log in at `http://<host>:3006` with `admin / admin123`.
2. **Change the admin password.** Go to the user avatar → profile, or via the **Users** page if you're an admin.
3. Visit **Servers** to attach remote Docker hosts, if any.
4. Create viewer users under **Users** → **Add User**, and assign them specific containers.

---

## Connecting a remote Docker host

The dashboard talks to remote Docker daemons over the Docker HTTP API. You have two options:

### Option A — Plain TCP (LAN / VPN only)

Not safe on the public internet. Useful for trusted internal networks.

On the remote host, expose the Docker API on a port. Example `systemd` override:

```ini
# /etc/systemd/system/docker.service.d/override.conf
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
```

Then in the dashboard's **Servers → Add Server**, set Host = `remote-host-or-ip`, Port = `2375`, TLS = off.

### Option B — TCP + TLS (recommended for anything non-local)

Follow the [official Docker TLS guide](https://docs.docker.com/engine/security/protect-access/) to generate `ca.pem`, `server-cert.pem`, `server-key.pem` on the remote host, and `client-cert.pem`, `client-key.pem` for the dashboard. Default port is `2376`.

In the dashboard, set Host, Port `2376`, TLS = on, and paste in the **client** cert/key and CA.

---

## Unified service control (Docker + PM2 + systemd)

The **Services** page (`/services.html`) lists everything running on a host — Docker containers, PM2 apps, and systemd units — in one table, each row tagged with a source badge, with a source filter, live logs, and start / stop / restart actions.

### How it works

Every source implements one common `ServiceSource` interface (`list / inspect / start / stop / restart / logsStream`) and normalizes into a single `Service` shape (`id, name, source, status, cpuPct, memBytes, uptimeMs, restarts, pid`). The Docker source wraps the existing dockerode path; PM2 and systemd are **host-level** sources. The frontend renders all sources identically.

PM2 and systemd run on the host, not inside Docker, so they can't be reached from a container that only has `docker.sock` mounted. They are attached **only to the "Local Server"** and only work in **`local` host-access mode** — i.e. when the dashboard process runs on the host. A future **`agent` mode** (a small agent on each remote host exposing the same interface over HTTP) will extend this to remote hosts without changing the API.

**This is why a Dockerized dashboard shows "pm2: not available on this host".** The fix is to run it on the host instead of in a container — which is one command:

```bash
sudo ./start.sh        # see "Two ways to run" near the top of this README
```

If a source's CLI isn't installed (`pm2`, `systemctl`), it's auto-skipped; the Services page shows a short note explaining why a source is empty. You can also force-disable either with `PM2_ENABLED=0` / `SYSTEMD_ENABLED=0`.

### Running the host-mode dashboard persistently

`./start.sh` runs in the foreground (Ctrl-C stops it). To keep it running across reboots, pick one:

**Under PM2 itself** (it'll even appear in its own Services list):

```bash
export JWT_SECRET=$(openssl rand -hex 32)
sudo -E pm2 start src/server.js --name docker-dashboard --update-env
sudo pm2 save        # persist across reboot (with `pm2 startup` configured)
```

**As a systemd unit** (`/etc/systemd/system/docker-dashboard.service`):

```ini
[Unit]
Description=Docker Dashboard
After=network.target

[Service]
WorkingDirectory=/path/to/Docker-Dashboard
ExecStart=/usr/bin/node src/server.js
EnvironmentFile=/path/to/Docker-Dashboard/.env
Restart=on-failure
# Runs as root so it can manage root-owned PM2 apps and systemd units.
# Drop to a dedicated user + polkit rule for least privilege (see below).
User=root

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now docker-dashboard
```

> **PM2 is per-user.** The PM2 daemon is scoped to the OS user that started it. The dashboard only sees the PM2 daemon of the user it runs as — apps managed by *other* users are invisible. Cross-user PM2 is a known limitation, out of scope for now.

### Permissions reality (read this before expecting control to work)

Listing and controlling host services needs real host privileges. Be honest with yourself about what the dashboard's OS user can actually do:

| Source | To **see** services | To **control** (start/stop/restart) |
|--------|---------------------|--------------------------------------|
| Docker | member of the `docker` group (existing `DOCKER_GID`) | same |
| PM2 | run as the **same OS user** that owns the PM2 daemon | same |
| systemd | `systemctl`/`journalctl` readable (usually any user) | **root, or a narrow polkit policy** granting specific unit actions to a dedicated service account |

**Do not run the whole dashboard as root just to control systemd.** Prefer a scoped polkit rule that allows only the units you care about, for a dedicated service account. Example `/etc/polkit-1/rules.d/49-dashboard.rules`:

```javascript
// Allow the 'dashboard' user to start/stop/restart only nginx and myapp.
polkit.addRule(function (action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      subject.user == "dashboard") {
    var unit = action.lookup("unit");
    if (unit == "nginx.service" || unit == "myapp.service") {
      return polkit.Result.YES;
    }
  }
});
```

When a control action lacks privilege, the API returns the `systemctl`/`pm2` error message verbatim so you can see exactly what was denied.

### Auditing

Every start / stop / restart on **any** source appends one NDJSON line to `data/audit.log`:

```json
{"t":"2026-06-12T08:00:00.000Z","user":"admin","role":"admin","ip":"203.0.113.5","server":"local","source":"systemd","target":"nginx.service","action":"restart","result":"ok","msg":null}
```

Secrets (tokens, env values, TLS keys) are never written to the audit log. Control actions are **admin-only**; viewers get read-only access (list / logs) to their assigned services.

---

## API reference

All endpoints require `Authorization: Bearer <jwt>` except `/api/auth/login`. Streaming endpoints (SSE) accept the token as a `?token=` query parameter because `EventSource` can't set headers.

### Auth

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/login` | Body `{ username, password }` → `{ token, user }` |
| `GET`  | `/api/auth/me` | Returns current user from token |

### Servers (admin only for mutations)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/servers` | List all servers with enriched status |
| `POST` | `/api/servers` | Add a remote server |
| `PUT`  | `/api/servers/:id` | Update a remote server |
| `DELETE` | `/api/servers/:id` | Remove a remote server |
| `POST` | `/api/servers/test` | Dry-run a connection config |
| `POST` | `/api/servers/:id/test` | Re-test an existing server |
| `GET`  | `/api/servers/status/stream` | **SSE** — live connection status updates |

### Docker (per server)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/servers/:sid/info` | Docker engine info + version |
| `GET`  | `/api/servers/:sid/stats` | Host + per-container CPU / memory snapshot |
| `GET`  | `/api/servers/:sid/metrics/stream` | **SSE** — metrics every 2s |
| `GET`  | `/api/servers/:sid/containers` | List containers (scoped for non-admins) |
| `GET`  | `/api/servers/:sid/containers/:id/inspect` | Full container JSON |
| `GET`  | `/api/servers/:sid/containers/:id/stats` | One-shot container stats |
| `GET`  | `/api/servers/:sid/containers/:id/logs` | **SSE** — live log stream |
| `POST` | `/api/servers/:sid/containers/:id/start` | Start container |
| `POST` | `/api/servers/:sid/containers/:id/stop` | Stop container |
| `POST` | `/api/servers/:sid/containers/:id/restart` | Restart container |

### Services — unified Docker + PM2 + systemd (per server)

A superset of the Docker routes above. `:source` is `docker`, `pm2`, or `systemd`; `:id` is the source-native id (container id, PM2 `pm_id`, or systemd unit name). The legacy `/containers` routes still work unchanged.

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/servers/:sid/services` | List services across all available sources (scoped for non-admins). Includes a `sources[]` array reporting per-source availability / errors. |
| `GET`  | `/api/servers/:sid/services/:source/:id/inspect` | Full source-native detail object |
| `GET`  | `/api/servers/:sid/services/:source/:id/logs` | **SSE** — live log stream, normalized to `{ ts, line }` |
| `POST` | `/api/servers/:sid/services/:source/:id/start` | Start service (**admin only**, audited) |
| `POST` | `/api/servers/:sid/services/:source/:id/stop` | Stop service (**admin only**, audited) |
| `POST` | `/api/servers/:sid/services/:source/:id/restart` | Restart service (**admin only**, audited) |

### Users (admin only)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/users` | List all users |
| `POST` | `/api/users` | Create a user |
| `PUT`  | `/api/users/:id` | Update user (role, password, assigned containers) |
| `DELETE` | `/api/users/:id` | Delete a user |

---

## Project structure

```
Docker-Dashboard/
├── src/
│   ├── server.js          # Express bootstrap
│   ├── loadEnv.js         # Zero-dep .env loader (host mode); no-op in Docker
│   ├── db.js              # lowdb store, bootstrap admin + local server
│   ├── auth.js            # JWT + bcrypt, auth middleware, /api/auth routes
│   ├── security.js        # Access logger, IP blocklist, global rate limiter
│   ├── metrics.js         # Pure CPU / memory math (no I/O)
│   ├── audit.js           # Append-only NDJSON audit log of control actions
│   ├── serverManager.js   # Per-server dockerode + source cache, polling
│   ├── sources/           # Unified service-source layer (one per source type)
│   │   ├── index.js       # Source registry — which sources a server exposes
│   │   ├── exec.js        # Host-access helpers (safe execFile/spawn, LogStream)
│   │   ├── dockerSource.js
│   │   ├── pm2Source.js
│   │   └── systemdSource.js
│   └── routes/
│       ├── servers.js     # CRUD + SSE status for remote servers
│       ├── docker.js      # Per-server container endpoints + metrics SSE
│       ├── services.js    # Unified Docker + PM2 + systemd endpoints
│       └── users.js       # User / role / container-assignment admin
├── scripts/
│   ├── daily-maintenance.sh   # Cron entrypoint: docker prune + abuse scan + iptables
│   ├── install-cron.sh        # Registers the daily cron entry
│   └── scan-access-log.mjs    # NDJSON access-log parser, refreshes blocklist.json
├── public/
│   ├── index.html         # Main dashboard
│   ├── login.html         # Auth
│   ├── services.html      # Unified Docker + PM2 + systemd service view
│   ├── servers.html       # Remote-server manager
│   ├── admin.html         # User admin
│   ├── css/styles.css
│   └── js/api.js          # Shared fetch/auth helpers
├── Dockerfile             # Multi-stage prod image (non-root UID 1001)
├── docker-compose.yml     # Volumes, socket mount, group_add
├── start.sh               # Turnkey native host launcher (Docker + PM2 + systemd)
├── deploy.sh              # One-shot Docker setup script
├── .env.example           # Template env
└── package.json
```

---

## Daily maintenance & abuse protection

The dashboard ships with three layers of always-on protection plus a daily cron job that prunes Docker resources and reacts to abuse it sees in the access log.

### What runs on every request (always on)

Wired into [`src/server.js`](src/server.js) via [`src/security.js`](src/security.js):

1. **Access logger** — appends one NDJSON line per request to `data/access.log`:
   ```json
   {"t":"2026-05-01T08:00:00.000Z","ip":"203.0.113.5","m":"GET","p":"/api/auth/me","s":401,"d":4}
   ```
   Fields: `t`=timestamp, `ip`=client IP, `m`=method, `p`=path (query stripped), `s`=status, `d`=duration ms. Blocked attempts are logged too, so you can audit what tried to hit you.

2. **IP blocklist middleware** — reads `data/blocklist.json` (mtime-cached, no I/O on the hot path) and returns `403 Forbidden` for any IP listed there with a non-expired `expiresAt`.

3. **Global rate limiter** — `300 req/min/IP` on `/api/*` by default (tune with `GLOBAL_RATE_MAX` / `GLOBAL_RATE_WINDOW_MS`). Adds `RateLimit-*` response headers; over-limit requests get `429`. Stacks with the existing per-`/login` brute-force limiter.

> **Reverse proxies:** if the app is behind nginx, Caddy, or Cloudflare, set `TRUST_PROXY=1` (or a hop count) in `.env`. Otherwise every request looks like it came from the proxy and the rate limiter / blocklist will treat the proxy as a single client.

### What the daily script does

[`scripts/daily-maintenance.sh`](scripts/daily-maintenance.sh) is meant to run from cron on the Docker host. Each run:

1. **Prunes Docker** — `container prune`, `image prune -af`, `network prune`, `builder prune -af`. Volume prune is **off by default** (set `PRUNE_VOLUMES=1` to enable — destructive).
2. **Scans 24h of `access.log`** by `docker exec`ing [`scripts/scan-access-log.mjs`](scripts/scan-access-log.mjs) inside the dashboard container. It computes per-IP totals, `401` count, and `429` count, then flags anything past the configured thresholds.
3. **Updates `data/blocklist.json`** — adds new flagged IPs, refreshes existing ones, removes expired entries. The runtime middleware picks up the change automatically (mtime check).
4. **(Optional) Adds host firewall rules** — when `BLOCK_AT_HOST=1` and the script runs as root, also inserts `iptables -I DOCKER-USER -s <ip> -j DROP` for each active block so traffic is dropped before it ever reaches the container.
5. **Rotates `access.log`** when it exceeds `ACCESS_LOG_MAX_BYTES` (50 MiB by default).
6. **Logs everything** to `data/maintenance.log` for audit.

Private ranges (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `::1`, `fc00::/7`) are never auto-blocked.

### Install the cron job

```bash
./scripts/install-cron.sh                       # daily at 03:00, current user
CRON_TIME='*/30 * * * *' ./scripts/install-cron.sh   # custom schedule
sudo BLOCK_AT_HOST=1 ./scripts/install-cron.sh   # also wire iptables (root)
```

Inspect what was installed:

```bash
crontab -l
```

Run once on demand (recommended right after install, to verify):

```bash
./scripts/daily-maintenance.sh
tail -n 50 data/maintenance.log
```

### Tuning thresholds

The defaults in `.env.example` are a starting point, not a target:

| Variable | Default | Tune if… |
|----------|---------|----------|
| `DDOS_REQ_PER_DAY` | `10000` | Legitimate users (e.g. SSE clients) trip it — raise. Most attacks send 100k+. |
| `DDOS_AUTH_FAIL_PER_DAY` | `50` | You see lots of legitimate password typos — raise to `100`. Brute-force is usually 1k+. |
| `DDOS_RATE_LIMIT_HITS_PER_DAY` | `100` | You see frequent `429`s from one app/script — raise. Real abuse will hit thousands. |
| `BLOCK_TTL_HOURS` | `24` | Want longer cool-off — raise. Want quick auto-recovery for false positives — lower. |

After a week of real traffic, look at `data/access.log` and decide.

### Manually unblock an IP

```bash
# Edit data/blocklist.json and remove the entry, OR set its expiresAt to a past time.
# The change takes effect on the next request (mtime cache).

# If BLOCK_AT_HOST=1 was on, also flush the iptables entry:
sudo iptables -D DOCKER-USER -s <ip> -j DROP
```

### Limits to be aware of

- **App-layer only by default.** True network-layer DDoS (SYN flood, volumetric) needs Cloudflare / a CDN / nginx with rate limiting in front. The `BLOCK_AT_HOST=1` mode adds an iptables layer but is reactive (it blocks *after* the daily run sees abuse), not preventive.
- **Detection runs daily, not in real time.** A burst between two cron runs won't be blocked until the next run. If you need real-time blocking, run the script every 5–15 minutes (`CRON_TIME='*/15 * * * *'`).
- **The middleware never sees the request if the host firewall already dropped it** — by design, but it means `access.log` won't show those attempts. `iptables -L DOCKER-USER -nvx` shows packet counts per blocked IP.

---

## Troubleshooting

### `EACCES: permission denied, open '/app/data/.db.json.tmp'`

The container (UID 1001) can't write its data dir. As of the named-volume setup this shouldn't happen in Docker mode. If you still see it, you're likely on an **older bind-mount setup** or a **stale local image** — pull the latest `docker-compose.yml` and recreate so the `dashboard-data` volume is used:

```bash
git pull
docker compose down
docker compose up -d --build
```

If you intentionally bind-mount a host `./data` (instead of the named volume), make it writable by UID 1001 — on Linux: `sudo chown -R 1001:1001 ./data`. On **macOS Docker Desktop** host chowns don't translate reliably, so prefer the named volume (the default).

### `502 Bad Gateway` from `/api/servers/local/containers`

The container can't reach `/var/run/docker.sock`. Make sure `DOCKER_GID` in `.env` matches the host's `docker` group GID.

```bash
getent group docker | cut -d: -f3        # e.g. 999
grep DOCKER_GID .env                     # should match
# if not, update .env and:
docker compose up -d --force-recreate
```

### Port 3006 unreachable from your browser

- Local Ubuntu firewall: `sudo ufw status`; if active, `sudo ufw allow 3006/tcp`.
- Cloud firewall (DigitalOcean / AWS / GCP): add an inbound TCP 3006 rule. Prefer scoping by source IP.

### Container keeps restarting

```bash
docker compose logs --tail=100 dashboard
```

Most startup errors are in the first ~20 lines — typically a missing `JWT_SECRET` or `DOCKER_GID`.

### Legitimate users get `403 Forbidden`

The daily scanner has flagged their IP. Inspect and remove the entry:

```bash
cat data/blocklist.json
# remove the IP's object from the "blocked" array, save the file.
# Effect is immediate (no restart needed). If BLOCK_AT_HOST=1:
sudo iptables -D DOCKER-USER -s <ip> -j DROP
```

If this happens often, your thresholds are too tight — raise `DDOS_REQ_PER_DAY` / `DDOS_AUTH_FAIL_PER_DAY` in `.env`.

### `req.ip` shows the proxy IP, not the real client

You're behind a reverse proxy and `TRUST_PROXY` is still at the default. Set `TRUST_PROXY=1` (or a hop count if there's more than one proxy) in `.env` and restart the container.

---

## Security notes

This is a powerful tool: anyone with admin access to the dashboard effectively has root on every attached Docker host. With the unified service layer it can also start/stop **host-level** PM2 and systemd services — so the blast radius is even larger. Treat it accordingly.

- **Bind to `127.0.0.1` behind a TLS reverse proxy.** Never expose port 3006 to the public internet without a reverse proxy + TLS + strong passwords. Put it behind nginx / Caddy / Traefik with HTTPS, and bind the container to `127.0.0.1:3006:3006` so the proxy is the only entry. The host-level control power makes this **more** important, not less.
- **Control actions are admin-only and audited.** Every start/stop/restart on any source is logged to `data/audit.log` (see [Auditing](#auditing)). Viewers stay read-only and scoped to their assigned services.
- **Grant the least systemd privilege that works.** Use a narrow polkit rule for specific units instead of running the dashboard as root — see [Permissions reality](#permissions-reality-read-this-before-expecting-control-to-work).
- **Set `TRUST_PROXY`** when behind a proxy so the access/audit logs and rate limiter see real client IPs, not the proxy.
- **Change `admin123` immediately.** Bots scan port 3006.
- **Rotate `JWT_SECRET`** on any suspected compromise — this invalidates every existing session.
- **Scope by source IP** in your cloud firewall where possible.
- **Use TLS** for any remote Docker connection — plain TCP (`2375`) on an untrusted network is a critical vulnerability.
- **Least-privilege users:** create viewer accounts with specific container assignments instead of sharing the admin account.

Found a vulnerability? Please open a private security advisory rather than a public issue.

---

## Roadmap

- [x] Phase 1 — Auth, multi-server, container list / logs / actions, user roles
- [x] Phase 2a — Live host + per-container CPU / memory metrics (tiles, sparklines, charts)
- [x] Unified service layer — Docker + PM2 + systemd in one view, with control + audit
- [ ] Remote `agent` host-access mode — manage PM2 / systemd on remote hosts
- [ ] Persistent metric history (MongoDB time-series) + log measurement
- [ ] Scaling advisor — right-sizing (upsize / downsize) recommendations with evidence
- [ ] Phase 2b — "Deploy from Git": pull any repo, build image, run container (admin-only initially)
- [ ] Image and volume management views
- [ ] Audit log of user actions
- [ ] Email / webhook alerts on container exit / high resource use

---

## Contributing

Contributions are very welcome — from typo fixes to whole features. Here's the shape of a good contribution:

### 1. Set up for development

```bash
git clone https://github.com/HarshitDubey007/Docker-Dashboard.git
cd Docker-Dashboard
npm install
cp .env.example .env
# edit .env: set a real JWT_SECRET
npm run dev
```

### 2. Create a feature branch

```bash
git checkout -b feat/short-description
# or: fix/short-description, docs/short-description
```

### 3. Coding conventions

- **Node.js ESM** throughout (`"type": "module"` in `package.json`).
- **No build step.** Frontend is vanilla HTML / CSS / JS. Please don't add React, bundlers, or CSS preprocessors without discussion.
- **No new dependencies** without justification in the PR description — keep the dependency tree small and auditable.
- **Pure functions for math** (see [`src/metrics.js`](src/metrics.js)). I/O stays in the routes / managers.
- **Comments explain *why*, not *what***. If the code needs a comment to explain what it does, rename the variable or split the function.
- Match existing indentation (2 spaces) and quote style (single quotes).

### 4. Security-sensitive changes

If your change touches auth, token handling, file paths, shell execution, or the Docker API, call that out explicitly in the PR. Extra scrutiny is welcome, not a blocker.

### 5. Test your change end-to-end

There is no formal test suite yet (contributions welcome!). For now, manually verify:

```bash
# syntax check
node --check src/server.js
node --check src/routes/docker.js
# smoke test
JWT_SECRET=test-secret DATA_DIR=/tmp/dd-dev PORT=3456 npm start
# in another terminal
curl -s -X POST http://localhost:3456/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}'
```

Then click through the dashboard — log in, add a server, view containers, open Logs, open Metrics, restart a container.

### 6. Commit message style

```
<type>: <short imperative summary>

Longer explanation of *why*, if the change is non-trivial.
Reference issues with "Fixes #123".
```

Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `chore`, `test`.

### 7. Open a pull request

- Push to your fork: `git push origin feat/short-description`
- Open a PR against `main`.
- In the description, explain the user-visible change, the motivation, and anything a reviewer should pay attention to.
- Screenshots or short screen recordings are very welcome for UI changes.

### Good first issues

Look for `good-first-issue` or `help-wanted` labels on the issue tracker. If none match, some low-risk starter projects:

- Add a real test suite (Vitest or Node's built-in test runner).
- Add pagination / virtual scrolling to the container list.
- Dark/light theme toggle.
- Keyboard shortcuts (e.g. `j`/`k` to move through containers).
- Improve mobile responsive layout.

### Code of Conduct

Be kind, assume good faith, disagree on ideas not people. We follow the spirit of the [Contributor Covenant](https://www.contributor-covenant.org/).

---

## License

MIT — see [`LICENSE`](LICENSE) for full text.

---

## Acknowledgements

- [dockerode](https://github.com/apocas/dockerode) — the workhorse Docker client.
- [lowdb](https://github.com/typicode/lowdb) — tiny JSON database, perfect for config-sized state.
- [Express](https://expressjs.com/) — still reliable after all these years.
