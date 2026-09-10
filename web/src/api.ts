export interface PublicSession {
  id: string;
  state: 'starting' | 'ready' | 'closing';
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  width: number;
  height: number;
  startUrl: string;
  vncPassword: string;
}

export interface LaunchResult {
  kind: 'session' | 'queued';
  session?: PublicSession;
  token?: string;
  wsPath?: string;
  ticket?: string;
  position?: number;
  message?: string;
}

export interface Stats {
  active: number;
  capacity: number;
  free: number;
  queued: number;
  unlimited: boolean;
  sessionTtlMs: number;
}

import { apiUrl, wsUrl } from './backend';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

const request = async <T>(path: string, init?: RequestInit & { token?: string }): Promise<T> => {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.token ? { 'x-session-token': init.token } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  // Anything that is not JSON means we are not talking to a gateway: a provider
  // landing page, a proxy error, a captive portal. Swallowing it produced a page
  // that rendered "undefined" instead of saying the address was wrong.
  const text = await res.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(
        `That address answered with ${res.status} but did not return gateway data. Check it points at a Driftwood gateway.`,
        res.status,
      );
    }
  }

  if (!res.ok && res.status !== 202) {
    throw new ApiError((body as { error?: string }).error || `Request failed (${res.status})`, res.status);
  }
  return body as T;
};

export async function launchSession(opts: {
  width: number;
  height: number;
  url?: string;
  ticket?: string;
}): Promise<LaunchResult> {
  const res = await fetch(apiUrl('/api/sessions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const body = await res.json().catch(() => ({}));

  if (res.status === 201) {
    const ok = body as { session: PublicSession; token: string; wsPath: string };
    return { kind: 'session', ...ok };
  }
  if (res.status === 202) {
    const queued = body as { ticket: string; position: number; message: string };
    return { kind: 'queued', ...queued };
  }
  throw new ApiError((body as { error?: string }).error || `Could not start a session (${res.status})`, res.status);
}

export const pollQueue = (ticket: string) =>
  request<{ ticket: string; position: number; ready: boolean }>(`/api/queue/${ticket}`);

/** Shape check: a 200 from something that is not a gateway must not reach the UI. */
const looksLikeStats = (value: unknown): value is Stats =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Stats).capacity === 'number' &&
  typeof (value as Stats).active === 'number' &&
  typeof (value as Stats).queued === 'number';

export const getStats = async (): Promise<Stats> => {
  const body = await request<unknown>('/api/stats');
  if (!looksLikeStats(body)) {
    throw new ApiError('That address answered, but it is not a Driftwood gateway.', 200);
  }
  return body;
};

export const heartbeat = (id: string, token: string) =>
  request<{ session: PublicSession }>(`/api/sessions/${id}/heartbeat`, { method: 'POST', token });

export const extendSession = (id: string, token: string) =>
  request<{ session: PublicSession }>(`/api/sessions/${id}/extend`, { method: 'POST', token });

export const endSession = (id: string, token: string) =>
  request<void>(`/api/sessions/${id}`, { method: 'DELETE', token });

export const navigate = (id: string, token: string, url: string) =>
  request<{ ok: boolean; url?: string }>(`/api/sessions/${id}/navigate`, {
    method: 'POST',
    token,
    body: JSON.stringify({ url }),
  });

export const control = (id: string, token: string, action: 'back' | 'forward' | 'reload') =>
  request<{ ok: boolean }>(`/api/sessions/${id}/${action}`, { method: 'POST', token, body: '{}' });

export const pushClipboard = (id: string, token: string, text: string) =>
  request<{ ok: boolean }>(`/api/sessions/${id}/clipboard`, {
    method: 'POST',
    token,
    body: JSON.stringify({ text }),
  });

export const getPageState = (id: string, token: string) =>
  request<{ url?: string; title?: string }>(`/api/sessions/${id}/state`, { token });

/** Beacon-style teardown so a closing tab still releases its container. */
export const releaseOnUnload = (id: string, token: string): void => {
  const blob = new Blob([JSON.stringify({ token })], { type: 'application/json' });
  navigator.sendBeacon(apiUrl(`/api/sessions/${id}/heartbeat?token=${token}&bye=1`), blob);
  void fetch(apiUrl(`/api/sessions/${id}?token=${token}`), { method: 'DELETE', keepalive: true }).catch(() => {});
};

export const websocketUrl = wsUrl;
