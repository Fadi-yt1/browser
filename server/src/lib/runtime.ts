import { config } from '../config.js';
import { dockerRuntime } from './runtime-docker.js';
import { localRuntime } from './runtime-local.js';
import type { BrowserRuntime } from './runtime-shared.js';

/**
 * Two ways to run a session:
 *   docker — one hardened container per session. The only sane choice in public.
 *   local  — plain processes on this host. No isolation; for a machine you control.
 */
export const runtime: BrowserRuntime = config.runtime === 'local' ? localRuntime : dockerRuntime;

export type { BrowserRuntime, LaunchOptions, RunningBrowser } from './runtime-shared.js';
