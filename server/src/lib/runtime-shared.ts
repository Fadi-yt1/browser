import { config } from '../config.js';

export interface LaunchOptions {
  sessionId: string;
  width: number;
  height: number;
  startUrl: string;
  vncPassword: string;
}

export interface RunningBrowser {
  /** Runtime-specific handle: a container id, or a local process group key. */
  handle: string;
  /** Where the gateway reaches the session's RFB port. */
  vncHost: string;
  vncPort: number;
  /** Where the gateway reaches the session's control agent. */
  agentBase: string;
}

export interface BrowserRuntime {
  name: string;
  prepare(): Promise<void>;
  launch(opts: LaunchOptions): Promise<RunningBrowser>;
  destroy(handle: string): Promise<void>;
  reapOrphans(): Promise<number>;
  ping(): Promise<boolean>;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const clampScreen = (width: number, height: number) => ({
  width: Math.min(Math.max(width, 640), config.screen.maxWidth),
  height: Math.min(Math.max(height, 480), config.screen.maxHeight),
});

/** Chromium and the X server take a moment; poll the agent until it answers. */
export async function waitForAgent(agentBase: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timed out';

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${agentBase}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
      lastError = `agent returned ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(400);
  }
  throw new Error(`session did not become ready: ${lastError}`);
}
