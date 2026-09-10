/**
 * Where the gateway lives. Same origin when the app is served by the gateway itself;
 * a configurable absolute URL when the front-end is hosted separately (GitHub Pages,
 * Netlify, an object store) and the browser backend runs on someone's own machine.
 */
const STORAGE_KEY = 'driftwood.apiBase';
const buildTimeBase = (import.meta.env.VITE_API_BASE as string | undefined)?.trim() || '';

const normalize = (value: string): string => value.trim().replace(/\/+$/, '');

export function getApiBase(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return normalize(stored);
  } catch {
    /* private mode, storage disabled — fall through */
  }
  return normalize(buildTimeBase);
}

export function setApiBase(value: string): void {
  const next = normalize(value);
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing we can do; the value still applies for this page load */
  }
}

/** True when the app is served by the gateway, so no configuration is needed. */
export const isSameOrigin = (): boolean => getApiBase() === '';

export const apiUrl = (path: string): string => `${getApiBase()}${path}`;

export function wsUrl(wsPath: string): string {
  const base = getApiBase();
  if (!base) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}${wsPath}`;
  }
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  // wsPath already carries its own query string.
  return `${url.origin}${wsPath}`;
}
