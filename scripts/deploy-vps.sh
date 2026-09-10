#!/usr/bin/env bash
# One-shot install on a fresh Debian/Ubuntu host.
#   curl -fsSL https://raw.githubusercontent.com/Fadi-yt1/browser/main/scripts/deploy-vps.sh | bash
# Or, from a clone:  sudo ./scripts/deploy-vps.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Fadi-yt1/browser.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/browser-in-browser}"

require_root() { [[ $EUID -eq 0 ]] || { echo "Run this as root (sudo)."; exit 1; }; }
require_root

echo "==> installing prerequisites"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git

if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "==> updating existing checkout"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "==> cloning into $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
if [[ ! -f .env ]]; then
  cp .env.example .env
  # A stable secret keeps sessions alive across restarts.
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" .env
  # Size capacity from the machine: ~1.2 GB per session, one per core.
  cores=$(nproc)
  ram_gb=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1024 / 1024 ))
  cap=$(( ram_gb * 10 / 12 ))
  (( cap > cores )) && cap=$cores
  (( cap < 1 )) && cap=1
  sed -i "s|^MAX_CONCURRENT_SESSIONS=.*|MAX_CONCURRENT_SESSIONS=$cap|" .env
  echo "==> sized this host for $cap concurrent sessions (${cores} cores, ${ram_gb} GB RAM)"
fi

echo "==> building images (this takes a few minutes the first time)"
docker compose --profile images build session-image
docker compose build gateway

echo "==> applying session network egress rules"
./scripts/harden-network.sh || echo "!! egress hardening skipped; see deploy/HARDENING.md"

echo "==> starting"
docker compose up -d gateway

cat <<'DONE'

Up and running on port 8080.

Next steps:
  * Put TLS in front of it — see deploy/README.md for the Caddy one-liner.
  * Tune capacity in .env, then: docker compose up -d gateway
  * Logs: docker compose logs -f gateway
DONE
