import { useMemo, useState, type JSX } from 'react';
import {
  useRendererStore,
  useRendererStoreMeta
} from '../../../library/react/hooks.js';
import type { AppAction } from '../../domain/types.js';
import {
  HistoryList,
  InsightList,
  ProtocolStrip,
  SessionControls,
  TranscriptList
} from './components.js';
import { appStore } from './store.js';
import { errorMessage, identifier } from './view-helpers.js';

export function DashboardApp(): JSX.Element {
  const state = useRendererStore(appStore);
  const meta = useRendererStoreMeta(appStore);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: AppAction): Promise<void> => {
    try {
      setError(null);
      await appStore.dispatch(action);
    } catch (dispatchError) {
      setError(errorMessage(dispatchError));
    }
  };

  const resync = async (): Promise<void> => {
    try {
      setError(null);
      await appStore.resync('dashboard-manual');
    } catch (resyncError) {
      setError(errorMessage(resyncError));
    }
  };

  const appendPair = async (): Promise<void> => {
    if (state.session.status !== 'listening') {
      return;
    }
    const base = state.transcript.segments.length;
    const at = Date.now();
    try {
      setError(null);
      await Promise.all([
        appStore.dispatch({
          type: 'transcript/append',
          segment: {
            id: identifier('dashboard-a'),
            speaker: 'host',
            text: `Competing dashboard append A at local index ${base}.`,
            timestamp: at,
            status: 'final'
          }
        }),
        appStore.dispatch({
          type: 'transcript/append',
          segment: {
            id: identifier('dashboard-b'),
            speaker: 'guest',
            text: `Competing dashboard append B at local index ${base}.`,
            timestamp: at + 1,
            status: 'final'
          }
        })
      ]);
    } catch (dispatchError) {
      setError(errorMessage(dispatchError));
    }
  };

  const stats = useMemo(() => ({
    finalSegments: state.transcript.segments.filter((item) => item.status === 'final').length,
    readyInsights: state.insights.items.filter((item) => item.status === 'ready').length,
    pendingInsights: state.insights.items.filter((item) => item.status === 'pending').length
  }), [state]);

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <span className="eyebrow">Two-window demonstration</span>
          <h1>Revisioned session dashboard</h1>
          <p>Main owns writes; this window reads a stable local snapshot.</p>
        </div>
        <div className="header-actions">
          <button onClick={() => void resync()}>Full resync</button>
          <button onClick={() => window.location.reload()}>Reload renderer</button>
        </div>
      </header>

      <ProtocolStrip />

      <section className="metric-grid">
        <article className="metric-card">
          <span>Session</span>
          <strong>{state.session.status}</strong>
          <small>{state.session.id ?? 'No active id'}</small>
        </article>
        <article className="metric-card">
          <span>Transcript revision</span>
          <strong>{state.transcript.revision}</strong>
          <small>{stats.finalSegments} final segments</small>
        </article>
        <article className="metric-card">
          <span>Insights</span>
          <strong>{stats.readyInsights}</strong>
          <small>{stats.pendingInsights} pending</small>
        </article>
        <article className="metric-card">
          <span>Bridge revision</span>
          <strong>{meta.revision}</strong>
          <small>{meta.status}</small>
        </article>
      </section>

      <section className="control-panel panel">
        <SessionControls state={state} run={run} />
        <div className="control-divider" />
        <button
          onClick={() => void appendPair()}
          disabled={state.session.status !== 'listening'}
        >
          Dispatch competing append pair
        </button>
        <button
          onClick={() => void run({
            type: 'insight/request',
            insightId: identifier('dashboard-insight'),
            transcriptRevision: state.transcript.revision
          })}
          disabled={state.transcript.revision === 0 || state.session.status === 'ended'}
        >
          Request insight
        </button>
      </section>

      <nav className="view-tabs" aria-label="Dashboard view">
        {(['transcript', 'insights', 'history'] as const).map((view) => (
          <button
            key={view}
            className={state.ui.activeView === view ? 'active' : ''}
            onClick={() => void run({ type: 'ui/set-active-view', view })}
          >
            {view}
          </button>
        ))}
      </nav>

      <section className="content-panel panel">
        {state.ui.activeView === 'transcript' && (
          <TranscriptList state={state} run={run} />
        )}
        {state.ui.activeView === 'insights' && <InsightList state={state} />}
        {state.ui.activeView === 'history' && <HistoryList state={state} />}
      </section>

      {(error ?? meta.lastError?.message) && (
        <div className="error-banner">{error ?? meta.lastError?.message}</div>
      )}
    </main>
  );
}
