# Docker Dashboard

A lightweight, self-hosted web dashboard for monitoring and managing Docker containers across **multiple servers** (local + remote) from one UI. Built as a zero-build-step Node.js + vanilla-JS app — clone, set a secret, `docker compose up`, done.

- Live container logs (SSE)
- Live host and per-container CPU / memory metrics with sparklines + charts
- Start / stop / restart containers
- Multi-server: attach any number of remote Docker daemons (TCP or TCP+TLS)
- Role-based access: **admin** (full control) and **viewer** (scoped to assigned containers)
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

## Quick start (Docker, recommended)

```bash
# 1. Clone
git clone https://github.com/<your-org>/Docker-Dashboard.git
cd Docker-Dashboard

# 2. One-shot deploy (generates .env, detects docker GID, fixes perms, builds, starts)
./deploy.sh
```

Open **http://localhost:3000** and log in with:

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

Your data in `./data/db.json` is preserved across rebuilds.

---

## Manual setup (Node.js, for development)

Useful when hacking on the code without rebuilding a Docker image every time.

```bash
# 1. Clone & install
git clone https://github.com/<your-org>/Docker-Dashboard.git
cd Docker-Dashboard
npm install

# 2. Set required env vars
export JWT_SECRET=$(openssl rand -hex 32)
export DEFAULT_ADMIN_PASSWORD=admin123     # optional, only used on first boot
export PORT=3000                           # optional

# 3. Run in watch mode
npm run dev      # auto-restarts on file changes (node --watch)
# or
npm start        # single run
```

Your local Docker socket at `/var/run/docker.sock` is used automatically if present. On macOS with Docker Desktop this works out of the box.

Data is written to `./data/db.json`. Override the location with `DATA_DIR=/some/path`.

---

## Configuration

All configuration is via environment variables. In Docker deployments these come from `.env` (see [`.env.example`](.env.example)).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | **yes** | — | HMAC secret for signing session tokens. Generate with `openssl rand -hex 32`. |
| `DEFAULT_ADMIN_PASSWORD` | no | `admin123` | Password for the bootstrap admin user. Only used on first boot (when the DB is empty). |
| `PORT` | no | `3000` | HTTP port the API listens on. |
| `DATA_DIR` | no | `./data` (dev) / `/app/data` (Docker) | Directory for `db.json`. |
| `DOCKER_GID` | yes (Docker only) | auto-detected | GID of the host `docker` group. Required so the non-root container user can read `/var/run/docker.sock`. Find it with `getent group docker \| cut -d: -f3`. |
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

### Regenerating `JWT_SECRET`

Rotating the secret will invalidate all existing sessions — users will be logged out and need to re-authenticate. User accounts and passwords are *not* affected.

---

## First login & initial setup

1. Log in at `http://<host>:3000` with `admin / admin123`.
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
│   ├── db.js              # lowdb store, bootstrap admin + local server
│   ├── auth.js            # JWT + bcrypt, auth middleware, /api/auth routes
│   ├── security.js        # Access logger, IP blocklist, global rate limiter
│   ├── metrics.js         # Pure CPU / memory math (no I/O)
│   ├── serverManager.js   # Per-server dockerode connection cache + polling
│   └── routes/
│       ├── servers.js     # CRUD + SSE status for remote servers
│       ├── docker.js      # Per-server container endpoints + metrics SSE
│       └── users.js       # User / role / container-assignment admin
├── scripts/
│   ├── daily-maintenance.sh   # Cron entrypoint: docker prune + abuse scan + iptables
│   ├── install-cron.sh        # Registers the daily cron entry
│   └── scan-access-log.mjs    # NDJSON access-log parser, refreshes blocklist.json
├── public/
│   ├── index.html         # Main dashboard
│   ├── login.html         # Auth
│   ├── servers.html       # Remote-server manager
│   ├── admin.html         # User admin
│   ├── css/styles.css
│   └── js/api.js          # Shared fetch/auth helpers
├── Dockerfile             # Multi-stage prod image (non-root UID 1001)
├── docker-compose.yml     # Volumes, socket mount, group_add
├── deploy.sh              # One-shot setup script
├── .env.example           # Template env
└── package.json
```

---

## Troubleshooting

### `EACCES: permission denied, open '/app/data/.db.json.tmp'`

The bind-mounted `./data` on the host is owned by root; the container runs as UID 1001.

```bash
sudo chown -R 1001:1001 ./data
docker compose up -d --force-recreate
```

### `502 Bad Gateway` from `/api/servers/local/containers`

The container can't reach `/var/run/docker.sock`. Make sure `DOCKER_GID` in `.env` matches the host's `docker` group GID.

```bash
getent group docker | cut -d: -f3        # e.g. 999
grep DOCKER_GID .env                     # should match
# if not, update .env and:
docker compose up -d --force-recreate
```

### Port 3000 unreachable from your browser

- Local Ubuntu firewall: `sudo ufw status`; if active, `sudo ufw allow 3000/tcp`.
- Cloud firewall (DigitalOcean / AWS / GCP): add an inbound TCP 3000 rule. Prefer scoping by source IP.

### Container keeps restarting

```bash
docker compose logs --tail=100 dashboard
```

Most startup errors are in the first ~20 lines — typically a missing `JWT_SECRET` or `DOCKER_GID`.

---

## Security notes

This is a powerful tool: anyone with admin access to the dashboard effectively has root on every attached Docker host. Treat it accordingly.

- **Never expose port 3000 to the public internet without a reverse proxy + TLS + strong passwords.** Put it behind nginx / Caddy / Traefik with HTTPS, and bind the container to `127.0.0.1:3000:3000` so the proxy is the only entry.
- **Change `admin123` immediately.** Bots scan port 3000.
- **Rotate `JWT_SECRET`** on any suspected compromise — this invalidates every existing session.
- **Scope by source IP** in your cloud firewall where possible.
- **Use TLS** for any remote Docker connection — plain TCP (`2375`) on an untrusted network is a critical vulnerability.
- **Least-privilege users:** create viewer accounts with specific container assignments instead of sharing the admin account.

Found a vulnerability? Please open a private security advisory rather than a public issue.

---

## Roadmap

- [x] Phase 1 — Auth, multi-server, container list / logs / actions, user roles
- [x] Phase 2a — Live host + per-container CPU / memory metrics (tiles, sparklines, charts)
- [ ] Phase 2b — "Deploy from Git": pull any repo, build image, run container (admin-only initially)
- [ ] Persistent metric history (optional cAdvisor + Prometheus sidecar)
- [ ] Image and volume management views
- [ ] Audit log of user actions
- [ ] Email / webhook alerts on container exit / high resource use

---

## Contributing

Contributions are very welcome — from typo fixes to whole features. Here's the shape of a good contribution:

### 1. Set up for development

```bash
git clone https://github.com/<your-org>/Docker-Dashboard.git
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
