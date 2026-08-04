#!/bin/bash
# Headless-browser UI pass: build, preview, drive with Playwright.
# Usage: tools/uicheck/run.sh   (from anywhere inside the repo)
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
PORT=${PORT:-4173}
cd "$REPO"

# One-time per container: download the headless browser.
if [ ! -d "$HOME/.cache/ms-playwright" ]; then
  echo "Installing Chromium (one-time)…"
  npx playwright install --with-deps chromium
fi

npm run build
# Invoke the local binary directly (not via `npx`, which wraps it in extra
# shell/npm layers whose PID isn't the one $! captures, leaking the server
# past this script's trap).
./node_modules/.bin/vite preview --host 127.0.0.1 --port "$PORT" --strictPort >"$SCRIPT_DIR/app.log" 2>&1 &
APP=$!
trap 'kill $APP 2>/dev/null' EXIT
curl --retry-connrefused --retry 30 --retry-delay 1 -sf "http://127.0.0.1:$PORT/" >/dev/null \
  || { echo "preview never came up:"; tail -20 "$SCRIPT_DIR/app.log"; exit 2; }

BASE_URL="http://127.0.0.1:$PORT" OUT_DIR="$SCRIPT_DIR/shots" node "$SCRIPT_DIR/check.mjs"
