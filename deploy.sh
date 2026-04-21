#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

color_red="\033[31m"; color_green="\033[32m"; color_yellow="\033[33m"
color_cyan="\033[36m"; color_reset="\033[0m"; color_bold="\033[1m"

log()  { echo -e "${color_cyan}[deploy]${color_reset} $*"; }
ok()   { echo -e "${color_green}[ok]${color_reset} $*"; }
warn() { echo -e "${color_yellow}[warn]${color_reset} $*"; }
err()  { echo -e "${color_red}[err]${color_reset} $*" >&2; }

log "Checking prerequisites..."

if ! command -v docker >/dev/null 2>&1; then
  err "docker is not installed or not in PATH"; exit 1
fi
ok "docker: $(docker --version)"

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  err "docker compose (or docker-compose) is not available"; exit 1
fi
ok "compose: $("${COMPOSE[@]}" version --short 2>/dev/null || echo installed)"

if [ -S /var/run/docker.sock ]; then
  ok "docker socket: /var/run/docker.sock present"
else
  warn "/var/run/docker.sock not found — the 'Local Server' will not appear. You can still add remote servers."
fi

if [ ! -f .env ]; then
  log ".env not found — creating one with a random JWT_SECRET"
  if command -v openssl >/dev/null 2>&1; then
    GENERATED_SECRET="$(openssl rand -hex 32)"
  else
    GENERATED_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '=+/ \n' | head -c 64)"
  fi
  cat > .env <<EOF
PORT=3000
JWT_SECRET=${GENERATED_SECRET}
DEFAULT_ADMIN_PASSWORD=admin123
EOF
  ok "Wrote .env (JWT_SECRET generated)"
else
  ok ".env already exists"
fi

mkdir -p data
ok "data/ directory ready"

log "Building & starting container..."
"${COMPOSE[@]}" up -d --build

log "Waiting for container health..."
sleep 3
"${COMPOSE[@]}" ps

PORT_VAL="$(grep -E '^PORT=' .env | cut -d= -f2 || echo 3000)"
PORT_VAL="${PORT_VAL:-3000}"
ADMIN_PW="$(grep -E '^DEFAULT_ADMIN_PASSWORD=' .env | cut -d= -f2 || echo admin123)"
ADMIN_PW="${ADMIN_PW:-admin123}"

echo
echo -e "${color_bold}${color_green}============================================================${color_reset}"
echo -e "${color_bold} Docker Dashboard is up ${color_reset}"
echo -e "${color_bold}${color_green}============================================================${color_reset}"
echo -e "  URL:       ${color_cyan}http://localhost:${PORT_VAL}${color_reset}"
echo -e "  Username:  ${color_cyan}admin${color_reset}"
echo -e "  Password:  ${color_cyan}${ADMIN_PW}${color_reset}"
echo
echo -e "  ${color_yellow}⚠  Change the admin password immediately.${color_reset}"
echo -e "  Add remote Docker hosts in ${color_cyan}Settings → Servers${color_reset}."
echo -e "${color_bold}${color_green}============================================================${color_reset}"
