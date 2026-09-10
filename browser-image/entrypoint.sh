#!/usr/bin/env bash
# Boots one disposable browser session: X -> WM -> Chromium -> VNC -> agent.
# If any of them dies, the whole container exits so the orchestrator can reap it.
set -euo pipefail

WIDTH="${SCREEN_WIDTH:-1280}"
HEIGHT="${SCREEN_HEIGHT:-800}"
DEPTH="${SCREEN_DEPTH:-24}"
START_URL="${START_URL:-about:blank}"
PROFILE_DIR="${PROFILE_DIR:-/home/surf/profile}"

log() { echo "[session] $*"; }

cleanup() {
  # Kill the whole process group; the container is thrown away anyway.
  trap - TERM INT EXIT
  kill 0 2>/dev/null || true
}
trap cleanup TERM INT EXIT

rm -rf "${PROFILE_DIR:?}"/* 2>/dev/null || true
mkdir -p "$PROFILE_DIR"

log "starting Xvfb ${WIDTH}x${HEIGHT}x${DEPTH}"
Xvfb "$DISPLAY" -screen 0 "${WIDTH}x${HEIGHT}x${DEPTH}" -nolisten tcp -dpi 96 +extension RANDR &

for _ in $(seq 1 50); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.2
done
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 || { log "X server failed to start"; exit 1; }

log "starting window manager"
openbox --sm-disable &

# Per-session VNC password, injected by the orchestrator. Written to an rfbauth
# file rather than passed on argv so it never shows up in the process list.
VNC_AUTH_ARGS=(-nopw)
if [[ -n "${VNC_PASSWORD:-}" ]]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /home/surf/.vnc/passwd >/dev/null 2>&1
  chmod 600 /home/surf/.vnc/passwd
  VNC_AUTH_ARGS=(-rfbauth /home/surf/.vnc/passwd)
  unset VNC_PASSWORD
fi

log "starting Chromium"
chromium \
  --user-data-dir="$PROFILE_DIR" \
  --window-position=0,0 \
  --window-size="${WIDTH},${HEIGHT}" \
  --remote-debugging-port=9222 \
  --remote-allow-origins=http://127.0.0.1:9222 \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication \
  --disable-background-networking \
  --disable-breakpad \
  --disable-sync \
  --password-store=basic \
  --use-mock-keychain \
  --incognito \
  --start-maximized \
  "$START_URL" &

log "starting VNC exporter"
x11vnc \
  -display "$DISPLAY" \
  -rfbport 5900 \
  -listen 0.0.0.0 \
  -forever \
  -shared \
  -noxdamage \
  -nolookup \
  -ncache 0 \
  -wait 10 \
  -defer 10 \
  -quiet \
  "${VNC_AUTH_ARGS[@]}" &

log "starting control agent"
node /opt/agent/agent.mjs &

# Exit as soon as the first child dies.
wait -n
log "a session process exited; shutting down"
exit 1
