import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Sessions are anonymous, so possession of the token is what proves ownership.
 * It is an HMAC over the session id: stateless to verify, useless to forge, and
 * safe to hand to a browser that never signed up for anything.
 */
export const signSessionToken = (sessionId: string): string =>
  crypto.createHmac('sha256', config.secret).update(sessionId).digest('hex');

export const verifySessionToken = (sessionId: string, token: unknown): boolean => {
  if (typeof token !== 'string' || token.length !== 64) return false;
  const expected = Buffer.from(signSessionToken(sessionId), 'utf8');
  const provided = Buffer.from(token, 'utf8');
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
};

export const randomId = (bytes = 12): string => crypto.randomBytes(bytes).toString('base64url');

/** VNC passwords are truncated to 8 bytes by the RFB protocol, so generate exactly that. */
export const randomVncPassword = (): string =>
  crypto.randomBytes(6).toString('base64').replace(/[+/=]/g, 'x').slice(0, 8);
