import { useCallback, useEffect, useRef, useState } from 'react';
import { Landing } from './pages/Landing';
import { SessionView } from './pages/SessionView';
import { launchSession, pollQueue, type PublicSession } from './api';

interface Live {
  session: PublicSession;
  token: string;
  wsPath: string;
}

interface QueueState {
  ticket: string;
  position: number;
  message: string;
}

export default function App() {
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const startUrlRef = useRef<string | undefined>(undefined);

  const start = useCallback(async (url?: string, ticket?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    startUrlRef.current = url ?? startUrlRef.current;

    try {
      const result = await launchSession({
        width: Math.min(1920, Math.max(1024, Math.round(window.innerWidth * (window.devicePixelRatio > 1 ? 1 : 1)))),
        height: Math.min(1200, Math.max(700, Math.round(window.innerHeight - 48))),
        url: startUrlRef.current,
        ticket,
      });

      if (result.kind === 'session' && result.session && result.token && result.wsPath) {
        setQueue(null);
        setLive({ session: result.session, token: result.token, wsPath: result.wsPath });
        return;
      }
      if (result.kind === 'queued' && result.ticket) {
        setQueue({
          ticket: result.ticket,
          position: result.position ?? 1,
          message: result.message ?? 'Waiting for a free browser.',
        });
      }
    } catch (err) {
      setQueue(null);
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }, []);

  // While queued, poll for a reserved slot and claim it the moment it opens.
  useEffect(() => {
    if (!queue || live) return;
    let stopped = false;

    const timer = window.setInterval(async () => {
      try {
        const status = await pollQueue(queue.ticket);
        if (stopped) return;
        if (status.ready) {
          window.clearInterval(timer);
          await start(undefined, queue.ticket);
          return;
        }
        setQueue((current) => (current ? { ...current, position: status.position } : current));
      } catch {
        if (stopped) return;
        window.clearInterval(timer);
        setQueue(null);
        setError('Your place in line expired. Press launch to try again.');
      }
    }, 2_000);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [queue, live, start]);

  const exitSession = useCallback((message?: string) => {
    setLive(null);
    setQueue(null);
    setNotice(message ?? null);
  }, []);

  if (live) {
    return (
      <SessionView
        key={live.session.id}
        session={live.session}
        token={live.token}
        wsPath={live.wsPath}
        onExit={exitSession}
      />
    );
  }

  return (
    <Landing
      onLaunch={(url) => void start(url)}
      busy={busy || Boolean(queue)}
      notice={notice}
      error={error}
      queue={queue}
    />
  );
}
