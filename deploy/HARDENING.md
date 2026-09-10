# Hardening

Running this in public means running an open browser for strangers. This page is the list
of things to decide before you do.

## Choose the Docker runtime

`SESSION_RUNTIME=local` runs sessions as ordinary processes beside the gateway: same
kernel, same filesystem, same network namespace, no resource caps. A browser exploit in a
local-runtime session is a host compromise, with nothing in between. It is there for
development and for single-user machines.

Everything below assumes `SESSION_RUNTIME=docker`, the default.

## The four real risks

### 1. The gateway holds the Docker socket

`docker.sock` is root on the host. Anything that achieves code execution in the gateway
process owns the machine.

- Give the stack a **dedicated host**. Nothing else of value should live there.
- Do not put your own data, keys, or other services on that box.
- Consider a socket proxy (e.g. Tecnativa's `docker-socket-proxy`) restricted to
  container create/start/remove/inspect, so the gateway cannot read images, exec into
  containers, or bind-mount host paths.

### 2. Chromium runs with `--no-sandbox`

Chromium's own sandbox needs privileges that would weaken the container more than they
help, so the container is the boundary instead: unprivileged user, `CapDrop: ALL`,
`no-new-privileges`, PID and memory caps, `noexec` tmpfs, no host mounts.

The consequence: **a browser exploit gets container-level access**, and only the container
boundary stops it there. So:

- Rebuild the session image on a schedule — a browser weeks behind on security releases is
  the weakest part of this system.
- Consider a stricter runtime (gVisor, `runsc`) as the container runtime for session
  containers on a serious deployment.
- Add a seccomp profile if you have one you trust; the Docker default already applies.

### 3. Sessions can reach your private network

By default a container can talk to anything the host can — your LAN, other services on the
box, and on a cloud VPS the metadata endpoint at 169.254.169.254 that hands out
credentials.

```bash
sudo ./scripts/harden-network.sh          # blocks 169.254/16, RFC1918, loopback, CGNAT
sudo apt install -y iptables-persistent   # keep the rules across reboots
sudo netfilter-persistent save
```

Verify it from inside a live session by trying to open `http://169.254.169.254/` — it
should fail, not return metadata.

### 4. You are running an open proxy

Traffic from your IP is traffic strangers asked for. Expect abuse complaints eventually.

- Keep `MAX_SESSIONS_PER_CLIENT` and the launch rate limits on.
- Decide your logging position *before* launch. The gateway logs session lifecycle events
  and hashed client keys — not browsing history. That is a deliberate privacy choice; it
  also means you cannot answer "who visited X" when someone asks. If your jurisdiction
  requires you to be able to, set `LOG_LEVEL=debug` and keep the URLs from the navigate
  endpoint, and say so on the site.
- Block domains you do not want proxied by pointing `SESSION_DNS` at a filtering resolver
  (for example a Pi-hole or a blocklist-backed DNS service). It is the simplest lever, and
  it applies to the whole session, not just the URL bar.
- Put Cloudflare or another WAF in front if the instance gets popular.

## Recommended configuration for a public instance

```bash
UNLIMITED_MODE=false          # keep the spirit, cap the abuse
SESSION_TTL_MS=1200000        # 20 minutes, extendable for free from the toolbar
MAX_SESSIONS_PER_CLIENT=1
IDLE_TIMEOUT_MS=60000
LAUNCH_RATE_LIMIT=5
SESSION_MEMORY_MB=1024
SESSION_CPUS=1
```

Unlimited mode is the right default for a private or small instance. On a public one, a
generous TTL with free one-click extension gives honest visitors the same experience while
keeping a script from parking twenty browsers forever.

## What this stack deliberately does not do

- **No persistence.** No user accounts, no saved profiles, no history. A session is a
  fresh machine every time; there is nothing to breach.
- **No recording.** Frames are relayed, never stored.
- **No raw IP storage.** Client identity is an HMAC of the IP with the server secret, held
  in memory only.

If you add any of those, revisit this page — most of the reasoning above changes.

## Checklist before going public

- [ ] Dedicated host, nothing else on it
- [ ] `SESSION_SECRET` set to a real random value
- [ ] `scripts/harden-network.sh` applied and persisted
- [ ] Metadata endpoint verified unreachable from inside a session
- [ ] TLS terminating in front, gateway bound to `127.0.0.1`
- [ ] Capacity sized to actual RAM, not optimism
- [ ] A rebuild schedule for the session image
- [ ] A stated position on logging and acceptable use on the site itself
