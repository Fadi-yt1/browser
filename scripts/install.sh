#!/usr/bin/env bash
# One command for any Debian/Ubuntu host, including small free VPS boxes.
#
#   curl -fsSL https://raw.githubusercontent.com/Fadi-yt1/browser/main/scripts/install.sh | sudo bash
#
# It works out what the machine can actually do — whether Docker runs at all
# (many cheap VPS plans are OpenVZ/LXC containers where it does not), how much
# memory there is to spend, whether swap is needed — then installs the matching
# runtime, sizes capacity honestly, and starts the service.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Fadi-yt1/browser.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/driftwood}"
FORCE_RUNTIME="${SESSION_RUNTIME:-}"
REPO_BRANCH="${REPO_BRANCH:-main}"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m !! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m !! %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root:  curl -fsSL <url> | sudo bash"
command -v apt-get >/dev/null 2>&1 || die "This installer supports Debian and Ubuntu."

say "inspecting the machine"
CORES=$(nproc)
RAM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo)
VIRT=$(systemd-detect-virt 2>/dev/null || echo unknown)
echo "    cores: $CORES   RAM: ${RAM_MB} MB   swap: ${SWAP_MB} MB   virtualisation: $VIRT"

(( RAM_MB >= 700 )) || die "Only ${RAM_MB} MB of RAM. One browser session needs ~700 MB; this host cannot run one."

apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl >/dev/null

# --- swap ------------------------------------------------------------------
# A 1 GB box with no swap kills Chromium the moment a heavy page loads.
if (( RAM_MB < 2048 && SWAP_MB < 512 )); then
  if is_container; then
    warn "low memory and no swap, and this container type cannot add any — expect one session at a time"
  else
    say "adding 2 GB of swap (small host, no swap present)"
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi

# --- runtime decision ------------------------------------------------------
docker_works() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

# Container-style virtualisation, where a nested Docker daemon usually cannot start.
# Checked only as a fallback: a working daemon is always preferred when one exists.
is_container() {
  case "$VIRT" in
    openvz|lxc|lxc-libvirt|docker|podman|systemd-nspawn|rkt|wsl) return 0 ;;
    *) return 1 ;;
  esac
}

RUNTIME=""
if [[ -n "$FORCE_RUNTIME" ]]; then
  RUNTIME="$FORCE_RUNTIME"
  say "runtime forced to '$RUNTIME'"
elif docker_works; then
  RUNTIME=docker
  say "Docker is already working — using container isolation"
elif is_container; then
  RUNTIME=local
  say "this is a $VIRT container, where Docker generally cannot run — using the local runtime"
else
  say "trying to install Docker"
  if curl -fsSL https://get.docker.com | sh >/dev/null 2>&1 && docker_works; then
    RUNTIME=docker
    echo "    Docker installed and working"
  else
    RUNTIME=local
    warn "Docker could not be installed or started here — falling back to the local runtime"
  fi
fi

if [[ "$RUNTIME" == "local" ]]; then
  warn "The local runtime gives sessions NO isolation from this host."
  warn "Fine for a box you own; read deploy/HARDENING.md before opening it to strangers."
fi

# --- checkout --------------------------------------------------------------
say "fetching the source into $INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPO_BRANCH"
  git -C "$INSTALL_DIR" checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH"
else
  git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# --- sizing ----------------------------------------------------------------
# One session needs ~1 GB comfortably. Leave ~600 MB for the OS and the gateway.
usable=$(( RAM_MB - 600 ))
cap=$(( usable / 1000 )); (( cap > CORES )) && cap=$CORES; (( cap < 1 )) && cap=1

if (( RAM_MB < 1400 )); then
  session_mem=640; screen_w=1024; screen_h=768
  warn "tight memory: one session at a time, at 1024x768, with a reduced memory cap"
else
  session_mem=1024; screen_w=1280; screen_h=800
fi

if [[ ! -f .env ]]; then
  say "writing .env sized for this host ($cap concurrent session$([[ $cap -eq 1 ]] || echo s))"
  cp .env.example .env
  set_env() { grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }
  set_env SESSION_RUNTIME "$RUNTIME"
  set_env SESSION_SECRET "$(openssl rand -hex 32)"
  set_env MAX_CONCURRENT_SESSIONS "$cap"
  set_env SESSION_MEMORY_MB "$session_mem"
  set_env SCREEN_WIDTH "$screen_w"
  set_env SCREEN_HEIGHT "$screen_h"
  # A public instance on a small host should recycle sessions rather than let one park forever.
  if (( cap <= 1 )); then
    set_env UNLIMITED_MODE false
    set_env SESSION_TTL_MS 1200000
    set_env MAX_SESSIONS_PER_CLIENT 1
    warn "single-session host: sessions get 20 minutes, extendable for free from the toolbar"
  fi
else
  say "keeping the existing .env"
fi

# --- install ---------------------------------------------------------------
if [[ "$RUNTIME" == "docker" ]]; then
  say "building images (a few minutes on a small box)"
  docker compose --profile images build session-image
  docker compose build gateway
  say "applying session egress rules"
  ./scripts/harden-network.sh || warn "egress hardening skipped — see deploy/HARDENING.md"
  say "starting"
  docker compose up -d gateway
  status_cmd="docker compose -f $INSTALL_DIR/docker-compose.yml logs -f gateway"
else
  say "installing the Docker-free runtime"
  set +e
  SERVICE_USER=driftwood INSTALL_DIR="$INSTALL_DIR" REPO_BRANCH="$REPO_BRANCH" ./scripts/install-local.sh
  delegate_rc=$?
  set -e
  if (( delegate_rc == 3 )); then
    # Installed and configured, but this host has no service manager to start it.
    printf '\n\033[32m Driftwood is installed at %s.\033[0m\n' "$INSTALL_DIR"
    echo "  Nothing is running yet — start it with the command printed above."
    exit 0
  fi
  (( delegate_rc == 0 )) || die "the local runtime install failed (exit $delegate_rc)"
  status_cmd="journalctl -u driftwood -f"
fi

# --- verify ----------------------------------------------------------------
say "checking it answers"
ok=0
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8080/api/health >/dev/null; then ok=1; break; fi
  sleep 2
done

ip=$(hostname -I 2>/dev/null | awk '{print $1}')
if (( ok )); then
  health=$(curl -s http://127.0.0.1:8080/api/health)
  printf '\n\033[32m Driftwood is running.\033[0m\n\n'
  echo "  URL:      http://${ip:-<this-host>}:8080"
  echo "  Runtime:  $RUNTIME"
  echo "  Health:   $health"
  echo "  Logs:     $status_cmd"
  echo "  Config:   $INSTALL_DIR/.env"
  echo
  echo "  Next: put TLS in front of it before sharing the link — see deploy/README.md."
  [[ "$RUNTIME" == "local" ]] && echo "        And read deploy/HARDENING.md: local sessions are not isolated."
else
  die "It did not come up. Check: $status_cmd"
fi
