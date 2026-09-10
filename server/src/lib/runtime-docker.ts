import Docker from 'dockerode';
import { config } from '../config.js';
import { log } from './log.js';
import {
  clampScreen,
  waitForAgent,
  type BrowserRuntime,
  type LaunchOptions,
  type RunningBrowser,
} from './runtime-shared.js';

const docker = new Docker({ socketPath: config.docker.socketPath });

/**
 * Two connectivity modes:
 *  - a dedicated Docker network (compose deployments): reach containers by their
 *    private IP, publishing nothing to the host;
 *  - no network configured (bare-metal dev): publish the ports on loopback only.
 */
const usesPrivateNetwork = () => Boolean(config.docker.network);

async function ensureImage(): Promise<void> {
  const { image } = config.docker;
  try {
    await docker.getImage(image).inspect();
    log.info('browser image present', { image });
  } catch {
    log.warn('browser image missing locally, attempting pull', { image });
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (progressErr: Error | null) =>
          progressErr ? reject(progressErr) : resolve(),
        );
      });
    });
  }
}

async function launchBrowser(opts: LaunchOptions): Promise<RunningBrowser> {
  const { docker: d, screen } = config;
  const { width, height } = clampScreen(opts.width, opts.height);

  const container = await docker.createContainer({
    Image: d.image,
    name: `bib-${opts.sessionId}`,
    Hostname: 'browser',
    Labels: { [d.labelKey]: d.labelValue, 'bib.session': opts.sessionId },
    Env: [
      `SCREEN_WIDTH=${width}`,
      `SCREEN_HEIGHT=${height}`,
      `SCREEN_DEPTH=${screen.depth}`,
      `START_URL=${opts.startUrl}`,
      `VNC_PASSWORD=${opts.vncPassword}`,
    ],
    ExposedPorts: { '5900/tcp': {}, '6070/tcp': {} },
    HostConfig: {
      // Every session is disposable: it gets torn down and forgotten.
      AutoRemove: true,
      Init: true,
      Memory: d.memoryMb * 1024 * 1024,
      MemorySwap: d.memoryMb * 1024 * 1024,
      NanoCpus: Math.round(d.cpus * 1e9),
      ShmSize: d.shmSizeMb * 1024 * 1024,
      PidsLimit: d.pidsLimit,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Dns: d.dns.length ? [...d.dns] : undefined,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=256m' },
      NetworkMode: usesPrivateNetwork() ? d.network : 'bridge',
      PortBindings: usesPrivateNetwork()
        ? undefined
        : {
            // Loopback only. The gateway is the sole way in from outside.
            '5900/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }],
            '6070/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }],
          },
    },
  });

  await container.start();

  try {
    const endpoint = await resolveEndpoint(container);
    await waitForAgent(endpoint.agentBase, config.docker.startupTimeoutMs);
    log.info('session container ready', { sessionId: opts.sessionId, containerId: container.id.slice(0, 12) });
    return { handle: container.id, ...endpoint };
  } catch (err) {
    await destroyContainer(container.id);
    throw err;
  }
}

async function resolveEndpoint(container: Docker.Container): Promise<Omit<RunningBrowser, 'handle'>> {
  const info = await container.inspect();

  if (usesPrivateNetwork()) {
    const net = info.NetworkSettings.Networks?.[config.docker.network];
    const ip = net?.IPAddress;
    if (!ip) throw new Error(`container has no address on network ${config.docker.network}`);
    return { vncHost: ip, vncPort: 5900, agentBase: `http://${ip}:6070` };
  }

  const bindings = info.NetworkSettings.Ports || {};
  const vnc = bindings['5900/tcp']?.[0]?.HostPort;
  const agent = bindings['6070/tcp']?.[0]?.HostPort;
  if (!vnc || !agent) throw new Error('container ports were not published');
  return { vncHost: '127.0.0.1', vncPort: Number(vnc), agentBase: `http://127.0.0.1:${agent}` };
}

async function destroyContainer(containerId: string): Promise<void> {
  try {
    await docker.getContainer(containerId).remove({ force: true, v: true });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    // 404/409 mean it is already gone or already being removed by AutoRemove.
    if (status !== 404 && status !== 409) {
      log.warn('failed to remove container', { containerId: containerId.slice(0, 12), err: String(err) });
    }
  }
}

/** Sweeps containers orphaned by a crash or redeploy of the orchestrator. */
async function reapOrphans(): Promise<number> {
  const { labelKey, labelValue } = config.docker;
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`${labelKey}=${labelValue}`] },
    });
    await Promise.all(containers.map((c) => destroyContainer(c.Id)));
    if (containers.length) log.info('reaped orphaned session containers', { count: containers.length });
    return containers.length;
  } catch (err) {
    log.warn('orphan sweep failed', { err: String(err) });
    return 0;
  }
}

const ping = async (): Promise<boolean> => {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
};

export const dockerRuntime: BrowserRuntime = {
  name: 'docker',
  prepare: ensureImage,
  launch: launchBrowser,
  destroy: destroyContainer,
  reapOrphans,
  ping,
};
