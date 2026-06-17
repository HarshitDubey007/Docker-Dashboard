#!/usr/bin/env bash
#
# Turnkey native launcher — run the dashboard directly ON the host (not in
# Docker) so it can see and control host-level PM2 apps and systemd services in
# addition to Docker containers.
#
#   git clone <repo> && cd Docker-Dashboard && ./start.sh
#
# Run as root (sudo ./start.sh) to manage root-owned PM2 apps and all systemd
# units. As a normal user you only see that user's PM2 daemon. For a Docker-only
# deployment, use ./deploy.sh instead.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

c_cyan="\033[36m"; c_green="\033[32m"; c_yellow="\033[33m"; c_red="\033[31m"; c_reset="\033[0m"; c_bold="\033[1m"
log()  { echo -e "${c_cyan}[start]${c_reset} $*"; }
ok()   { echo -e "${c_green}[ok]${c_reset} $*"; }
warn() { echo -e "${c_yellow}[warn]${c_reset} $*"; }
err()  { echo -e "${c_red}[err]${c_reset} $*" >&2; }

# 1. Node.js
if ! command -v node >/dev/null 2>&1; then
  err "Node.js 20+ is required but not found. Install it: https://nodejs.org"; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node.js 20+ required (found $(node -v))"; exit 1
fi
ok "node $(node -v)"

# 2. Dependencies
if [ ! -d node_modules ]; then
  log "Installing dependencies (npm install)..."
  npm install
fi
ok "dependencies ready"

# 3. .env (generated once; auto-loaded by src/loadEnv.js at startup)
if [ ! -f .env ]; then
  log ".env not found — generating one with a random JWT_SECRET"
  if command -v openssl >/dev/null 2>&1; then
    SECRET="$(openssl rand -hex 32)"
  else
    SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  fi
  cat > .env <<EOF
PORT=3000
JWT_SECRET=${SECRET}
DEFAULT_ADMIN_PASSWORD=admin123
EOF
  ok "wrote .env (random JWT_SECRET, default admin password 'admin123' — change it after first login)"
else
  ok ".env already exists"
fi

# 4. Privilege heads-up for the host-level sources
if [ "$(id -u)" = "0" ]; then
  ok "running as root — PM2 (root's daemon) and systemd units will be manageable"
else
  warn "running as '$(whoami)' (not root): you'll only see this user's PM2 daemon"
  warn "and systemd units readable by it. To manage root-owned PM2 apps / all"
  warn "systemd units, stop this and re-run:  sudo ./start.sh"
fi

# 5. Launch (foreground; Ctrl-C to stop). For persistence, see the README
#    (run under pm2 or install a systemd unit).
PORT_VAL="$(grep -E '^PORT=' .env | cut -d= -f2 || echo 3000)"; PORT_VAL="${PORT_VAL:-3000}"
echo
ok "starting Docker Dashboard on http://localhost:${PORT_VAL}  (login: admin / see .env)"
warn "this runs in the foreground — Ctrl-C to stop. See README for running it persistently."
echo
exec node src/server.js
