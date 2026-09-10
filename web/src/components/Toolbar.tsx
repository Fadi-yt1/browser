import { useEffect, useState, type FormEvent } from 'react';

interface Props {
  currentUrl: string;
  connected: boolean;
  remainingMs: number | null;
  fitToWindow: boolean;
  quality: number;
  onNavigate: (value: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onPaste: () => void;
  onExtend: () => void;
  onFullscreen: () => void;
  onToggleFit: () => void;
  onQuality: (value: number) => void;
  onEnd: () => void;
}

const formatRemaining = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export function Toolbar(props: Props) {
  const [draft, setDraft] = useState(props.currentUrl);
  const [editing, setEditing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Follow the remote page unless the visitor is mid-edit.
  useEffect(() => {
    if (!editing) setDraft(props.currentUrl);
  }, [props.currentUrl, editing]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    props.onNavigate(value);
    (document.activeElement as HTMLElement | null)?.blur();
    setEditing(false);
  };

  const low = props.remainingMs !== null && props.remainingMs < 120_000;

  return (
    <header className="toolbar">
      <div className="toolbar__nav">
        <button type="button" onClick={props.onBack} title="Back" aria-label="Back">‹</button>
        <button type="button" onClick={props.onForward} title="Forward" aria-label="Forward">›</button>
        <button type="button" onClick={props.onReload} title="Reload" aria-label="Reload">⟳</button>
      </div>

      <form className="toolbar__omnibox" onSubmit={submit}>
        <span className={`dot ${props.connected ? 'dot--live' : 'dot--dead'}`} title={props.connected ? 'Streaming' : 'Disconnected'} />
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => {
            setEditing(true);
            event.target.select();
          }}
          onBlur={() => setEditing(false)}
          spellCheck={false}
          autoComplete="off"
          placeholder="Search or enter an address"
          aria-label="Address bar"
        />
        <button type="submit" className="toolbar__go">Go</button>
      </form>

      <div className="toolbar__actions">
        {props.remainingMs !== null && (
          <button
            type="button"
            className={`chip ${low ? 'chip--warn' : ''}`}
            onClick={props.onExtend}
            title="Add more time — free, as many times as you like"
          >
            {formatRemaining(props.remainingMs)} · +time
          </button>
        )}
        <button type="button" onClick={props.onPaste} title="Send your clipboard to the remote browser">Paste</button>
        <button type="button" onClick={props.onFullscreen} title="Fullscreen">⛶</button>
        <div className="menu">
          <button type="button" onClick={() => setShowSettings((open) => !open)} aria-expanded={showSettings}>
            ⚙
          </button>
          {showSettings && (
            <div className="menu__panel" onMouseLeave={() => setShowSettings(false)}>
              <label className="menu__row">
                <input type="checkbox" checked={props.fitToWindow} onChange={props.onToggleFit} />
                Fit screen to window
              </label>
              <label className="menu__row menu__row--stack">
                <span>Stream quality: {props.quality}</span>
                <input
                  type="range"
                  min={1}
                  max={9}
                  value={props.quality}
                  onChange={(event) => props.onQuality(Number(event.target.value))}
                />
                <small>Lower uses less bandwidth on slow connections.</small>
              </label>
            </div>
          )}
        </div>
        <button type="button" className="danger" onClick={props.onEnd}>End</button>
      </div>
    </header>
  );
}
