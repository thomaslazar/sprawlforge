#!/bin/bash
# Dev-serve the repo and screenshot the partition toy.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
PORT=${PORT:-5173}
cd "$REPO"
./node_modules/.bin/vite dev --host 127.0.0.1 --port "$PORT" --strictPort >"$SCRIPT_DIR/app.log" 2>&1 &
APP=$!
trap 'kill $APP 2>/dev/null' EXIT
curl --retry-connrefused --retry 30 --retry-delay 1 -sf "http://127.0.0.1:$PORT/" >/dev/null \
  || { echo "dev server never came up:"; tail -20 "$SCRIPT_DIR/app.log"; exit 2; }
BASE_URL="http://127.0.0.1:$PORT" node "$SCRIPT_DIR/shot.mjs"
