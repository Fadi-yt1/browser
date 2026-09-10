# Driftwood — a browser inside your browser

A self-hostable **remote browser isolation** platform. A visitor presses one button, a
disposable Chromium starts in a locked-down container on your server, and its screen is
streamed into their tab over a single WebSocket. Clicks and keystrokes go back the same
way. When the tab closes, the container is destroyed.

No accounts, no payment, no feature flags — the only limit is how many browsers the host
can run at once, and that one is enforced with a fair queue instead of a paywall.

```
visitor's tab ──WebSocket──▶ gateway ──TCP/RFB──▶ session container
   noVNC canvas             (Node/Express)        Xvfb + openbox + Chromium
   REST controls        session manager + queue    x11vnc + control agent
                        Docker API (spawn/reap)
```

## Two ways to run a session

| Runtime | What it does | Use it when |
|---------|--------------|-------------|
| `docker` (default) | One hardened container per session — dropped capabilities, memory and PID caps, private network | Anything public. This is the isolation boundary. |
| `local` | Sessions are plain processes on the host: their own X display, Chromium profile and VNC server, no Docker | A machine you own, or development. **No isolation from the host.** |

Switch with `SESSION_RUNTIME=docker|local`. Everything above the runtime — queue, session
manager, streaming, UI — is identical.

## Quick start

**With Docker** (recommended, isolated):

```bash
git clone https://github.com/Fadi-yt1/browser.git
cd browser
cp .env.example .env                       # optional; every value has a default
docker compose --profile images build      # build the session browser image
docker compose up -d --build gateway       # start the gateway
```

**Without Docker** (a VPS, or your laptop):

```bash
sudo apt install -y xvfb x11vnc openbox xdotool xclip x11-utils chromium
(cd server && npm install && npm run build)
(cd web && npm install && npm run build)
SESSION_RUNTIME=local SESSION_SECRET=$(openssl rand -hex 32) \
  STATIC_DIR=$PWD/web/dist node server/dist/index.js
```

Either way, open <http://localhost:8080>. For a real domain with TLS, a one-command VPS
install, or prebuilt images, see [deploy/README.md](deploy/README.md).

### Development

```bash
./scripts/dev.sh     # gateway on :8080 with hot reload, Vite app on :5173
```

In dev the Docker runtime publishes session ports on `127.0.0.1` instead of using a shared
network. Nothing else changes.

## How a session works

1. `POST /api/sessions` — the manager checks capacity and per-visitor limits, then starts
   a container from `browser-in-browser/session`.
2. The container boots `Xvfb` → `openbox` → Chromium → `x11vnc` → a small control agent.
   The gateway polls the agent until Chromium answers, then marks the session ready.
3. The client connects to `/ws/session/:id?token=…`. The gateway verifies the token and
   pipes that socket to the container's RFB port — the job websockify usually does, done
   in-process so **session containers publish no ports at all**.
4. Heartbeats keep the session alive. Miss them for `IDLE_TIMEOUT_MS` and it is reaped;
   the same happens on TTL expiry, on tab close, and on gateway restart.

The URL bar in the toolbar drives the remote Chromium through the DevTools protocol, so
navigation, history and reload work without the visitor hunting for the remote window's
own chrome.

## Capacity, honestly

Each session is a real browser: budget roughly **1 CPU core and 1.2 GB of RAM** for one.
That is the whole reason a service like this normally sells subscriptions.

| Host | Sensible `MAX_CONCURRENT_SESSIONS` |
|------|-----------------------------------|
| 2 GB / 1 core VPS | 1 |
| 4 GB / 2 cores | 2–3 |
| 8 GB / 4 cores | 4–6 |
| 16 GB / 8 cores | 8–12 |

Free unlimited *use* is a policy you set here — no time cap, several sessions per visitor,
extend as often as you like. Free unlimited *capacity* is not something software can grant:
past the cap, visitors wait in line. Raise the cap by adding hardware, not by editing the
number past what the box can carry (an oversubscribed host swaps, and every session gets
unusable at once).

