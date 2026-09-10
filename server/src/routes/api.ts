import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config.js';
import { clientKey } from '../lib/client.js';
import { log } from '../lib/log.js';
import { RateLimiter } from '../lib/ratelimit.js';
import { runtime } from '../lib/runtime.js';
import {
  CapacityError,
  LimitError,
  sessionManager,
  toPublicSession,
  type Session,
} from '../lib/sessions.js';
import { verifySessionToken } from '../lib/tokens.js';

const launchLimiter = new RateLimiter(
  Number(process.env.LAUNCH_RATE_LIMIT || 10),
  Number(process.env.LAUNCH_RATE_WINDOW_MS || 60_000),
);
const controlLimiter = new RateLimiter(
  Number(process.env.CONTROL_RATE_LIMIT || 240),
  Number(process.env.CONTROL_RATE_WINDOW_MS || 60_000),
);

interface AuthedRequest extends Request {
  session?: Session;
}

const requireSession = (req: AuthedRequest, res: Response, next: NextFunction) => {
  const id = req.params.id as string;
  const token = req.get('x-session-token') || (req.query.token as string | undefined);
  const session = sessionManager.get(id);
  if (!session || !verifySessionToken(id, token)) {
    return res.status(404).json({ error: 'Session not found or no longer running.' });
  }
  sessionManager.touch(id);
  req.session = session;
  next();
};

/** Proxies a control command to the session's in-container agent. */
async function callAgent(
  session: Session,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  if (!session.agentBase) return { status: 409, body: { error: 'Session is still starting.' } };
  try {
    const res = await fetch(`${session.agentBase}${path}`, {
      method: init?.method || 'GET',
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(12_000),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (err) {
    log.warn('agent call failed', { sessionId: session.id, path, err: String(err) });
    return { status: 502, body: { error: 'The browser session did not respond.' } };
  }
}

export const api = Router();

api.get('/health', async (_req, res) => {
  const ready = await runtime.ping();
  res.status(ready ? 200 : 503).json({ ok: ready, runtime: runtime.name, ...sessionManager.stats() });
});

api.get('/stats', (_req, res) => {
  const stats = sessionManager.stats();
  res.json({
    ...stats,
    free: Math.max(0, stats.capacity - stats.active),
    idleTimeoutMs: config.idleTimeoutMs,
    screen: { width: config.screen.width, height: config.screen.height },
  });
});

api.post('/sessions', async (req: Request, res: Response) => {
  const key = clientKey(req);
  const gate = launchLimiter.check(key);
  if (!gate.allowed) {
    res.set('retry-after', String(gate.retryAfterSec));
    return res.status(429).json({ error: 'Too many launches. Give it a moment.', retryAfterSec: gate.retryAfterSec });
  }

  const body = (req.body ?? {}) as { width?: number; height?: number; url?: string; ticket?: string };

  try {
    const session = await sessionManager.create({
      clientKey: key,
      width: Number(body.width) || config.screen.width,
      height: Number(body.height) || config.screen.height,
      startUrl: typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined,
      ticketId: typeof body.ticket === 'string' ? body.ticket : undefined,
    });
    return res.status(201).json({
      session: toPublicSession(session),
      token: session.token,
      wsPath: `/ws/session/${session.id}?token=${session.token}`,
    });
  } catch (err) {
    if (err instanceof CapacityError) {
      return res.status(202).json({
        queued: true,
        ticket: err.ticket.id,
        position: err.position,
        pollAfterMs: 2_000,
        message: 'All browsers are busy. You are in line — this page will start yours automatically.',
      });
    }
    if (err instanceof LimitError) return res.status(429).json({ error: err.message });
    log.error('session launch failed', { err: String(err) });
    return res.status(500).json({ error: 'Could not start a browser. Please try again.' });
  }
});

api.get('/queue/:ticketId', (req, res) => {
  const result = sessionManager.poll(req.params.ticketId as string);
  if (!result) return res.status(404).json({ error: 'This place in line expired. Request a new session.' });
  res.json({
    ticket: result.ticket.id,
    position: result.position,
    ready: result.ticket.claimableUntil > Date.now(),
    pollAfterMs: 2_000,
  });
});

api.get('/sessions/:id', requireSession, (req: AuthedRequest, res) => {
  res.json({ session: toPublicSession(req.session!) });
});

api.post('/sessions/:id/heartbeat', requireSession, (req: AuthedRequest, res) => {
  res.json({ session: toPublicSession(req.session!) });
});

api.post('/sessions/:id/extend', requireSession, (req: AuthedRequest, res) => {
  const session = sessionManager.extend(req.session!.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  res.json({ session: toPublicSession(session) });
});

api.delete('/sessions/:id', requireSession, async (req: AuthedRequest, res) => {
  await sessionManager.close(req.session!.id, 'closed by user');
  res.status(204).end();
});

api.get('/sessions/:id/state', requireSession, async (req: AuthedRequest, res) => {
  const result = await callAgent(req.session!, '/state');
  res.status(result.status).json(result.body);
});

for (const action of ['navigate', 'reload', 'back', 'forward', 'clipboard'] as const) {
  api.post(`/sessions/:id/${action}`, requireSession, async (req: AuthedRequest, res) => {
    const gate = controlLimiter.check(req.session!.id);
    if (!gate.allowed) return res.status(429).json({ error: 'Slow down a little.' });
    const result = await callAgent(req.session!, `/${action}`, { method: 'POST', body: req.body ?? {} });
    res.status(result.status).json(result.body);
  });
}
