import { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { websocketUrl, type PublicSession } from '../api';

type Status = 'connecting' | 'connected' | 'disconnected';

interface Props {
  session: PublicSession;
  wsPath: string;
  /** Fit the remote screen to the viewport instead of showing it 1:1. */
  fitToWindow: boolean;
  quality: number;
  onStatusChange?: (status: Status) => void;
  onDisconnect?: (clean: boolean) => void;
  onClipboard?: (text: string) => void;
  /** Hands the live RFB connection to the parent for clipboard and key injection. */
  onReady?: (rfb: RFB | null) => void;
}

export function BrowserFrame({
  session,
  wsPath,
  fitToWindow,
  quality,
  onStatusChange,
  onDisconnect,
  onClipboard,
  onReady,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [status, setStatus] = useState<Status>('connecting');

  // One RFB per session id: re-running this on every prop change would drop the stream.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const rfb = new RFB(el, websocketUrl(wsPath), {
      credentials: { password: session.vncPassword },
      shared: true,
      wsProtocols: ['binary'],
    });
    rfbRef.current = rfb;
    onReady?.(rfb);
    rfb.background = '#0b0f17';
    rfb.showDotCursor = true;
    rfb.focusOnClick = true;

    const setState = (next: Status) => {
      setStatus(next);
      onStatusChange?.(next);
    };

    const handleConnect = () => setState('connected');
    const handleDisconnect = (event: Event) => {
      setState('disconnected');
      onDisconnect?.(Boolean((event as CustomEvent<{ clean: boolean }>).detail?.clean));
    };
    const handleClipboard = (event: Event) => {
      const text = (event as CustomEvent<{ text: string }>).detail?.text;
      if (text) onClipboard?.(text);
    };

    rfb.addEventListener('connect', handleConnect);
    rfb.addEventListener('disconnect', handleDisconnect);
    rfb.addEventListener('clipboard', handleClipboard);

    return () => {
      rfb.removeEventListener('connect', handleConnect);
      rfb.removeEventListener('disconnect', handleDisconnect);
      rfb.removeEventListener('clipboard', handleClipboard);
      try {
        rfb.disconnect();
      } catch {
        /* already gone */
      }
      rfbRef.current = null;
      onReady?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, wsPath]);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.scaleViewport = fitToWindow;
    rfb.clipViewport = !fitToWindow;
    rfb.dragViewport = !fitToWindow;
  }, [fitToWindow, status]);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.qualityLevel = quality;
    // Higher quality means less aggressive compression; keep them in step.
    rfb.compressionLevel = quality >= 8 ? 2 : quality >= 5 ? 4 : 6;
  }, [quality, status]);

  return (
    <div className="frame">
      <div className="frame__screen" ref={containerRef} />
      {status !== 'connected' && (
        <div className="frame__veil">
          <div className="spinner" aria-hidden />
          <p>{status === 'connecting' ? 'Connecting to your browser…' : 'Stream ended.'}</p>
        </div>
      )}
    </div>
  );
}
