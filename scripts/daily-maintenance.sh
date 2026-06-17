#!/usr/bin/env bash
# Daily maintenance: docker prune + abuse-log scan + IP blocklist refresh.
# Designed to run from cron on the Docker host (Linux).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

DATA_DIR="${PROJECT_DIR}/data"
ACCESS_LOG="${DATA_DIR}/access.log"
BLOCKLIST_FILE="${DATA_DIR}/blocklist.json"
MAINT_LOG="${DATA_DIR}/maintenance.log"
CONTAINER="${DASHBOARD_CONTAINER:-docker-dashboard}"

DDOS_REQ_PER_DAY="${DDOS_REQ_PER_DAY:-10000}"
DDOS_AUTH_FAIL_PER_DAY="${DDOS_AUTH_FAIL_PER_DAY:-50}"
DDOS_RATE_LIMIT_HITS_PER_DAY="${DDOS_RATE_LIMIT_HITS_PER_DAY:-100}"
BLOCK_TTL_HOURS="${BLOCK_TTL_HOURS:-24}"
BLOCK_AT_HOST="${BLOCK_AT_HOST:-0}"
PRUNE_VOLUMES="${PRUNE_VOLUMES:-0}"
ACCESS_LOG_MAX_BYTES="${ACCESS_LOG_MAX_BYTES:-52428800}"

mkdir -p "$DATA_DIR"
exec >> "$MAINT_LOG" 2>&1

ts()  { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "[$(ts)] $*"; }

log "=== daily-maintenance start ==="

# 1. Docker prune (memory / disk hygiene)
if command -v docker >/dev/null 2>&1; then
  log "docker container prune"
  docker container prune -f || log "  container prune failed"
  log "docker image prune -af"
  docker image prune -af || log "  image prune failed"
  log "docker network prune"
  docker network prune -f || log "  network prune failed"
  log "docker builder prune -af"
  docker builder prune -af || log "  builder prune failed"
  if [ "$PRUNE_VOLUMES" = "1" ]; then
    log "PRUNE_VOLUMES=1 — pruning unused volumes (DESTRUCTIVE)"
    docker volume prune -f || log "  volume prune failed"
  fi
  log "disk usage after prune:"
  docker system df 2>&1 | sed 's/^/  /' || true
else
  log "docker not installed — skipping prune"
fi

# 2. Abuse-log scan → refresh blocklist
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  log "container '$CONTAINER' not running — skipping log scan"
else
  log "scanning access log via 'docker exec $CONTAINER'"
  if docker exec "$CONTAINER" test -f /app/scripts/scan-access-log.mjs 2>/dev/null; then
    docker exec "$CONTAINER" node /app/scripts/scan-access-log.mjs \
      --log /app/data/access.log \
      --blocklist /app/data/blocklist.json \
      --req-threshold "$DDOS_REQ_PER_DAY" \
      --auth-fail-threshold "$DDOS_AUTH_FAIL_PER_DAY" \
      --rate-hit-threshold "$DDOS_RATE_LIMIT_HITS_PER_DAY" \
      --ttl-hours "$BLOCK_TTL_HOURS" \
      --window-hours 24 2>&1 | sed 's/^/  /' || log "  scan exited non-zero"
  else
    log "  scanner not present in image — rebuild container after pulling latest code"
  fi
fi

# 3. Optional host-level iptables block (Linux + root + iptables required)
if [ "$BLOCK_AT_HOST" = "1" ]; then
  if [ "$(id -u)" != "0" ]; then
    log "BLOCK_AT_HOST=1 but not root — skipping iptables. Install cron under root."
  elif ! command -v iptables >/dev/null 2>&1; then
    log "BLOCK_AT_HOST=1 but iptables not found — skipping"
  elif [ ! -f "$BLOCKLIST_FILE" ]; then
    log "BLOCK_AT_HOST=1 but blocklist file missing — skipping"
  else
    log "applying iptables DROP rules in DOCKER-USER chain"
    iptables -L DOCKER-USER >/dev/null 2>&1 || iptables -N DOCKER-USER || true
    # Extract active (non-expired) IPs via the dashboard container's node runtime
    ACTIVE_IPS="$(docker exec "$CONTAINER" node -e '
      const fs = require("fs");
      try {
        const d = JSON.parse(fs.readFileSync("/app/data/blocklist.json", "utf8"));
        const now = Date.now();
        for (const e of d.blocked || []) {
          if (!e.expiresAt || new Date(e.expiresAt).getTime() > now) console.log(e.ip);
        }
      } catch {}
    ' 2>/dev/null || true)"
    while IFS= read -r ip; do
      [ -z "$ip" ] && continue
      if iptables -C DOCKER-USER -s "$ip" -j DROP 2>/dev/null; then
        :
      else
        iptables -I DOCKER-USER -s "$ip" -j DROP && log "  DROP $ip"
      fi
    done <<< "$ACTIVE_IPS"
  fi
fi

# 4. Rotate access log if oversized
if [ -f "$ACCESS_LOG" ]; then
  SIZE=$(wc -c < "$ACCESS_LOG" 2>/dev/null || echo 0)
  if [ "$SIZE" -gt "$ACCESS_LOG_MAX_BYTES" ]; then
    log "rotating access.log (size=${SIZE} > ${ACCESS_LOG_MAX_BYTES})"
    mv "$ACCESS_LOG" "${ACCESS_LOG}.1"
    : > "$ACCESS_LOG" || true
  fi
fi

log "=== daily-maintenance end ==="
