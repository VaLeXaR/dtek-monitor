#!/bin/sh
set -eu

# Allow a single check or a diagnostic command via docker compose run.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

: "${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN in .env}"
: "${TELEGRAM_CHAT_ID:?Set TELEGRAM_CHAT_ID in .env}"
: "${STREET:?Set STREET in .env}"
: "${HOUSE:?Set HOUSE in .env}"

CHECK_INTERVAL_SECONDS=${CHECK_INTERVAL_SECONDS:-600}
case "$CHECK_INTERVAL_SECONDS" in
  *[!0-9]*|'')
    echo "CHECK_INTERVAL_SECONDS must be a positive integer." >&2
    exit 1
    ;;
esac
if ! [ "$CHECK_INTERVAL_SECONDS" -gt 0 ] 2>/dev/null; then
  echo "CHECK_INTERVAL_SECONDS must be a positive integer." >&2
  exit 1
fi

child_pid=
stop() {
  trap '' TERM INT
  if [ -n "$child_pid" ]; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  exit 0
}
trap stop TERM INT

echo "Monitoring started; interval: ${CHECK_INTERVAL_SECONDS}s."
while true; do
  node ./src/monitor.js &
  child_pid=$!
  if wait "$child_pid"; then
    :
  else
    echo "Check failed; retrying in ${CHECK_INTERVAL_SECONDS}s." >&2
  fi
  sleep "$CHECK_INTERVAL_SECONDS" &
  child_pid=$!
  wait "$child_pid"
done
