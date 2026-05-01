#!/usr/bin/env bash
# Register the daily maintenance script as a cron job for the current user.
# Override schedule with CRON_TIME env var (default: 0 3 * * *  — daily at 03:00 UTC).
# To install for root (needed if BLOCK_AT_HOST=1), run: sudo ./scripts/install-cron.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAINT_SCRIPT="${SCRIPT_DIR}/daily-maintenance.sh"
CRON_TIME="${CRON_TIME:-0 3 * * *}"
TAG="# docker-dashboard daily maintenance"

if [ ! -f "$MAINT_SCRIPT" ]; then
  echo "error: $MAINT_SCRIPT not found" >&2
  exit 1
fi
chmod +x "$MAINT_SCRIPT"

if ! command -v crontab >/dev/null 2>&1; then
  echo "error: crontab command not available" >&2
  exit 1
fi

EXISTING="$(crontab -l 2>/dev/null || true)"
FILTERED="$(echo "$EXISTING" | grep -vF "$TAG" | grep -vF "$MAINT_SCRIPT" || true)"

{
  if [ -n "$FILTERED" ]; then
    echo "$FILTERED"
  fi
  echo "$TAG"
  echo "$CRON_TIME $MAINT_SCRIPT"
} | crontab -

echo "Installed cron entry for user '$(whoami)':"
echo "  $CRON_TIME $MAINT_SCRIPT"
echo
echo "View:    crontab -l"
echo "Remove:  crontab -l | grep -vF '$TAG' | grep -vF '$MAINT_SCRIPT' | crontab -"
echo "Test:    $MAINT_SCRIPT  &&  tail -n 50 $(cd "$SCRIPT_DIR/.." && pwd)/data/maintenance.log"
