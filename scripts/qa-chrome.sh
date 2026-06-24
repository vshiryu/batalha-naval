#!/usr/bin/env bash
# Launch a headless Chrome with SOFTWARE WebGL enabled on the webtest CDP port,
# so PixiJS can create a WebGL renderer during browser QA.
#
# The webtest skill's own launcher passes --disable-gpu (which kills WebGL); but
# it reuses any Chrome already listening on the port. So start this FIRST, then
# run webtest commands normally — they will attach to this WebGL-enabled Chrome.
#
# Usage:  bash scripts/qa-chrome.sh [WIDTH] [HEIGHT]
#         WIDTH/HEIGHT default to a mobile portrait viewport (390x844).
#
# Note: do NOT run `webtest restart` after this (it would relaunch with
# --disable-gpu). If you must restart, re-run this script afterwards.

set -u
W="${1:-390}"
H="${2:-844}"
PORT="${BROWSER_PORT:-9222}"
PROFILE="${HOME}/.cache/claude-browser/profile"

CHROME="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [ -z "$CHROME" ]; then echo "No Chrome/Chromium found in PATH"; exit 1; fi

# If a Chrome is already on the port, leave it (assume it's correctly configured).
if curl -s "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "Chrome already listening on :${PORT} — reusing it."
  exit 0
fi

echo "Launching WebGL Chrome (${W}x${H}) on :${PORT} ..."
nohup "$CHROME" --headless=new --no-sandbox \
  --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
  --enable-webgl --ignore-gpu-blocklist \
  --window-size="${W},${H}" --remote-debugging-port="${PORT}" \
  --user-data-dir="$PROFILE" about:blank >/tmp/qa-chrome.log 2>&1 &

for _ in $(seq 1 30); do
  curl -s "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1 && break
  sleep 0.3
done
if curl -s "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "WebGL Chrome up on :${PORT}."
else
  echo "Chrome failed to start; see /tmp/qa-chrome.log"; tail -n 12 /tmp/qa-chrome.log; exit 1
fi
