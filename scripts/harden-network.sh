#!/usr/bin/env bash
# Blocks session containers from reaching private address space, so a visitor
# cannot browse to the host's LAN, other services, or the cloud metadata API.
# Safe to re-run: existing rules are removed first.
set -euo pipefail

SUBNET="${SESSION_SUBNET:-172.31.240.0/22}"
CHAIN="BIB-EGRESS"

command -v iptables >/dev/null 2>&1 || { echo "iptables not found"; exit 1; }
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }

# Rebuild the chain from scratch.
iptables -D DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN" 2>/dev/null || iptables -N "$CHAIN"

# Cloud instance metadata first: it is the highest-value target on a VPS.
iptables -A "$CHAIN" -d 169.254.0.0/16 -j REJECT --reject-with icmp-admin-prohibited

for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 100.64.0.0/10; do
  iptables -A "$CHAIN" -d "$net" -j REJECT --reject-with icmp-admin-prohibited
done

# Everything else — the public internet — is allowed through.
iptables -A "$CHAIN" -j RETURN
iptables -I DOCKER-USER 1 -s "$SUBNET" -j "$CHAIN"

echo "==> egress rules applied for $SUBNET"
echo "    Persist them with iptables-persistent (netfilter-persistent save)."
