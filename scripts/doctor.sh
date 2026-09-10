#!/usr/bin/env bash
# Checks everything a session needs on this host and says what is wrong.
#
#   curl -fsSL https://raw.githubusercontent.com/Fadi-yt1/browser/main/scripts/doctor.sh | sudo bash
#
# Safe to run any time: it only reads state and starts nothing.
set -uo pipefail

GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
ok()   { echo "  ${GREEN}ok${OFF}    $*"; }
bad()  { echo "  ${RED}FAIL${OFF}  $*"; PROBLEMS+=("$*"); }
warn() { echo "  ${YELLOW}warn${OFF}  $*"; }
head_() { echo; echo "${BOLD}$*${OFF}"; }

PROBLEMS=()
INSTALL_DIR="${INSTALL_DIR:-/opt/driftwood}"
PORT="${PORT:-8080}"

head_ "host"
echo "  $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") · $(uname -r)"
CORES=$(nproc); RAM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo)
VIRT=$(systemd-detect-virt 2>/dev/null || echo unknown)
echo "  cores: $CORES · RAM: ${RAM_MB} MB · swap: ${SWAP_MB} MB · virt: $VIRT"
(( RAM_MB >= 700 )) || bad "only ${RAM_MB} MB RAM; a session needs ~700 MB"
(( RAM_MB >= 1400 || SWAP_MB >= 512 )) && : || warn "under 1.4 GB with little swap: Chromium will be killed on heavy pages"
df -h / | awk 'NR==2 {print "  disk free on /: " $4}'

head_ "browser (the usual culprit)"
FOUND_BROWSER=""
for bin in chromium chromium-browser google-chrome google-chrome-stable "${CHROMIUM_BIN:-}"; do
  [[ -z "$bin" ]] && continue
  path=$(command -v "$bin" 2>/dev/null) || continue
  ver=$(timeout 15 "$path" --version 2>/dev/null)
  if grep -qiE 'chrom\w*[[:space:]]+[0-9]+\.[0-9.]+' <<<"$ver"; then
    ok "$path -> $ver"
    [[ -z "$FOUND_BROWSER" ]] && FOUND_BROWSER="$path"
  else
    bad "$path exists but does not run (usually Ubuntu's snap wrapper without snapd)"
  fi
done
# Playwright ships a working Chromium that the local runtime will happily use.
for c in "${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"/chromium-*/chrome-linux/chrome; do
  [[ -x "$c" ]] || continue
  if timeout 15 "$c" --version 2>/dev/null | grep -qi chrom; then
    ok "$c (Playwright)"
    [[ -z "$FOUND_BROWSER" ]] && FOUND_BROWSER="$c"
  fi
done
[[ -n "$FOUND_BROWSER" ]] || bad "no working browser at all — sessions cannot start"

head_ "session tools"
for tool in Xvfb x11vnc openbox xdotool xclip xdpyinfo node; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool"
  else
    [[ "$tool" == "xdotool" || "$tool" == "xclip" ]] && warn "$tool missing (clipboard only)" || bad "$tool is not installed"
  fi
done
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  (( major >= 20 )) && ok "node $(node -v)" || bad "node $(node -v) is too old; version 20 or newer is required"
fi

head_ "can an X session actually start?"
if command -v Xvfb >/dev/null 2>&1 && [[ -n "$FOUND_BROWSER" ]]; then
  disp=":97"
  Xvfb "$disp" -screen 0 800x600x24 -nolisten tcp >/dev/null 2>&1 &
  xpid=$!
  sleep 2
  if xdpyinfo -display "$disp" >/dev/null 2>&1; then
    ok "Xvfb starts and accepts connections"
    if timeout 25 env DISPLAY="$disp" "$FOUND_BROWSER" --no-sandbox --headless=new \
         --disable-gpu --dump-dom about:blank >/dev/null 2>&1; then
      ok "the browser runs against a display"
    else
      bad "the browser will not run against a display (missing shared libraries?)"
    fi
  else
    bad "Xvfb did not come up"
  fi
  kill $xpid 2>/dev/null
