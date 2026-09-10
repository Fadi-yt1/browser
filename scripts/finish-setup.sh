#!/usr/bin/env bash
# Takes a host from "installed but not working" to "launch button works", then
# proves it by starting a real browser session and tearing it down again.
#
#   curl -fsSL https://raw.githubusercontent.com/Fadi-yt1/browser/main/scripts/finish-setup.sh -o finish.sh
#   sudo bash finish.sh
#
# Idempotent: everything it does is a no-op if it is already done.
set -uo pipefail

GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
say()  { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$OFF"; }
ok()   { echo "  ${GREEN}ok${OFF}    $*"; }
warn() { echo "  ${YELLOW}warn${OFF}  $*"; }
die()  { printf '\n%s%s FAILED: %s%s\n' "$RED" "$BOLD" "$*" "$OFF"; exit 1; }

INSTALL_DIR="${INSTALL_DIR:-/opt/driftwood}"
PORT="${PORT:-8080}"
API="http://127.0.0.1:${PORT}"

[[ $EUID -eq 0 ]] || die "run this with sudo"

# --- 1. a browser that actually runs ---------------------------------------
say "checking for a working browser"
runs_ok() {
  timeout 15 "$1" --version 2>/dev/null | grep -qiE 'chrom\w*[[:space:]]+[0-9]+\.[0-9.]+'
}

# Same resolution order the gateway itself uses, including a Playwright install,
# so this script never "fixes" a host that already has a browser the app accepts.
working_browser() {
  for bin in "${CHROMIUM_BIN:-}" chromium chromium-browser google-chrome google-chrome-stable; do
    [[ -z "$bin" ]] && continue
    command -v "$bin" >/dev/null 2>&1 || continue
    runs_ok "$bin" && { echo "$bin"; return 0; }
  done
  for c in "${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"/chromium-*/chrome-linux/chrome; do
    [[ -x "$c" ]] || continue
    runs_ok "$c" && { echo "$c"; return 0; }
  done
  return 1
}

if browser=$(working_browser); then
  ok "$browser — $($browser --version 2>/dev/null)"
else
  warn "no working browser (Ubuntu's chromium is a snap wrapper that needs snapd)"
  say "installing Google Chrome"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg 2>/dev/null
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq
  if ! apt-get install -y -qq google-chrome-stable >/dev/null 2>&1; then
    warn "Google Chrome could not be installed; trying the distro chromium package"
    apt-get install -y -qq chromium >/dev/null 2>&1 || true
  fi
  if ! browser=$(working_browser); then
    cat <<'HELP'

  No working browser could be installed automatically. Options, in order:

    1. Check this host can reach dl.google.com (a firewall or proxy may block it).
    2. On Debian, the real package works:      sudo apt-get install -y chromium
    3. If the host supports snap:              sudo snap install chromium
    4. Point the gateway at any Chrome you have:
         echo 'CHROMIUM_BIN=/path/to/chrome' >> /opt/driftwood/.env
       then re-run this script.
HELP
    die "no usable browser on this host"
  fi
  ok "$browser — $($browser --version 2>/dev/null)"
fi

# --- 2. the X pieces --------------------------------------------------------
say "checking the session tools"
missing=()
for tool in Xvfb x11vnc openbox xdpyinfo; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
if (( ${#missing[@]} )); then
  warn "installing: ${missing[*]}"
  apt-get install -y -qq xvfb x11vnc openbox xdotool xclip x11-utils >/dev/null \
    || die "could not install the X tools"
fi
ok "Xvfb, x11vnc, openbox present"

# --- 3. the gateway is installed and running --------------------------------
say "checking the gateway"
[[ -f "$INSTALL_DIR/server/dist/index.js" ]] \
  || die "no install at $INSTALL_DIR — run scripts/install.sh first"

start_gateway() {
  if [[ -d /run/systemd/system ]] && systemctl list-unit-files driftwood.service >/dev/null 2>&1; then
    systemctl restart driftwood
  else
    pkill -f "$INSTALL_DIR/server/dist/index.js" 2>/dev/null
    ( cd "$INSTALL_DIR" && set -a && . ./.env && set +a \
      && STATIC_DIR="$INSTALL_DIR/web/dist" nohup node server/dist/index.js \
         > /var/log/driftwood.log 2>&1 & )
  fi
}

start_gateway
for _ in $(seq 1 30); do
  curl -sf --max-time 3 "$API/api/health" >/dev/null 2>&1 && break
  sleep 1
done
health=$(curl -sf --max-time 5 "$API/api/health" 2>/dev/null) \
  || die "the gateway is not answering on port $PORT (see journalctl -u driftwood or /var/log/driftwood.log)"
ok "answering: $health"

# --- 4. prove a real session starts -----------------------------------------
say "launching a real browser session"
body=$(curl -sf --max-time 90 -X POST "$API/api/sessions" \
  -H 'content-type: application/json' -d '{"width":1024,"height":700}' 2>/dev/null)

if ! grep -q '"state":"ready"' <<<"$body"; then
  echo "  response: ${body:-<none>}"
  die "the session did not start. Run scripts/doctor.sh for a full report."
fi
ok "a browser session started"

# Clean up the test session so the capacity is free for real visitors.
id=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' <<<"$body" | head -1)
token=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' <<<"$body" | head -1)
curl -sf -X DELETE -H "x-session-token: $token" "$API/api/sessions/$id" >/dev/null 2>&1 \
  && ok "test session cleaned up"

# --- 5. where to go ---------------------------------------------------------
ip=$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
cat <<DONE

${GREEN}${BOLD} Everything works. Open it:${OFF}

    http://${ip:-<your-server-ip>}:${PORT}

  Press Launch — the browser runs here and streams to your tab.

  Notes
    · Serve over plain http:// for now. An https:// page cannot talk to an
      http:// server, so use this address rather than the GitHub Pages one
      until TLS is set up (deploy/README.md section 2).
    · If the page does not load from outside, open the port:
        sudo ufw allow ${PORT}/tcp
      and check your provider's firewall panel too.
DONE
