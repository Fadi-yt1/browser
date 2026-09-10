# Deploying

Every session is a real X server and browser, so plan on about a gigabyte of RAM each.
That is the floor no configuration gets you under, and it is why free PaaS tiers cannot
host this. A small VPS is the realistic minimum.

Pick one of the three paths below.

## 1. Docker, one command on a fresh Debian/Ubuntu host  *(recommended)*

```bash
curl -fsSL https://raw.githubusercontent.com/Fadi-yt1/browser/main/scripts/deploy-vps.sh | sudo bash
```

It installs Docker, clones the repo to `/opt/browser-in-browser`, generates a
`SESSION_SECRET`, sizes `MAX_CONCURRENT_SESSIONS` from the machine's cores and RAM, applies
the egress rules, builds both images and starts the gateway on port 8080.

## 1b. Prebuilt images, no build step

Every push to `main` publishes both images to GHCR, so a host with Docker needs no
checkout:

```bash
docker network create browser-sessions
docker run -d --name driftwood \
  -p 8080:8080 \
  --network browser-sessions \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e BROWSER_IMAGE=ghcr.io/fadi-yt1/driftwood-session:latest \
  -e BROWSER_NETWORK=browser-sessions \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e MAX_CONCURRENT_SESSIONS=4 \
  ghcr.io/fadi-yt1/driftwood-gateway:latest
```

## 1c. No Docker at all

For a host where Docker is unavailable or unwanted, the `local` runtime runs sessions as
plain processes under a systemd service:

```bash
curl -fsSL https://raw.githubusercontent.com/Fadi-yt1/browser/main/scripts/install-local.sh | sudo bash
```

It installs Xvfb, x11vnc, openbox and Chromium, builds the app into `/opt/driftwood`,
creates a `driftwood` service user and starts `driftwood.service` on port 8080.

**This runtime gives sessions no isolation from the host.** Use it on a machine you own
and control, not for a public instance. See [HARDENING.md](HARDENING.md).

## 1d. Split hosting: free static front-end + your own backend

The React client can live anywhere static hosting is free (GitHub Pages, Netlify,
Cloudflare Pages, an object store) and talk to a gateway running elsewhere. Only the part
that actually needs memory — the browser sessions — has to be on a real machine.

- `.github/workflows/pages.yml` builds `web/` and publishes it to GitHub Pages on every
  push to `main`. Enable Pages for the repository (Settings → Pages → Source: GitHub
  Actions) and it runs itself.
- Set the repository variable `API_BASE` to your gateway's public URL to bake it in.
  Without it, the page asks each visitor for a gateway address and remembers it in their
  browser's local storage.
- The gateway already sends permissive CORS headers, so a cross-origin front-end works as
  it is. Narrow `CORS_ORIGIN` to your front-end's origin once you know it.

A front-end deployed this way shows a "point this page at your server" panel until a
gateway answers, and disables the launch button — it never pretends to be a working
service with nothing behind it.

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