else
  warn "skipped: needs both Xvfb and a working browser"
fi

head_ "installation and service"
[[ -d "$INSTALL_DIR" ]] && ok "$INSTALL_DIR present" || warn "$INSTALL_DIR not found"
[[ -f "$INSTALL_DIR/server/dist/index.js" ]] && ok "gateway is built" || warn "gateway build missing (run npm run build in server/)"
[[ -f "$INSTALL_DIR/.env" ]] && ok ".env present: $(grep -c . "$INSTALL_DIR/.env") settings" || warn ".env missing"
if [[ -d /run/systemd/system ]]; then
  state=$(systemctl is-active driftwood 2>/dev/null || true)
  [[ "$state" == "active" ]] && ok "driftwood.service is active" || warn "driftwood.service is $state"
else
  warn "no systemd on this host; the gateway must be started by hand"
fi

head_ "gateway"
health=$(curl -sf --max-time 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null)
if [[ -n "$health" ]]; then
  ok "answering on port $PORT"
  echo "        $health"
else
  # Distinguish "not started" from "started but broken": what is on the port?
  listener=$(ss -ltnp 2>/dev/null | grep ":${PORT} " || true)
  if [[ -z "$listener" ]]; then
    bad "nothing is listening on port ${PORT} — the gateway is not running"
    NOT_RUNNING=1
  else
    bad "something is listening on port ${PORT} but it is not answering /api/health"
    echo "        $listener"
    echo "        (another program may have taken the port)"
  fi
fi

head_ "recent session errors"
if [[ -d /run/systemd/system ]] && systemctl list-unit-files driftwood.service >/dev/null 2>&1; then
  journalctl -u driftwood -n 200 --no-pager 2>/dev/null | grep -iE 'error|failed' | tail -5 | sed 's/^/  /' \
    || echo "  (none)"
else
  echo "  (no service logs; check wherever you redirected the gateway output)"
fi

echo
if (( ${#PROBLEMS[@]} == 0 )); then
  echo "${GREEN}${BOLD}No blocking problems found.${OFF}"
else
  echo "${RED}${BOLD}${#PROBLEMS[@]} problem(s) found:${OFF}"
  for p in "${PROBLEMS[@]}"; do echo "  - $p"; done
  echo
  echo "${BOLD}Most likely fix${OFF}"
  if [[ -n "${NOT_RUNNING:-}" ]]; then
    if [[ -d /run/systemd/system ]] && systemctl list-unit-files driftwood.service >/dev/null 2>&1; then
      cat <<FIX
  Start the service and check why it stopped:

    sudo systemctl start driftwood
    sudo systemctl status driftwood --no-pager
    sudo journalctl -u driftwood -n 50 --no-pager
FIX
    elif [[ -d "$INSTALL_DIR" ]]; then
      cat <<FIX
  Nothing is running and there is no service on this host. Start it by hand:

    cd $INSTALL_DIR
    set -a; . ./.env; set +a
    STATIC_DIR=$INSTALL_DIR/web/dist nohup node server/dist/index.js > /var/log/driftwood.log 2>&1 &

  Then watch it with:  tail -f /var/log/driftwood.log
FIX
    else
      echo "  Nothing is installed yet. Run the installer:"
      echo "    curl -fsSL https://raw.githubusercontent.com/Fadi-yt1/browser/main/scripts/install.sh -o install.sh && bash install.sh"
    fi
    echo
  fi
  if [[ -z "$FOUND_BROWSER" || " ${PROBLEMS[*]} " == *"does not run"* ]]; then
    cat <<'FIX'
  Install a real Chromium .deb. Ubuntu's package is a snap wrapper that cannot run
  without snapd, which is why sessions fail while the site loads fine:

    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | sudo gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
      | sudo tee /etc/apt/sources.list.d/google-chrome.list
    sudo apt-get update && sudo apt-get install -y google-chrome-stable
    sudo systemctl restart driftwood
FIX
  else
    echo "  Address the failures above, then restart the gateway."
  fi
fi
