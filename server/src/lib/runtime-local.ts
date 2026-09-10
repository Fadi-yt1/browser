import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { log } from './log.js';
import {
  clampScreen,
  sleep,
  waitForAgent,
  type BrowserRuntime,
  type LaunchOptions,
  type RunningBrowser,
} from './runtime-shared.js';

const run = promisify(execFile);

/**
 * Runs each session as a group of plain processes on this host: its own X display,
 * window manager, Chromium profile and VNC server, no Docker involved.
 *
 * This is the right runtime for a single machine you control, and for development.
 * It is NOT the right runtime for a public instance: sessions share the host kernel,
 * filesystem and network namespace with the gateway, so a browser escape lands
 * directly on your box. Public deployments should use the Docker runtime.
 */
interface LocalHandle {
  id: string;
  display: string;
  profileDir: string;
  procs: ChildProcess[];
}

const live = new Map<string, LocalHandle>();

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_BIN,
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
];

let cachedChromium: string | null = null;

/**
 * Being on PATH is not proof of anything. Ubuntu ships /usr/bin/chromium-browser
 * as a snap wrapper that exits without launching whenever snapd is unavailable —
 * common on container-based VPS plans — and the failure only surfaces later as a
 * session that never becomes ready. Ask the binary to identify itself instead.
 */
async function isUsable(binary: string): Promise<boolean> {
  try {
    const { stdout } = await run(binary, ['--version'], { timeout: 10_000 });
    // A working browser prints e.g. "Chromium 141.0.7390.37". Requiring the version
    // number rejects wrappers that print a chatty message and exit successfully.
    return /chrom\w*\s+\d+\.[\d.]+/i.test(stdout);
  } catch {
    return false;
  }
}

async function resolveChromium(): Promise<string> {
  if (cachedChromium) return cachedChromium;
  const rejected: string[] = [];

  for (const candidate of CHROMIUM_CANDIDATES) {
    if (!candidate) continue;
    let resolved = candidate;
    try {
      const { stdout } = await run('which', [candidate]);
      if (!stdout.trim()) continue;
      resolved = stdout.trim();
    } catch {
      continue; // not on PATH
    }
    if (await isUsable(resolved)) return (cachedChromium = resolved);
    rejected.push(resolved);
  }

  // Playwright installs a Chromium that works fine as a session browser.
  const pwRoot = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    for (const entry of await fs.readdir(pwRoot)) {
      if (!entry.startsWith('chromium-')) continue;
      const candidate = path.join(pwRoot, entry, 'chrome-linux', 'chrome');
      try {
        await fs.access(candidate);
      } catch {
        continue;
      }
      if (await isUsable(candidate)) return (cachedChromium = candidate);
      rejected.push(candidate);
    }
  } catch {
    /* no Playwright install */
  }

  const detail = rejected.length
    ? ` Found but could not run: ${rejected.join(', ')} — on Ubuntu the chromium package is a snap that needs snapd; install a real .deb (google-chrome-stable) or set CHROMIUM_BIN.`
    : '';
  throw new Error(`no working Chromium binary found.${detail}`);
}

/** Ask the kernel for a free port, then hand it straight to the child. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (typeof address === 'string' || !address) return reject(new Error('could not allocate a port'));
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });

async function freeDisplay(): Promise<number> {
  for (let n = 20; n < 200; n += 1) {
    try {
      await fs.access(`/tmp/.X${n}-lock`);
    } catch {
      return n;
    }
  }
  throw new Error('no free X display');
}

const kill = (proc: ChildProcess) => {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  setTimeout(() => proc.killed || proc.kill('SIGKILL'), 2_000).unref();
};

async function waitForX(display: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await run('xdpyinfo', ['-display', display]);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`X display ${display} never came up`);
}

async function resolveAsset(relative: string, override?: string): Promise<string | undefined> {
  if (override) return override;
  // dist/lib/… → repo root, and the repo root itself when running from source.
  const roots = [path.resolve(process.cwd()), path.resolve(process.cwd(), '..')];
  for (const root of roots) {
    const candidate = path.join(root, relative);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try the next root */
    }
  }
  return undefined;
}

