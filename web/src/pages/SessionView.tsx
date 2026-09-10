import { useCallback, useEffect, useRef, useState } from 'react';
import type RFB from '@novnc/novnc';
import { BrowserFrame } from '../components/BrowserFrame';
import { Toolbar } from '../components/Toolbar';
import {
  control,
  endSession,
  extendSession,
  getPageState,
  heartbeat,
  navigate,
  pushClipboard,
  releaseOnUnload,
  type PublicSession,
} from '../api';

interface Props {
  session: PublicSession;
  token: string;
  wsPath: string;
  onExit: (notice?: string) => void;
}

export function SessionView({ session: initial, token, wsPath, onExit }: Props) {
  const [session, setSession] = useState(initial);
  const [connected, setConnected] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(initial.startUrl);
  const [fitToWindow, setFitToWindow] = useState(true);
  const [quality, setQuality] = useState(6);
  const [toast, setToast] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(
    initial.expiresAt ? initial.expiresAt - Date.now() : null,
  );
  const rfbRef = useRef<RFB | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  const flash = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 3200);
  }, []);

  // Keep the container alive while this tab is open, and notice when it isn't.
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const { session: fresh } = await heartbeat(session.id, token);
        if (!stopped) setSession(fresh);
      } catch {
        if (!stopped) onExit('Your session ended.');
      }
    };
    const timer = window.setInterval(tick, 20_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [session.id, token, onExit]);

  // Release the container immediately when the tab goes away.
  useEffect(() => {
    const bye = () => releaseOnUnload(session.id, token);
    window.addEventListener('pagehide', bye);
    return () => window.removeEventListener('pagehide', bye);
  }, [session.id, token]);

  useEffect(() => {
    if (!session.expiresAt) return setRemainingMs(null);
    const timer = window.setInterval(() => setRemainingMs(session.expiresAt - Date.now()), 1000);
    setRemainingMs(session.expiresAt - Date.now());
    return () => window.clearInterval(timer);
  }, [session.expiresAt]);

  // Mirror the remote address bar.
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const state = await getPageState(session.id, token);
        if (!stopped && state.url && state.url !== 'about:blank') setCurrentUrl(state.url);
      } catch {
        /* transient; the heartbeat owns session liveness */
      }
    };
    void poll();
    const timer = window.setInterval(poll, 3_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [session.id, token]);

  const handleNavigate = async (value: string) => {
    try {
      const result = await navigate(session.id, token, value);
      if (result.url) setCurrentUrl(result.url);
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not open that address.');
    }
  };

  const handleControl = (action: 'back' | 'forward' | 'reload') => {
    void control(session.id, token, action).catch(() => flash('That did not go through.'));
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return flash('Your clipboard is empty.');
      await pushClipboard(session.id, token, text);
      rfbRef.current?.clipboardPasteFrom(text);
      flash('Clipboard sent — press Ctrl+V in the remote page.');
    } catch {
      flash('Your browser blocked clipboard access. Copy inside the session instead.');
    }
  };

  const handleExtend = async () => {
    try {
      const { session: fresh } = await extendSession(session.id, token);
      setSession(fresh);
      flash('More time added.');
    } catch {
      flash('Could not extend the session.');
    }
  };

  const handleFullscreen = () => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => flash('Fullscreen was blocked.'));
  };

  const handleEnd = async () => {
    try {
      await endSession(session.id, token);
    } catch {
      /* it may already be gone */
    }
    onExit('Session closed. Everything in it is gone.');
  };

  return (
    <div className="session" ref={shellRef}>
      <Toolbar
        currentUrl={currentUrl}
        connected={connected}
        remainingMs={remainingMs}
        fitToWindow={fitToWindow}
        quality={quality}
        onNavigate={handleNavigate}
        onBack={() => handleControl('back')}
        onForward={() => handleControl('forward')}
        onReload={() => handleControl('reload')}
        onPaste={handlePaste}
        onExtend={handleExtend}
        onFullscreen={handleFullscreen}
        onToggleFit={() => setFitToWindow((value) => !value)}
        onQuality={setQuality}
        onEnd={handleEnd}
      />

      <BrowserFrame
        session={session}
        wsPath={wsPath}
        fitToWindow={fitToWindow}
        quality={quality}
        onReady={(rfb) => {
          rfbRef.current = rfb;
        }}
        onStatusChange={(status) => setConnected(status === 'connected')}
        onDisconnect={() => onExit('The stream closed. Your session was cleaned up.')}
        onClipboard={(text) => {
          void navigator.clipboard.writeText(text).catch(() => {});
        }}
      />

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
