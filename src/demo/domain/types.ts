export type SessionStatus = 'idle' | 'listening' | 'paused' | 'ended';
export type TranscriptSpeaker = 'host' | 'guest' | 'assistant';
export type TranscriptSegmentStatus = 'interim' | 'final';
export type InsightStatus = 'pending' | 'ready' | 'error';
export type ActiveView = 'transcript' | 'insights' | 'history';

export interface SessionState {
  readonly status: SessionStatus;
  readonly id: string | null;
  readonly startedAt: number | null;
  readonly pausedAt: number | null;
  readonly endedAt: number | null;
  readonly updatedAt: number | null;
}

export interface TranscriptSegment {
  readonly id: string;
  readonly speaker: TranscriptSpeaker;
  readonly text: string;
  readonly timestamp: number;
  readonly status: TranscriptSegmentStatus;
}

export interface TranscriptState {
  readonly revision: number;
  readonly segments: readonly TranscriptSegment[];
}

export interface InsightItem {
  readonly id: string;
  readonly transcriptRevision: number;
  readonly status: InsightStatus;
  readonly requestedAt: number;
  readonly resolvedAt: number | null;
  readonly text: string | null;
  readonly error: string | null;
}

export interface InsightsState {
  readonly items: readonly InsightItem[];
}

export interface CommandBarState {
  readonly open: boolean;
  readonly query: string;
}

export interface UiState {
  readonly overlayVisible: boolean;
  readonly activeView: ActiveView;
  readonly commandBar: CommandBarState;
}

export interface SessionSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly segmentCount: number;
  readonly finalSegmentCount: number;
  readonly readyInsightCount: number;
  readonly preview: string;
}

export interface AppState {
  readonly session: SessionState;
  readonly transcript: TranscriptState;
  readonly insights: InsightsState;
  readonly ui: UiState;
  readonly history: readonly SessionSummary[];
}

export type AppAction =
  | { readonly type: 'session/start'; readonly sessionId: string }
  | { readonly type: 'session/pause' }
  | { readonly type: 'session/resume' }
  | { readonly type: 'session/end' }
  | { readonly type: 'transcript/append'; readonly segment: TranscriptSegment }
  | {
      readonly type: 'transcript/finalize';
      readonly segmentId: string;
      readonly text?: string;
    }
  | {
      readonly type: 'insight/request';
      readonly insightId: string;
      readonly transcriptRevision: number;
    }
  | {
      readonly type: 'insight/publish';
      readonly insightId: string;
      readonly text: string;
    }
  | {
      readonly type: 'insight/fail';
      readonly insightId: string;
      readonly error: string;
    }
  | { readonly type: 'ui/toggle-overlay' }
  | { readonly type: 'ui/set-active-view'; readonly view: ActiveView }
  | {
      readonly type: 'ui/set-command-bar';
      readonly open: boolean;
      readonly query: string;
    };

export function createInitialAppState(): AppState {
  return {
    session: {
      status: 'idle',
      id: null,
      startedAt: null,
      pausedAt: null,
      endedAt: null,
      updatedAt: null
    },
    transcript: {
      revision: 0,
      segments: []
    },
    insights: {
      items: []
    },
    ui: {
      overlayVisible: true,
      activeView: 'transcript',
      commandBar: {
        open: false,
        query: ''
      }
    },
    history: []
  };
}