export const localRuntime: BrowserRuntime = {
  name: 'local',

  async prepare(): Promise<void> {
    const chromium = await resolveChromium();
    const agent = await resolveAsset('browser-image/agent.mjs', config.local.agentPath);
    if (!agent) throw new Error('could not find browser-image/agent.mjs for the local runtime');
    for (const tool of ['Xvfb', 'x11vnc']) {
      await run('which', [tool]).catch(() => {
        throw new Error(`${tool} is not installed; the local runtime needs Xvfb and x11vnc`);
      });
    }
    log.info('local runtime ready', { chromium, agent });
  },

  async launch(opts: LaunchOptions): Promise<RunningBrowser> {
    const { width, height } = clampScreen(opts.width, opts.height);
    const chromium = await resolveChromium();
    const agentPath = (await resolveAsset('browser-image/agent.mjs', config.local.agentPath))!;
    const openboxConfig = await resolveAsset('browser-image/openbox-rc.xml', config.local.openboxConfig);

    const displayNumber = await freeDisplay();
    const display = `:${displayNumber}`;
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), `bib-${opts.sessionId}-`));
    const handle: LocalHandle = { id: opts.sessionId, display, profileDir, procs: [] };
    live.set(opts.sessionId, handle);

    const spawnChild = (command: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
      const child = spawn(command, args, {
        env: { ...process.env, DISPLAY: display, ...env },
        stdio: 'ignore',
        detached: false,
      });
      child.on('error', (err) => log.warn('local child failed', { command, err: String(err) }));
      handle.procs.push(child);
      return child;
    };

    try {
      spawnChild('Xvfb', [
        display,
        '-screen', '0', `${width}x${height}x${config.screen.depth}`,
        '-nolisten', 'tcp',
        '-dpi', '96',
        '+extension', 'RANDR',
      ]);
      await waitForX(display, 10_000);

      spawnChild('openbox', openboxConfig ? ['--sm-disable', '--config-file', openboxConfig] : ['--sm-disable']);

      const [vncPort, agentPort, cdpPort] = await Promise.all([freePort(), freePort(), freePort()]);

      // The RFB password lives in a file so it never appears in the process list.
      const passwdFile = path.join(profileDir, 'rfbauth');
      await run('x11vnc', ['-storepasswd', opts.vncPassword, passwdFile]);
      await fs.chmod(passwdFile, 0o600);

      // Blank keys silence Chromium's "Google API keys are missing" infobar.
      const chromeEnv = { GOOGLE_API_KEY: 'no', GOOGLE_DEFAULT_CLIENT_ID: 'no', GOOGLE_DEFAULT_CLIENT_SECRET: 'no' };
      spawnChild(chromium, [
        `--user-data-dir=${profileDir}/profile`,
        '--window-position=0,0',
        `--window-size=${width},${height}`,
        `--remote-debugging-port=${cdpPort}`,
        '--no-sandbox',
        '--test-type',
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
        '--disable-background-networking',
        '--disable-breakpad',
        '--disable-sync',
        '--password-store=basic',
        '--incognito',
        '--start-maximized',
        opts.startUrl,
      ], chromeEnv);

      spawnChild('x11vnc', [
        '-display', display,
        '-rfbport', String(vncPort),
        '-localhost',
        '-forever',
        '-shared',
        '-noxdamage',
        '-nolookup',
        '-wait', '10',
        '-defer', '10',
        '-quiet',
        '-rfbauth', passwdFile,
      ]);

      spawnChild('node', [agentPath], { AGENT_PORT: String(agentPort), CDP_PORT: String(cdpPort) });

      const agentBase = `http://127.0.0.1:${agentPort}`;
      await waitForAgent(agentBase, config.docker.startupTimeoutMs);

      log.info('local session ready', { sessionId: opts.sessionId, display, vncPort });
      return { handle: opts.sessionId, vncHost: '127.0.0.1', vncPort, agentBase };
    } catch (err) {
      await localRuntime.destroy(opts.sessionId);
      throw err;
    }
  },

  async destroy(handleId: string): Promise<void> {
    const handle = live.get(handleId);
    if (!handle) return;
    live.delete(handleId);
    for (const proc of handle.procs) kill(proc);
    // Give the X server a moment to drop its lock before the directory goes.
    await sleep(300);
    await fs.rm(handle.profileDir, { recursive: true, force: true }).catch(() => {});
  },

  async reapOrphans(): Promise<number> {
    const count = live.size;
    await Promise.all([...live.keys()].map((id) => localRuntime.destroy(id)));
    return count;
  },

  async ping(): Promise<boolean> {
    try {
      await resolveChromium();
      return true;
    } catch {
      return false;
    }
  },
};
