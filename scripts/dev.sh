#!/usr/bin/env bash
# Local development: builds the session image once, then runs the gateway and the
# Vite dev server side by side with hot reload.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! docker image inspect browser-in-browser/session:latest >/dev/null 2>&1; then
  echo "==> building session image (first run only, a few minutes)"
  docker build -t browser-in-browser/session:latest ./browser-image
fi

[[ -d server/node_modules ]] || (cd server && npm install)
[[ -d web/node_modules ]] || (cd web && npm install)

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# No BROWSER_NETWORK in dev: ports are published on loopback instead.
(cd server && BROWSER_IMAGE=browser-in-browser/session:latest npm run dev) &
(cd web && npm run dev) &

echo "==> gateway http://localhost:8080 · app http://localhost:5173"
wait -n
