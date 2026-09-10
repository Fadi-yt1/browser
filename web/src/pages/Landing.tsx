import { useEffect, useState } from 'react';
import { getStats, type Stats } from '../api';
import { getApiBase, isSameOrigin, setApiBase } from '../backend';

interface Props {
  onLaunch: (url?: string) => void;
  busy: boolean;
  notice?: string | null;
  error?: string | null;
  queue?: { position: number; message: string } | null;
}

const features = [
  {
    title: 'Nothing lands on your machine',
    body: 'Pages render on a server in a throwaway container. Your device only ever receives pixels, so downloads, scripts and trackers stay on our side of the wire.',
  },
  {
    title: 'Gone the moment you leave',
    body: 'Close the tab and the container is destroyed — profile, cookies, cache, history and all. The next session starts from a blank machine.',
  },
  {
    title: 'No account, no card',
    body: 'No sign-up, no email, no trial that quietly expires. Open the page, press the button, get a browser.',
  },
  {
    title: 'Runs where your browser cannot',
    body: 'Old laptops, locked-down work machines, tablets, anything with a modern tab. The heavy lifting happens server-side.',
  },
  {
    title: 'Yours to self-host',
    body: 'The whole stack is in one repository under a permissive license. Point it at any box with Docker and run your own instance.',
  },
  {
    title: 'Honest about limits',
    body: 'Every session is a real browser using real memory. Instead of a paywall you get a fair queue when the machine is full.',
  },
];

const faq = [
  {
    q: 'Is it really free?',
    a: 'Yes — no accounts, no upsell, no locked features. The trade is capacity: one server can only run so many browsers at once, so when it is full you wait in line instead of paying to skip it. Self-host it and the only limit is your own hardware.',
  },
  {
    q: 'How is this different from a VPN or proxy?',
    a: 'A proxy still runs the page in your browser. Here the page runs in a container on the server; you receive a video-like stream of it and send back clicks and keystrokes. Nothing from the site executes on your device.',
  },
  {
    q: 'Can you see what I browse?',
    a: 'The session container holds your page while it is open, and the server sees the addresses you ask it to open, the same as any hosted browser. Nothing is written to a database and the container is wiped on exit. If that is not good enough for your threat model, run your own instance — that is exactly why the source is here.',
  },
  {
    q: 'Why does it feel slower than my own browser?',
    a: 'Every frame makes a round trip over the network. Lower the stream quality in the settings menu on a slow connection, and expect video and games to stay rough — this is built for reading, testing and opening things you do not trust.',
  },
  {
    q: 'What is not allowed?',
    a: 'Anything illegal, plus scraping, spam and abuse of other services. Sessions are rate-limited and capped, and the instance operator can block domains.',
  },
];

/**
 * A page served over HTTPS cannot talk to a plain-HTTP gateway: the browser blocks
 * it as mixed content, silently, which reads as "the server is down". Catch it here
 * with an explanation instead.
 */
function validateGateway(value: string): string | null {
  const raw = value.trim();
  if (!raw) return 'Enter the address your gateway is reachable at.';

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'That is not a valid address. Include the scheme, for example https://browser.example.com';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'The address must start with http:// or https://';
  if (location.protocol === 'https:' && url.protocol === 'http:') {
    return 'This page is served over HTTPS, so your browser will block a plain http:// gateway. Put TLS in front of the gateway and use https://, or open this site over http:// instead.';
  }
  return null;
}

