import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { log } from './log.js';
import { destroyContainer, launchBrowser } from './runtime.js';
import { randomId, randomVncPassword, signSessionToken } from './tokens.js';

export type SessionState = 'starting' | 'ready' | 'closing';

export interface Session {
  id: string;
  token: string;
  clientKey: string;
  state: SessionState;
  createdAt: number;
  lastSeenAt: number;
  /** 0 means no time limit. */
  expiresAt: number;
  width: number;
  height: number;
  startUrl: string;
  vncPassword: string;
  containerId?: string;
  vncHost?: string;
  vncPort?: number;
  agentBase?: string;
  viewers: number;
}

export interface Ticket {
  id: string;
  clientKey: string;
  createdAt: number;
  lastSeenAt: number;
  /** Set when a slot has been reserved for this ticket; it must be claimed before this time. */
  claimableUntil: number;
}

export interface PublicSession {
  id: string;
  state: SessionState;
  createdAt: number;
  expiresAt: number;
  ttlMs: number;
  width: number;
  height: number;
  startUrl: string;
  vncPassword: string;
}

export class CapacityError extends Error {
  constructor(public readonly ticket: Ticket, public readonly position: number) {
    super('at capacity');
    this.name = 'CapacityError';
  }
}

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitError';
  }
}

const REAP_INTERVAL_MS = 5_000;

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, Session>();
  private readonly queue: Ticket[] = [];
  private timer?: NodeJS.Timeout;

  start(): void {
    this.timer ??= setInterval(() => this.sweep(), REAP_INTERVAL_MS).unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id, 'shutdown')));
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /** Slots in use: live sessions plus slots reserved for promoted queue tickets. */
  private usedSlots(): number {
    const reserved = this.queue.filter((t) => t.claimableUntil > Date.now()).length;
    return this.sessions.size + reserved;
  }

  stats() {
    return {
      active: this.sessions.size,
      capacity: config.maxConcurrentSessions,
      queued: this.queue.length,
      unlimited: config.unlimited,
      sessionTtlMs: config.sessionTtlMs,
    };
  }

  /**
   * Creates a session, or throws CapacityError carrying a queue ticket when the host
   * is full. Passing a previously issued, promoted ticket claims its reserved slot.
   */
  async create(params: {
    clientKey: string;
    width: number;
    height: number;
    startUrl?: string;
    ticketId?: string;
  }): Promise<Session> {
    const { clientKey } = params;
    const now = Date.now();
    const ticket = params.ticketId ? this.queue.find((t) => t.id === params.ticketId) : undefined;
    const hasReservation = Boolean(ticket && ticket.clientKey === clientKey && ticket.claimableUntil > now);

    if (!hasReservation) {
      const mine = [...this.sessions.values()].filter((s) => s.clientKey === clientKey).length;
      if (config.maxSessionsPerClient > 0 && mine >= config.maxSessionsPerClient) {
        throw new LimitError(
          `You already have ${mine} session${mine === 1 ? '' : 's'} open. Close one before starting another.`,
        );
      }
      if (this.usedSlots() >= config.maxConcurrentSessions) {
        const queued = this.enqueue(clientKey, params.ticketId);
        throw new CapacityError(queued, this.positionOf(queued.id));
      }
    }

    if (ticket) this.dequeue(ticket.id);

    const id = randomId();
    const session: Session = {
      id,
      token: signSessionToken(id),
      clientKey,
      state: 'starting',
      createdAt: now,
      lastSeenAt: now,
      expiresAt: config.sessionTtlMs > 0 ? now + config.sessionTtlMs : 0,
      width: params.width,
      height: params.height,
      startUrl: params.startUrl || config.defaultStartUrl,
      vncPassword: randomVncPassword(),
      viewers: 0,
    };
    this.sessions.set(id, session);

    try {
      const running = await launchBrowser({
        sessionId: id,
        width: session.width,
        height: session.height,
        startUrl: session.startUrl,
        vncPassword: session.vncPassword,
      });
      // The client may have given up while the container was booting.
      if (!this.sessions.has(id)) {
        await destroyContainer(running.containerId);
        throw new Error('session was cancelled during startup');
      }
      Object.assign(session, running, { state: 'ready' as const, lastSeenAt: Date.now() });
      log.info('session ready', { sessionId: id, clientKey });
      this.emit('opened', session);
      return session;
    } catch (err) {
      this.sessions.delete(id);
      this.promote();
      log.error('session failed to start', { sessionId: id, err: String(err) });
      throw err;
    }
  }

  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.lastSeenAt = Date.now();
  }

  addViewer(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.viewers += 1;
    session.lastSeenAt = Date.now();
  }

  removeViewer(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.viewers = Math.max(0, session.viewers - 1);
    session.lastSeenAt = Date.now();
  }

  /** Extends a session by another full TTL. Free, and repeatable. */
  extend(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.lastSeenAt = Date.now();
    if (config.sessionTtlMs > 0) session.expiresAt = Date.now() + config.sessionTtlMs;
    return session;
  }

  async close(id: string, reason: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.state === 'closing') return;
    session.state = 'closing';
    this.sessions.delete(id);
    this.emit('closed', { session, reason });
    if (session.containerId) await destroyContainer(session.containerId);
    log.info('session closed', { sessionId: id, reason, lifetimeMs: Date.now() - session.createdAt });
    this.promote();
  }

  // --- queue ---------------------------------------------------------------

  enqueue(clientKey: string, existingTicketId?: string): Ticket {
    const existing = existingTicketId ? this.queue.find((t) => t.id === existingTicketId) : undefined;
    if (existing && existing.clientKey === clientKey) {
      existing.lastSeenAt = Date.now();
      return existing;
    }
    if (this.queue.length >= config.maxQueueLength) {
      throw new LimitError('The waiting line is full right now. Please try again in a few minutes.');
    }
    const ticket: Ticket = {
      id: randomId(8),
      clientKey,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      claimableUntil: 0,
    };
    this.queue.push(ticket);
    this.promote();
    return ticket;
  }

  poll(ticketId: string): { ticket: Ticket; position: number } | undefined {
    const ticket = this.queue.find((t) => t.id === ticketId);
    if (!ticket) return undefined;
    ticket.lastSeenAt = Date.now();
    this.promote();
    return { ticket, position: this.positionOf(ticketId) };
  }

  dequeue(ticketId: string): void {
    const index = this.queue.findIndex((t) => t.id === ticketId);
    if (index >= 0) this.queue.splice(index, 1);
  }

  positionOf(ticketId: string): number {
    const index = this.queue.findIndex((t) => t.id === ticketId);
    return index < 0 ? 0 : index + 1;
  }

  /** Hands free slots to the front of the line, one reservation per slot. */
  private promote(): void {
    const now = Date.now();
    for (const ticket of this.queue) {
      if (ticket.claimableUntil > now) continue;
      if (this.usedSlots() >= config.maxConcurrentSessions) break;
      ticket.claimableUntil = now + config.queueTicketTtlMs;
      log.debug('queue ticket promoted', { ticketId: ticket.id });
    }
  }

  // --- reaper --------------------------------------------------------------

  private sweep(): void {
    const now = Date.now();

    for (const session of this.sessions.values()) {
      if (session.state !== 'ready') continue;
      if (session.expiresAt > 0 && now >= session.expiresAt) {
        void this.close(session.id, 'expired');
        continue;
      }
      // No viewers and no heartbeat: the tab is gone, so the container should be too.
      if (session.viewers === 0 && now - session.lastSeenAt > config.idleTimeoutMs) {
        void this.close(session.id, 'idle');
      }
    }

    for (const ticket of [...this.queue]) {
      const abandoned = now - ticket.lastSeenAt > config.queueTicketTtlMs;
      const expiredReservation = ticket.claimableUntil > 0 && now > ticket.claimableUntil;
      if (abandoned || expiredReservation) this.dequeue(ticket.id);
    }

    this.promote();
  }
}

export const toPublicSession = (session: Session): PublicSession => ({
  id: session.id,
  state: session.state,
  createdAt: session.createdAt,
  expiresAt: session.expiresAt,
  ttlMs: config.sessionTtlMs,
  width: session.width,
  height: session.height,
  startUrl: session.startUrl,
  vncPassword: session.vncPassword,
});

export const sessionManager = new SessionManager();
