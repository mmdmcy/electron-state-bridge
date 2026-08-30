import {
  useEffect,
  useState,
  type ChangeEvent,
  type JSX
} from 'react';
import {
  useRendererStore,
  useRendererStoreMeta
} from '../../../library/react/hooks.js';
import type { AppAction, TranscriptSegment } from '../../domain/types.js';
import { ProtocolStrip, SessionControls } from './components.js';
import { appStore } from './store.js';
import {
  SYNTHETIC_LINES,
  errorMessage,
  formatTime,
  identifier
} from './view-helpers.js';

export function OverlayApp(): JSX.Element {
  const state = useRendererStore(appStore);
  const meta = useRendererStoreMeta(appStore);
  const [error, setError] = useState<string | null>(null);
  const [syncCost, setSyncCost] = useState<number | null>(null);
  const [commandDraft, setCommandDraft] = useState(state.ui.commandBar.query);

  useEffect(() => {
    setCommandDraft(state.ui.commandBar.query);
  }, [state.ui.commandBar.query]);

  const run = async (action: AppAction): Promise<void> => {
    try {
      setError(null);
      await appStore.dispatch(action);
    } catch (dispatchError) {
      setError(errorMessage(dispatchError));
    }
  };

  const appendSynthetic = async (): Promise<void> => {
    const index = state.transcript.segments.length;
    const segment: TranscriptSegment = {
      id: identifier('segment'),
      speaker: index % 2 === 0 ? 'host' : 'guest',
      text: SYNTHETIC_LINES[index % SYNTHETIC_LINES.length] ?? SYNTHETIC_LINES[0],
      timestamp: Date.now(),
      status: index % 3 === 2 ? 'interim' : 'final'
    };
    await run({ type: 'transcript/append', segment });
  };

  const requestInsight = async (): Promise<void> => {
    await run({
      type: 'insight/request',
      insightId: identifier('insight'),
      transcriptRevision: state.transcript.revision
    });
  };

  const toggleSync = (): void => {
    try {
      setError(null);
      const started = performance.now();
      appStore.dispatchSync({ type: 'ui/toggle-overlay' });
      setSyncCost(performance.now() - started);
    } catch (dispatchError) {
      setError(errorMessage(dispatchError));
    }
  };

  return (
    <main className="overlay-shell">
      <header className="overlay-header">
        <div>
          <span className="eyebrow">Electron state bridge</span>
          <h1>Live session control</h1>
        </div>
        <span className={`session-pill session-${state.session.status}`}>
          {state.session.status}
        </span>
      </header>

      <ProtocolStrip />

      <section className="panel compact-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Canonical session</span>
            <h2>{state.session.id ?? 'No active session'}</h2>
          </div>
          <span>{formatTime(state.session.updatedAt)}</span>
        </div>
        <SessionControls state={state} run={run} />
      </section>

      <section className="panel compact-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Synthetic events</span>
            <h2>{state.transcript.segments.length} transcript segments</h2>
          </div>
          <span>Transcript r{state.transcript.revision}</span>
        </div>
        <div className="button-grid">
          <button
            onClick={() => void appendSynthetic()}
            disabled={state.session.status !== 'listening'}
          >
            Emit test transcript
          </button>
          <button
            onClick={() => void requestInsight()}
            disabled={
              state.transcript.revision === 0
              || (state.session.status !== 'listening' && state.session.status !== 'paused')
            }
          >
            Request insight
          </button>
        </div>
      </section>

      <section className="panel compact-panel">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Command bar state</span>
            <h2>{state.ui.commandBar.open ? 'Open' : 'Closed'}</h2>
          </div>
          <span>{state.ui.overlayVisible ? 'visible flag' : 'hidden flag'}</span>
        </div>
        <div className="command-row">
          <input
            value={commandDraft}
            maxLength={160}
            placeholder="Local draft; commit explicitly"
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setCommandDraft(event.target.value)
            }
          />
          <button
            onClick={() => void run({
              type: 'ui/set-command-bar',
              open: true,
              query: commandDraft
            })}
          >
            Commit
          </button>
        </div>
        <button className="sync-button" onClick={toggleSync}>
          Toggle overlay flag with bounded dispatchSync
        </button>
        <p className="fine-print">
          {syncCost === null
            ? 'This experiment blocks only for a validated pure UI action.'
            : `Last renderer-blocking call: ${syncCost.toFixed(3)} ms.`}
        </p>
      </section>

      {(error ?? meta.lastError?.message) && (
        <div className="error-banner">{error ?? meta.lastError?.message}</div>
      )}
    </main>
  );
}