export function Landing({ onLaunch, busy, notice, error, queue }: Props) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [url, setUrl] = useState('');
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [serverDraft, setServerDraft] = useState(getApiBase());
  const [connectError, setConnectError] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      getStats().then(
        (next) => {
          if (stopped) return;
          setStats(next);
          setReachable(true);
        },
        (err: unknown) => {
          if (stopped) return;
          setReachable(false);
          setProbeError(err instanceof Error ? err.message : null);
        },
      );
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="landing">
      <nav className="landing__nav">
        <span className="brand">🛟 Driftwood</span>
        <span className="landing__navRight">
          {!isSameOrigin() && reachable && <span className="chip chip--server">server: {getApiBase()}</span>}
          <a className="landing__ghost" href="https://github.com/Fadi-yt1/browser" target="_blank" rel="noreferrer">
            Source
          </a>
        </span>
      </nav>

      <main className="hero">
        <h1>
          A browser <em>inside</em> your browser.
        </h1>
        <p className="hero__sub">
          Open a disposable, sandboxed Chromium that runs on our server and streams into this tab. Free,
          unlimited, no account — and it forgets everything the second you close it.
        </p>

        {reachable === false && (
          <form
            className="connect"
            onSubmit={(event) => {
              event.preventDefault();
              const problem = validateGateway(serverDraft);
              if (problem) return setConnectError(problem);
              setApiBase(serverDraft);
              location.reload();
            }}
          >
            <h2>Point this page at your server</h2>
            <p>
              {probeError
                ? probeError
                : isSameOrigin()
                  ? 'No browser server is answering here. If you are running one elsewhere, give its address; otherwise start one with the instructions in the repository.'
                  : `Could not reach ${getApiBase()}. Check that the gateway is running and reachable from this device.`}
            </p>
            <div className="connect__row">
              <input
                value={serverDraft}
                onChange={(event) => setServerDraft(event.target.value)}
                placeholder="https://browser.your-domain.tld"
                aria-label="Gateway address"
                spellCheck={false}
              />
              <button type="submit">Connect</button>
            </div>
            {connectError && <p className="connect__error">{connectError}</p>}
            <small>
              Stored in this browser only. Run a gateway with{' '}
              <code>docker compose up -d</code> — see the{' '}
              <a href="https://github.com/Fadi-yt1/browser#quick-start" target="_blank" rel="noreferrer">
                setup guide
              </a>
              .
            </small>
          </form>
        )}

        <form
          className="hero__launch"
          onSubmit={(event) => {
            event.preventDefault();
            onLaunch(url.trim() || undefined);
          }}
        >
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="Start at an address (optional)"
            aria-label="Starting address"
            spellCheck={false}
          />
          <button type="submit" disabled={busy || reachable === false}>
            {busy ? 'Starting…' : 'Launch browser'}
          </button>
        </form>

        {queue && (
          <div className="banner banner--queue">
            <strong>#{queue.position} in line.</strong> {queue.message}
          </div>
        )}
        {error && <div className="banner banner--error">{error}</div>}
        {notice && !error && !queue && <div className="banner">{notice}</div>}

        {stats && (
          <p className="hero__status">
            <span className={`dot ${stats.free > 0 ? 'dot--live' : 'dot--busy'}`} />
            {stats.free > 0
              ? `${stats.free} of ${stats.capacity} browsers free right now`
              : `All ${stats.capacity} browsers busy · ${stats.queued} waiting`}
          </p>
        )}
      </main>

      <section className="grid" aria-label="Features">
        {features.map((feature) => (
          <article key={feature.title} className="card">
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
          </article>
        ))}
      </section>

      <section className="steps" aria-label="How it works">
        <h2>How it works</h2>
        <ol>
          <li>
            <strong>You press launch.</strong> The orchestrator starts a fresh container with its own X display and
            Chromium inside.
          </li>
          <li>
            <strong>The screen is exported.</strong> A VNC server captures that display; the gateway pipes it over a
            single authenticated WebSocket.
          </li>
          <li>
            <strong>Your tab draws it.</strong> Clicks and keystrokes travel back up the same socket, so the remote
            browser feels like a local window.
          </li>
          <li>
            <strong>You leave, it dies.</strong> The container is removed on exit, on timeout, or when the tab stops
            answering.
          </li>
        </ol>
      </section>

      <section className="faq" aria-label="Questions">
        <h2>Questions</h2>
        {faq.map((item) => (
          <details key={item.q}>
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </section>

      <footer className="landing__footer">
        <p>
          Open source, self-hostable, no telemetry. Sessions are throwaway by design — do not use one for anything you
          would not want to lose.
        </p>
      </footer>
    </div>
  );
}