> **Free-tier PaaS hosts (Render, Fly, Railway, Koyeb…) will not run this.** A session is a
> real X server and browser, needing roughly a gigabyte of RAM and, for the Docker runtime,
> a daemon it can talk to. The cheapest thing that actually works is a small VPS — see
> [deploy/README.md](deploy/README.md). The `local` runtime lowers the bar (no Docker
> needed), but not the memory.

## Configuration

All settings are environment variables; see [.env.example](.env.example) for the annotated
list. The ones worth knowing:

| Variable | Default | What it does |
|----------|---------|--------------|
| `MAX_CONCURRENT_SESSIONS` | `4` | Hard capacity. Everything past it queues. |
| `UNLIMITED_MODE` | `true` | No TTL, several sessions per visitor. |
| `SESSION_TTL_MS` | `0` | Per-session time cap; `0` disables it. |
| `IDLE_TIMEOUT_MS` | `90000` | Reap a session whose tab stopped answering. |
| `MAX_SESSIONS_PER_CLIENT` | `3` | Concurrent sessions per visitor. |
| `SESSION_MEMORY_MB` / `SESSION_CPUS` | `1024` / `1` | Per-container limits. |
| `SESSION_SECRET` | random per boot | Signs session tokens. Set it, or a restart invalidates live sessions. |
| `BROWSER_NETWORK` | `browser-sessions` | Private network for containers. Unset ⇒ publish on loopback. |
| `SESSION_RUNTIME` | `docker` | `docker` for isolated containers, `local` for host processes. |

## Security posture

What is already done:

- Containers run as an unprivileged user with **all capabilities dropped**,
  `no-new-privileges`, a PID cap, memory/CPU limits, and a `noexec` tmpfs.
- Session containers **publish no ports**; the gateway is the only route in.
- Session tokens are HMACs — every REST call and the WebSocket upgrade are checked.
- Visitor IPs are HMAC-hashed for rate limiting, never stored raw.
- `scripts/harden-network.sh` blocks containers from reaching private ranges and the
  cloud metadata endpoint (169.254.169.254). **Run it on any public deployment.**

The `local` runtime has **none of the container protections above** — sessions share the
host with the gateway. It exists for machines you control; do not point it at the public
internet.

What you must decide before opening it to the world — read
[deploy/HARDENING.md](deploy/HARDENING.md):

- The gateway holds the Docker socket, which is root-equivalent on the host. Give it a
  dedicated machine.
- Chromium runs with `--no-sandbox` (the container is the boundary). Keep the image
  patched; rebuild it on a schedule.
- You are running an open proxy for anyone who finds it. Expect abuse reports, and decide
  on domain blocking, logging and rate limits accordingly.

## Repository layout

| Path | What lives there |
|------|------------------|
| `server/` | Gateway: session manager, queue, both runtimes, VNC↔WebSocket bridge, REST API |
| `web/` | React client: landing page, noVNC viewer, toolbar |
| `browser-image/` | The session container: X, window manager, Chromium, VNC, control agent |
| `deploy/` | TLS, VPS sizing, hardening notes |
| `scripts/` | Dev runner, image builds, one-shot VPS install, egress rules |

## API

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/sessions` | Start a session, or get a queue ticket (`202`) |
| `GET` | `/api/queue/:ticket` | Position in line; `ready` when a slot is reserved |
| `POST` | `/api/sessions/:id/heartbeat` | Keep alive |
| `POST` | `/api/sessions/:id/extend` | Reset the TTL |
| `POST` | `/api/sessions/:id/navigate` | Drive the remote address bar |
| `POST` | `/api/sessions/:id/{back,forward,reload,clipboard}` | Remote controls |
| `DELETE` | `/api/sessions/:id` | Destroy it now |
| `GET` | `/api/stats` · `/api/health` | Capacity and liveness |
| `WS` | `/ws/session/:id?token=…` | The RFB stream |

All session routes require the token from the launch response, via `x-session-token`.

## Licence

MIT — see [LICENSE](LICENSE).
