# Deploying

The stack needs one thing free hosting tiers do not give you: a Docker daemon it can talk
to, plus about a gigabyte of RAM per concurrent session. A small VPS is the realistic
minimum.

## 1. One command on a fresh Debian/Ubuntu host

```bash
curl -fsSL https://raw.githubusercontent.com/Fadi-yt1/browser/main/scripts/deploy-vps.sh | sudo bash
```

It installs Docker, clones the repo to `/opt/browser-in-browser`, generates a
`SESSION_SECRET`, sizes `MAX_CONCURRENT_SESSIONS` from the machine's cores and RAM, applies
the egress rules, builds both images and starts the gateway on port 8080.

## 2. TLS and a domain

The clipboard API and fullscreen need a secure context, so run it behind HTTPS in
production. With Caddy, certificates are automatic:

```bash
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo sed -i 's/browser.example.com/your-domain.tld/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Then bind the gateway to loopback only, so the internet reaches it through Caddy:

```bash
echo 'BIND_ADDR=127.0.0.1' >> .env
docker compose up -d gateway
```

Behind nginx instead, the only unusual requirement is WebSocket upgrade plus a long read
timeout on `/ws/`:

```nginx
location /ws/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_buffering off;
}
```

## 3. Sizing

A session is one Chromium with its own X server. Measured at rest it is ~450 MB; a few
heavy tabs take it past a gigabyte, which is why `SESSION_MEMORY_MB` defaults to 1024 —
the container gets killed instead of the host swapping.

| Host | Sessions | Notes |
|------|----------|-------|
| 2 GB / 1 core | 1 | Fine for personal use |
| 4 GB / 2 cores | 2–3 | A small public instance |
| 8 GB / 4 cores | 4–6 | Comfortable |
| 16 GB / 8 cores | 8–12 | Add bandwidth headroom: ~0.5–2 Mbit/s per active session |

Bandwidth, not CPU, is usually what bites first on a busy public instance. Every session
streams its screen continuously while someone is scrolling.

## 4. Operating it

```bash
docker compose logs -f gateway          # structured JSON logs
curl -s localhost:8080/api/stats | jq   # capacity, queue depth
docker ps --filter label=app=browser-in-browser   # live sessions
```

Updating:

```bash
git pull
docker compose --profile images build session-image   # if browser-image/ changed
docker compose up -d --build gateway
```

Restarting the gateway ends every live session unless `SESSION_SECRET` is set — set it.
Orphaned containers from a crash are swept automatically on the next boot.

Rebuild the session image regularly. It carries a browser, and a stale browser is the one
thing in this stack that is genuinely dangerous to run in public:

```bash
docker compose --profile images build --no-cache session-image
```

## 5. Other targets

- **Any VM with Docker** — the compose stack is the whole deployment; nothing is
  provider-specific.
- **Kubernetes** — workable, but the gateway's Docker calls need replacing with a
  Kubernetes client that creates a Pod per session, and the bridge then dials the Pod IP.
  The session manager is the only file that has to change.
- **PaaS free tiers (Render, Railway, Fly, Koyeb)** — do not use them for this. They give
  you no Docker daemon and not enough memory. Static hosting for `web/` is possible if the
  gateway lives elsewhere, but that just splits the same bill.

Read [HARDENING.md](HARDENING.md) before pointing a public domain at it.
