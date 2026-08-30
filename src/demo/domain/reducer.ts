import { ReducerRejectedError } from '../../library/core/errors.js';
import type {
  ActionAuthorizer,
  DeepReadonly,
  ReducerContext,
  SyncActionPolicy
} from '../../library/core/types.js';
import type {
  AppAction,
  AppState,
  InsightItem,
  SessionSummary,
  TranscriptSegment
} from './types.js';

function reject(message: string): never {
  throw new ReducerRejectedError(message);
}

function requireActiveSession(state: DeepReadonly<AppState>): void {
  if (state.session.status !== 'listening') {
    reject('Transcript mutations require a listening session.');
  }
}

function summarize(state: DeepReadonly<AppState>, endedAt: number): SessionSummary {
  const sessionId = state.session.id;
  const startedAt = state.session.startedAt;
  if (sessionId === null || startedAt === null) {
    return reject('A completed session must have an id and start time.');
  }

  const preview = state.transcript.segments
    .filter((segment) => segment.status === 'final')
    .map((segment) => segment.text)
    .join(' ')
    .slice(0, 180);

  return {
    id: `summary-${sessionId}-${endedAt}`,
    sessionId,
    startedAt,
    endedAt,
    segmentCount: state.transcript.segments.length,
    finalSegmentCount: state.transcript.segments.filter(
      (segment) => segment.status === 'final'
    ).length,
    readyInsightCount: state.insights.items.filter(
      (insight) => insight.status === 'ready'
    ).length,
    preview
  };
}

function replaceInsight(
  items: readonly DeepReadonly<InsightItem>[],
  insightId: string,
  update: (item: DeepReadonly<InsightItem>) => InsightItem
): readonly InsightItem[] {
  let found = false;
  const next = items.map((item) => {
    if (item.id !== insightId) {
      return item as InsightItem;
    }
    found = true;
    return update(item);
  });
  if (!found) {
    reject(`Insight "${insightId}" does not exist.`);
  }
  return next;
}

export function reduceAppState(
  state: DeepReadonly<AppState>,
  action: AppAction,
  context: ReducerContext
): AppState {
  switch (action.type) {
    case 'session/start': {
      if (state.session.status === 'listening' || state.session.status === 'paused') {
        return reject('The current session must end before another session starts.');
      }
      return {
        ...state,
        session: {
          status: 'listening',
          id: action.sessionId,
          startedAt: context.now,
          pausedAt: null,
          endedAt: null,
          updatedAt: context.now
        },
        transcript: { revision: 0, segments: [] },
        insights: { items: [] }
      };
    }
    case 'session/pause':
      if (state.session.status !== 'listening') {
        return reject('Only a listening session can be paused.');
      }
      return {
        ...state,
        session: {
          ...state.session,
          status: 'paused',
          pausedAt: context.now,
          updatedAt: context.now
        }
      };
    case 'session/resume':
      if (state.session.status !== 'paused') {
        return reject('Only a paused session can be resumed.');
      }
      return {
        ...state,
        session: {
          ...state.session,
          status: 'listening',
          pausedAt: null,
          updatedAt: context.now
        }
      };
    case 'session/end': {
      if (state.session.status !== 'listening' && state.session.status !== 'paused') {
        return reject('Only an active session can be ended.');
      }
      const summary = summarize(state, context.now);
      return {
        ...state,
        session: {
          ...state.session,
          status: 'ended',
          pausedAt: null,
          endedAt: context.now,
          updatedAt: context.now
        },
        history: [...state.history, summary]
      };
    }
    case 'transcript/append': {
      requireActiveSession(state);
      if (state.transcript.segments.some((segment) => segment.id === action.segment.id)) {
        return reject(`Transcript segment "${action.segment.id}" already exists.`);
      }
      return {
        ...state,
        transcript: {
          revision: state.transcript.revision + 1,
          segments: [...state.transcript.segments, action.segment]
        }
      };
    }
    case 'transcript/finalize': {
      requireActiveSession(state);
      let found = false;
      const segments = state.transcript.segments.map((segment): TranscriptSegment => {
        if (segment.id !== action.segmentId) {
          return segment as TranscriptSegment;
        }
        if (segment.status === 'final') {
          return reject(`Transcript segment "${action.segmentId}" is already final.`);
        }
        found = true;
        return {
          ...segment,
          status: 'final',
          text: action.text ?? segment.text
        };
      });
      if (!found) {
        return reject(`Transcript segment "${action.segmentId}" does not exist.`);
      }
      return {
        ...state,
        transcript: {
          revision: state.transcript.revision + 1,
          segments
        }
      };
    }
    case 'insight/request': {
      if (state.session.status !== 'listening' && state.session.status !== 'paused') {
        return reject('Insights require an active session.');
      }
      if (action.transcriptRevision !== state.transcript.revision) {
        return reject('Insight requests must target the current transcript revision.');
      }
      if (action.transcriptRevision === 0) {
        return reject('An insight requires at least one transcript mutation.');
      }
      if (state.insights.items.some((item) => item.id === action.insightId)) {
        return reject(`Insight "${action.insightId}" already exists.`);
      }
      return {
        ...state,
        insights: {
          items: [
            ...state.insights.items,
            {
              id: action.insightId,
              transcriptRevision: action.transcriptRevision,
              status: 'pending',
              requestedAt: context.now,
              resolvedAt: null,
              text: null,
              error: null
            }
          ]
        }
      };
    }
    case 'insight/publish':
      return {
        ...state,
        insights: {
          items: replaceInsight(state.insights.items, action.insightId, (item) => {
            if (item.status !== 'pending') {
              return reject(`Insight "${action.insightId}" is not pending.`);
            }
            return {
              ...item,
              status: 'ready',
              resolvedAt: context.now,
              text: action.text,
              error: null
            };
          })
        }
      };
    case 'insight/fail':
      return {
        ...state,
        insights: {
          items: replaceInsight(state.insights.items, action.insightId, (item) => {
            if (item.status !== 'pending') {
              return reject(`Insight "${action.insightId}" is not pending.`);
            }
            return {
              ...item,
              status: 'error',
              resolvedAt: context.now,
              text: null,
              error: action.error
            };
          })
        }
      };
    case 'ui/toggle-overlay':
      return {
        ...state,
        ui: { ...state.ui, overlayVisible: !state.ui.overlayVisible }
      };
    case 'ui/set-active-view':
      return {
        ...state,
        ui: { ...state.ui, activeView: action.view }
      };
    case 'ui/set-command-bar':
      return {
        ...state,
        ui: {
          ...state.ui,
          commandBar: { open: action.open, query: action.query }
        }
      };
  }
}

export const authorizeAppAction: ActionAuthorizer<AppAction> = (action, actor) => {
  if (actor.kind === 'main') {
    return true;
  }
  return action.type !== 'insight/publish' && action.type !== 'insight/fail';
};

export const allowSynchronousAppAction: SyncActionPolicy<AppAction> = (action, actor) => {
  return actor.kind === 'renderer' && (
    action.type === 'ui/toggle-overlay'
    || action.type === 'ui/set-active-view'
    || action.type === 'ui/set-command-bar'
  );
};
