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

DOCKER_GID=""
if [ -S /var/run/docker.sock ]; then
  ok "docker socket: /var/run/docker.sock present"
  if command -v stat >/dev/null 2>&1; then
    # Linux stat (GNU) first, fall back to BSD stat (macOS)
    DOCKER_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || stat -f '%g' /var/run/docker.sock 2>/dev/null || echo "")"
  fi
  if [ -z "$DOCKER_GID" ] && command -v getent >/dev/null 2>&1; then
    DOCKER_GID="$(getent group docker | cut -d: -f3 || true)"
  fi
  if [ -n "$DOCKER_GID" ]; then
    ok "docker socket GID detected: ${DOCKER_GID}"
  else
    warn "Could not detect docker socket GID — defaulting to 999. Edit DOCKER_GID in .env if the container can't reach the socket."
    DOCKER_GID=999
  fi
else
  warn "/var/run/docker.sock not found — the 'Local Server' will not appear. You can still add remote servers."
  DOCKER_GID=999
fi

if [ ! -f .env ]; then
  log ".env not found — creating one with a random JWT_SECRET"
  if command -v openssl >/dev/null 2>&1; then
    GENERATED_SECRET="$(openssl rand -hex 32)"
  else
    GENERATED_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '=+/ \n' | head -c 64)"
  fi
  cat > .env <<EOF
PORT=3006
JWT_SECRET=${GENERATED_SECRET}
DEFAULT_ADMIN_PASSWORD=admin123
DOCKER_GID=${DOCKER_GID}
EOF
  ok "Wrote .env (JWT_SECRET generated, DOCKER_GID=${DOCKER_GID})"
else
  ok ".env already exists"
  if grep -qE '^DOCKER_GID=' .env; then
    CURRENT_GID="$(grep -E '^DOCKER_GID=' .env | cut -d= -f2)"
    if [ "$CURRENT_GID" != "$DOCKER_GID" ]; then
      warn "DOCKER_GID in .env is ${CURRENT_GID}, but host socket GID is ${DOCKER_GID}. Leaving .env untouched — update it manually if the container can't reach docker.sock."
    fi
  else
    log "Appending DOCKER_GID=${DOCKER_GID} to existing .env"
    printf '\nDOCKER_GID=%s\n' "$DOCKER_GID" >> .env
  fi
fi

mkdir -p data
# The container runs as UID 1001 (see Dockerfile). The host-side bind mount must
# be writable by that UID, or the app dies at startup with:
#   EACCES: permission denied, open '/app/data/.db.json.tmp'
# GNU stat first, BSD/macOS stat as fallback.
DATA_UID="$(stat -c '%u' data 2>/dev/null || stat -f '%u' data 2>/dev/null || echo "")"
if [ "$DATA_UID" = "1001" ]; then
  ok "data/ already owned by UID 1001"
elif [ "$(id -u)" = "0" ]; then
  chown -R 1001:1001 data
  ok "data/ directory ready (chown 1001:1001)"
elif command -v sudo >/dev/null 2>&1; then
  log "data/ is not owned by UID 1001 and we're not root — fixing with sudo"
  if sudo chown -R 1001:1001 data; then
    ok "data/ directory ready (sudo chown 1001:1001)"
  else
    warn "Could not chown data/. If the container logs show EACCES on /app/data, run: sudo chown -R 1001:1001 data"
  fi
else
  warn "Not root and sudo unavailable — can't chown data/. If the container logs show EACCES on /app/data, run: sudo chown -R 1001:1001 data"
fi

log "Building & starting container..."
"${COMPOSE[@]}" up -d --build

log "Waiting for container health..."
sleep 3
"${COMPOSE[@]}" ps

PORT_VAL="$(grep -E '^PORT=' .env | cut -d= -f2 || echo 3006)"
PORT_VAL="${PORT_VAL:-3006}"
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
