import crypto from 'node:crypto';

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const bool = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

const minutes = (n: number) => n * 60_000;

/**
 * "Unlimited" mode removes the per-session time cap and the one-session-per-visitor
 * rule. Concurrency is still bounded by MAX_CONCURRENT_SESSIONS, because that one is
 * physics, not policy: every session is a real browser burning real RAM and CPU.
 */
const unlimited = bool(process.env.UNLIMITED_MODE, true);

/**
 * 'docker' gives every session its own hardened container. 'local' runs sessions as
 * plain processes on this host — no isolation, so only for a machine you control.
 */
const runtime = process.env.SESSION_RUNTIME === 'local' ? 'local' : 'docker';

export const config = {
  runtime,
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',
  trustProxy: bool(process.env.TRUST_PROXY, true),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  staticDir: process.env.STATIC_DIR || '',

  unlimited,
  /** 0 disables the cap entirely. */
  sessionTtlMs: num(process.env.SESSION_TTL_MS, unlimited ? 0 : minutes(20)),
  /** A tab closed without a goodbye should not hold a container forever. */
  idleTimeoutMs: num(process.env.IDLE_TIMEOUT_MS, 90_000),
  maxConcurrentSessions: num(process.env.MAX_CONCURRENT_SESSIONS, 4),
  maxSessionsPerClient: num(process.env.MAX_SESSIONS_PER_CLIENT, unlimited ? 3 : 1),
  maxQueueLength: num(process.env.MAX_QUEUE_LENGTH, 200),
  queueTicketTtlMs: num(process.env.QUEUE_TICKET_TTL_MS, 45_000),

  docker: {
    image: process.env.BROWSER_IMAGE || 'browser-in-browser/session:latest',
    network: process.env.BROWSER_NETWORK || '',
    socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
    memoryMb: num(process.env.SESSION_MEMORY_MB, 1024),
    cpus: Number(process.env.SESSION_CPUS || 1),
    shmSizeMb: num(process.env.SESSION_SHM_MB, 512),
    pidsLimit: num(process.env.SESSION_PIDS_LIMIT, 512),
    dns: (process.env.SESSION_DNS || '1.1.1.1,1.0.0.1').split(',').map((s) => s.trim()).filter(Boolean),
    startupTimeoutMs: num(process.env.SESSION_STARTUP_TIMEOUT_MS, 45_000),
    labelKey: 'app',
    labelValue: 'browser-in-browser',
  },

  local: {
    /** Overrides for the two files the local runtime borrows from browser-image/. */
    agentPath: process.env.LOCAL_AGENT_PATH || '',
    openboxConfig: process.env.LOCAL_OPENBOX_CONFIG || '',
  },

  screen: {
    width: num(process.env.SCREEN_WIDTH, 1280),
    height: num(process.env.SCREEN_HEIGHT, 800),
    depth: num(process.env.SCREEN_DEPTH, 24),
    maxWidth: num(process.env.SCREEN_MAX_WIDTH, 1920),
    maxHeight: num(process.env.SCREEN_MAX_HEIGHT, 1200),
  },

  defaultStartUrl: process.env.DEFAULT_START_URL || 'https://duckduckgo.com',
  /** Signs session tokens. Generated per boot when unset, which invalidates old tokens on restart. */
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
} as const;

export type Config = typeof config;
