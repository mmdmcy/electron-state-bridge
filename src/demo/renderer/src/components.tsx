import type { JSX } from 'react';
import type { DeepReadonly } from '../../../library/core/types.js';
import { useRendererStoreMeta } from '../../../library/react/hooks.js';
import type { AppAction, AppState } from '../../domain/types.js';
import { appStore } from './store.js';
import { formatTime, identifier } from './view-helpers.js';

export function ProtocolStrip(): JSX.Element {
  const meta = useRendererStoreMeta(appStore);
  return (
    <div className="protocol-strip" aria-label="State bridge status">
      <span><strong>Revision</strong> {meta.revision}</span>
      <span><strong>Client</strong> {meta.status}</span>
      <span>
        <strong>Gap</strong>{' '}
        {meta.lastGap === null
          ? 'none'
          : `${meta.lastGap.expected}→${meta.lastGap.received}`}
      </span>
    </div>
  );
}

interface SessionControlsProps {
  readonly state: DeepReadonly<AppState>;
  readonly run: (action: AppAction) => Promise<void>;
}

export function SessionControls({ state, run }: SessionControlsProps): JSX.Element {
  const status = state.session.status;
  return (
    <div className="button-row">
      {(status === 'idle' || status === 'ended') && (
        <button
          className="primary"
          onClick={() => void run({
            type: 'session/start',
            sessionId: identifier('session')
          })}
        >
          Start synthetic session
        </button>
      )}
      {status === 'listening' && (
        <button onClick={() => void run({ type: 'session/pause' })}>Pause</button>
      )}
      {status === 'paused' && (
        <button onClick={() => void run({ type: 'session/resume' })}>Resume</button>
      )}
      {(status === 'listening' || status === 'paused') && (
        <button className="danger" onClick={() => void run({ type: 'session/end' })}>
          End session
        </button>
      )}
    </div>
  );
}

interface TranscriptListProps {
  readonly state: DeepReadonly<AppState>;
  readonly run: (action: AppAction) => Promise<void>;
}

export function TranscriptList({ state, run }: TranscriptListProps): JSX.Element {
  if (state.transcript.segments.length === 0) {
    return <div className="empty-state">No synthetic transcript segments yet.</div>;
  }

  return (
    <div className="transcript-list">
      {state.transcript.segments.map((segment) => (
        <article className="transcript-item" key={segment.id}>
          <div className="transcript-meta">
            <span className={`speaker speaker-${segment.speaker}`}>{segment.speaker}</span>
            <span>{formatTime(segment.timestamp)}</span>
            <span className={`status-tag status-${segment.status}`}>{segment.status}</span>
          </div>
          <p>{segment.text}</p>
          {segment.status === 'interim' && (
            <button
              className="text-button"
              onClick={() => void run({
                type: 'transcript/finalize',
                segmentId: segment.id
              })}
            >
              Finalize segment
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

export function InsightList(
  { state }: { readonly state: DeepReadonly<AppState> }
): JSX.Element {
  if (state.insights.items.length === 0) {
    return <div className="empty-state">No insight requests yet.</div>;
  }
  return (
    <div className="insight-list">
      {state.insights.items.map((item) => (
        <article className="insight-item" key={item.id}>
          <div className="insight-heading">
            <span className={`status-dot status-${item.status}`} />
            <strong>{item.status}</strong>
            <span>Transcript r{item.transcriptRevision}</span>
          </div>
          <p>{item.text ?? item.error ?? 'Main process is preparing a synthetic insight.'}</p>
        </article>
      ))}
    </div>
  );
}

export function HistoryList(
  { state }: { readonly state: DeepReadonly<AppState> }
): JSX.Element {
  if (state.history.length === 0) {
    return <div className="empty-state">End a session to create a local summary.</div>;
  }
  return (
    <div className="history-list">
      {[...state.history].reverse().map((summary) => (
        <article className="history-item" key={summary.id}>
          <div>
            <strong>{summary.sessionId}</strong>
            <span>{formatTime(summary.startedAt)} – {formatTime(summary.endedAt)}</span>
          </div>
          <dl>
            <div><dt>Segments</dt><dd>{summary.segmentCount}</dd></div>
            <div><dt>Final</dt><dd>{summary.finalSegmentCount}</dd></div>
            <div><dt>Insights</dt><dd>{summary.readyInsightCount}</dd></div>
          </dl>
          <p>{summary.preview || 'No finalized transcript preview.'}</p>
        </article>
      ))}
    </div>
  );
}
