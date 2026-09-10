// In-container control agent. Gives the orchestrator a tiny HTTP surface for
// driving the session's Chromium (navigate, history, reload, clipboard) via the
// DevTools protocol. Bound to the container network only; never published.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';

const PORT = Number(process.env.AGENT_PORT || 6070);
const CDP = 'http://127.0.0.1:9222';
const BLOCKED_SCHEMES = new Set(['file:', 'chrome:', 'devtools:', 'view-source:', 'javascript:', 'data:']);

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

async function pageTarget() {
  const res = await fetch(`${CDP}/json/list`);
  if (!res.ok) throw new Error(`devtools list failed: ${res.status}`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target available');
  return page;
}

// One short-lived CDP connection per command. Navigations are rare enough that
// pooling would add more failure modes than it saves.
function cdp(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`${method} timed out`));
    }, 10_000);

    const done = (err, value) => {
      clearTimeout(timer);
      try { ws.close(); } catch {}
      err ? reject(err) : resolve(value);
    };

    ws.addEventListener('open', () => ws.send(JSON.stringify({ id, method, params })));
    ws.addEventListener('error', () => done(new Error(`${method} socket error`)));
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id !== id) return;
      if (msg.error) return done(new Error(msg.error.message || `${method} failed`));
      done(null, msg.result ?? {});
    });
  });
}

function normalizeUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('url is required');

  // Bare words and bare hostnames behave like a real address bar: search or resolve.
  const looksLikeHost = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(raw);
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : looksLikeHost ? `https://${raw}` : null;
  if (!candidate) return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;

  let url;
  try { url = new URL(candidate); } catch { throw new Error('invalid url'); }
  if (BLOCKED_SCHEMES.has(url.protocol)) throw new Error(`scheme ${url.protocol} is not allowed`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https are allowed');
  return url.toString();
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid json body'); }
}

const setClipboard = (text) =>
  new Promise((resolve, reject) => {
    const child = execFile('xclip', ['-selection', 'clipboard'], (err) => (err ? reject(err) : resolve()));
    child.stdin.end(text);
  });

const routes = {
  'GET /healthz': async () => {
    await pageTarget();
    return { ok: true };
  },
  'GET /state': async () => {
    const page = await pageTarget();
    return { url: page.url, title: page.title };
  },
  'POST /navigate': async (body) => {
    const url = normalizeUrl(body.url);
    const page = await pageTarget();
    await cdp(page.webSocketDebuggerUrl, 'Page.navigate', { url });
    return { ok: true, url };
  },
  'POST /reload': async () => {
    const page = await pageTarget();
    await cdp(page.webSocketDebuggerUrl, 'Page.reload', {});
    return { ok: true };
  },
  'POST /back': (body) => history(-1),
  'POST /forward': (body) => history(1),
  'POST /clipboard': async (body) => {
    const text = String(body.text ?? '');
    if (text.length > 100_000) throw new Error('clipboard payload too large');
    await setClipboard(text);
    return { ok: true, length: text.length };
  },
};

async function history(delta) {
  const page = await pageTarget();
  const { currentIndex, entries } = await cdp(page.webSocketDebuggerUrl, 'Page.getNavigationHistory', {});
  const target = entries[currentIndex + delta];
  if (!target) return { ok: false, reason: 'no such history entry' };
  await cdp(page.webSocketDebuggerUrl, 'Page.navigateToHistoryEntry', { entryId: target.id });
  return { ok: true, url: target.url };
}

createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  const handler = routes[`${req.method} ${path}`];
  if (!handler) return json(res, 404, { error: 'not found' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    json(res, 200, await handler(body));
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : 'agent error' });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`[agent] listening on ${PORT}`));
