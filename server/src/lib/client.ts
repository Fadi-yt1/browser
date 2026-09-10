import crypto from 'node:crypto';
import type { Request } from 'express';
import { config } from '../config.js';

/**
 * Anonymous but stable-ish identity for limits and queueing. Hashed with the
 * server secret so raw visitor IPs are never stored in memory or logs.
 */
export function clientKey(req: Request): string {
  const ip = clientIp(req);
  return crypto.createHmac('sha256', config.secret).update(`ip:${ip}`).digest('hex').slice(0, 24);
}

export function clientIp(req: Request): string {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    if (first?.trim()) return first.trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
