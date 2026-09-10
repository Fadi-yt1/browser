import net from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { log } from './log.js';
import { sessionManager } from './sessions.js';
import { verifySessionToken } from './tokens.js';

/**
 * Bridges the browser's WebSocket to the session container's raw RFB port, the
 * job websockify normally does. Doing it in-process means session containers
 * never need a published port and every byte passes an ownership check first.
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;

export function attachVncBridge(server: Server): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    // noVNC negotiates the "binary" subprotocol on older clients; accept it, ignore the rest.
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
    maxPayload: 16 * 1024 * 1024,
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const match = url.pathname.match(/^\/ws\/session\/([\w-]+)$/);
    if (!match) return reject(socket, 404, 'Not Found');

    const sessionId = match[1]!;
    const token = url.searchParams.get('token');
    const session = sessionManager.get(sessionId);

    if (!session || !verifySessionToken(sessionId, token)) return reject(socket, 401, 'Unauthorized');
    if (session.state !== 'ready' || !session.vncHost || !session.vncPort) {
      return reject(socket, 409, 'Session Not Ready');
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      pipe(ws, sessionId, session.vncHost!, session.vncPort!);
    });
  });

  return wss;
}

function reject(socket: Duplex, code: number, message: string): void {
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function pipe(ws: WebSocket, sessionId: string, host: string, port: number): void {
  const tcp = net.connect({ host, port });
  tcp.setNoDelay(true);
  sessionManager.addViewer(sessionId);

  let closed = false;
  const shutdown = (reason: string) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    sessionManager.removeViewer(sessionId);
    tcp.destroy();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, reason);
    log.debug('vnc bridge closed', { sessionId, reason });
  };

  // Drop clients that stop answering pings so their container can be reclaimed.
  let alive = true;
  const heartbeat = setInterval(() => {
    if (!alive) return shutdown('ping timeout');
    alive = false;
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, HEARTBEAT_MS).unref();

  ws.on('pong', () => {
    alive = true;
    sessionManager.touch(sessionId);
  });

  tcp.on('connect', () => log.debug('vnc bridge open', { sessionId }));
  tcp.on('data', (chunk) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(chunk, { binary: true });
    // Slow client: stop reading from the container until the socket drains.
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      tcp.pause();
      const drain = setInterval(() => {
        if (closed) return clearInterval(drain);
        if (ws.bufferedAmount <= MAX_BUFFERED_BYTES / 2) {
          clearInterval(drain);
          tcp.resume();
        }
      }, 20).unref();
    }
  });
  tcp.on('error', (err) => shutdown(`upstream error: ${err.message}`));
  tcp.on('close', () => shutdown('upstream closed'));

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    sessionManager.touch(sessionId);
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (!tcp.destroyed) tcp.write(buf);
  });
  ws.on('error', (err) => shutdown(`client error: ${err.message}`));
  ws.on('close', () => shutdown('client closed'));
}
