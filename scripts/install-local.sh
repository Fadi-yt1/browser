#!/usr/bin/env bash
# Docker-free install on a fresh Debian/Ubuntu host: system packages, a build,
# and a systemd service. Sessions run as plain processes under one service user.
#
# Use this when you own the machine and its users. For a public instance prefer
# the Docker runtime (scripts/deploy-vps.sh) — see deploy/HARDENING.md.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Fadi-yt1/browser.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/driftwood}"
SERVICE_USER="${SERVICE_USER:-driftwood}"
REPO_BRANCH="${REPO_BRANCH:-main}"

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }

echo "==> installing system packages"
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl git openssl \
  xvfb x11vnc openbox xdotool xclip x11-utils \
  fonts-liberation fonts-noto-core

# Node 20+ is required; distro packages are often older.
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  (( major >= 20 )) && need_node=0
fi
if (( need_node )); then
  echo "==> installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# Chromium: a real .deb on Debian, a snap on Ubuntu — fall back to Google Chrome there.
if ! apt-get install -y -qq chromium 2>/dev/null && ! command -v chromium >/dev/null 2>&1; then
  echo "==> chromium unavailable as a deb; installing Google Chrome instead"
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq
  apt-get install -y -qq google-chrome-stable
fi

id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPO_BRANCH"
  git -C "$INSTALL_DIR" checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH"
else
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

echo "==> building"
(cd server && npm install --no-audit --no-fund && npm run build)
(cd web && npm install --no-audit --no-fund && npm run build)

if [[ ! -f .env ]]; then
  cp .env.example .env
  {
    echo "SESSION_RUNTIME=local"
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
  } >> .env
  cores=$(nproc)
  ram_gb=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1024 / 1024 ))
  cap=$(( ram_gb * 10 / 12 )); (( cap > cores )) && cap=$cores; (( cap < 1 )) && cap=1
  sed -i "s|^MAX_CONCURRENT_SESSIONS=.*|MAX_CONCURRENT_SESSIONS=$cap|" .env
  echo "==> sized for $cap concurrent sessions (${cores} cores, ${ram_gb} GB RAM)"
fi

chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

if [[ ! -d /run/systemd/system ]]; then
  cat <<MSG

!! This host is not running systemd, so there is no service manager to install into.
   Everything else is built and configured. Start it by hand with:

     cd $INSTALL_DIR
     set -a; . ./.env; set +a
     STATIC_DIR=$INSTALL_DIR/web/dist node server/dist/index.js

   Then put it behind a process supervisor of your choice.

MSG
  exit 0
fi

echo "==> installing service"
sed "s|/opt/driftwood|$INSTALL_DIR|g; s|^User=.*|User=$SERVICE_USER|; s|^Group=.*|Group=$SERVICE_USER|" \
  deploy/driftwood.service > /etc/systemd/system/driftwood.service
systemctl daemon-reload
systemctl enable --now driftwood

sleep 3
if systemctl is-active --quiet driftwood; then
  echo
  echo "Running on http://$(hostname -I | awk '{print $1}'):8080"
  echo "  logs:    journalctl -u driftwood -f"
  echo "  config:  $INSTALL_DIR/.env  (then: systemctl restart driftwood)"
  echo "  TLS:     see deploy/README.md"
else
  echo "!! service failed to start; check: journalctl -u driftwood -n 50"
  exit 1
fi
