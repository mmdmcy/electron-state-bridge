import { ProtocolValidationError } from '../../library/core/errors.js';
import type {
  ActiveView,
  AppAction,
  AppState,
  InsightItem,
  SessionState,
  SessionSummary,
  TranscriptSegment,
  TranscriptSpeaker,
  TranscriptState,
  UiState
} from './types.js';

function fail(message: string): never {
  throw new ProtocolValidationError('VALIDATION_ERROR', message);
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return fail(`${label} must be an object.`);
  }
  return input as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra !== undefined) {
    fail(`${label} contains the unsupported field "${extra}".`);
  }
}

function text(
  input: unknown,
  label: string,
  minimum = 1,
  maximum = 2_000
): string {
  if (typeof input !== 'string') {
    return fail(`${label} must be a string.`);
  }
  const normalized = input.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    return fail(`${label} must contain ${minimum}-${maximum} characters.`);
  }
  return normalized;
}

function boolean(input: unknown, label: string): boolean {
  if (typeof input !== 'boolean') {
    return fail(`${label} must be a boolean.`);
  }
  return input;
}

function integer(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    return fail(`${label} must be a non-negative safe integer.`);
  }
  return input as number;
}

function timestamp(input: unknown, label: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
    return fail(`${label} must be a non-negative finite timestamp.`);
  }
  return input;
}

function nullableTimestamp(input: unknown, label: string): number | null {
  return input === null ? null : timestamp(input, label);
}

function nullableText(input: unknown, label: string, maximum = 2_000): string | null {
  return input === null ? null : text(input, label, 1, maximum);
}

function oneOf<const Values extends readonly string[]>(
  input: unknown,
  values: Values,
  label: string
): Values[number] {
  if (typeof input !== 'string' || !values.includes(input)) {
    return fail(`${label} is invalid.`);
  }
  return input as Values[number];
}

function stringId(input: unknown, label: string): string {
  const value = text(input, label, 1, 96);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value)) {
    return fail(`${label} contains unsupported characters.`);
  }
  return value;
}

function transcriptSegment(input: unknown, label: string): TranscriptSegment {
  const value = record(input, label);
  exactKeys(value, ['id', 'speaker', 'text', 'timestamp', 'status'], label);
  return {
    id: stringId(value.id, `${label}.id`),
    speaker: oneOf(
      value.speaker,
      ['host', 'guest', 'assistant'] as const,
      `${label}.speaker`
    ) as TranscriptSpeaker,
    text: text(value.text, `${label}.text`, 1, 2_000),
    timestamp: timestamp(value.timestamp, `${label}.timestamp`),
    status: oneOf(value.status, ['interim', 'final'] as const, `${label}.status`)
  };
}

function sessionState(input: unknown): SessionState {
  const value = record(input, 'state.session');
  exactKeys(
    value,
    ['status', 'id', 'startedAt', 'pausedAt', 'endedAt', 'updatedAt'],
    'state.session'
  );
  return {
    status: oneOf(
      value.status,
      ['idle', 'listening', 'paused', 'ended'] as const,
      'state.session.status'
    ),
    id: value.id === null ? null : stringId(value.id, 'state.session.id'),
    startedAt: nullableTimestamp(value.startedAt, 'state.session.startedAt'),
    pausedAt: nullableTimestamp(value.pausedAt, 'state.session.pausedAt'),
    endedAt: nullableTimestamp(value.endedAt, 'state.session.endedAt'),
    updatedAt: nullableTimestamp(value.updatedAt, 'state.session.updatedAt')
  };
}

function transcriptState(input: unknown): TranscriptState {
  const value = record(input, 'state.transcript');
  exactKeys(value, ['revision', 'segments'], 'state.transcript');
  if (!Array.isArray(value.segments)) {
    return fail('state.transcript.segments must be an array.');
  }
  return {
    revision: integer(value.revision, 'state.transcript.revision'),
    segments: value.segments.map((segment, index) =>
      transcriptSegment(segment, `state.transcript.segments[${index}]`)
    )
  };
}

function insightItem(input: unknown, index: number): InsightItem {
  const label = `state.insights.items[${index}]`;
  const value = record(input, label);
  exactKeys(
    value,
    [
      'id',
      'transcriptRevision',
      'status',
      'requestedAt',
      'resolvedAt',
      'text',
      'error'
    ],
    label
  );
  return {
    id: stringId(value.id, `${label}.id`),
    transcriptRevision: integer(value.transcriptRevision, `${label}.transcriptRevision`),
    status: oneOf(value.status, ['pending', 'ready', 'error'] as const, `${label}.status`),
    requestedAt: timestamp(value.requestedAt, `${label}.requestedAt`),
    resolvedAt: nullableTimestamp(value.resolvedAt, `${label}.resolvedAt`),
    text: nullableText(value.text, `${label}.text`),
    error: nullableText(value.error, `${label}.error`, 500)
  };
}

function uiState(input: unknown): UiState {
  const value = record(input, 'state.ui');
  exactKeys(value, ['overlayVisible', 'activeView', 'commandBar'], 'state.ui');
  const commandBar = record(value.commandBar, 'state.ui.commandBar');
  exactKeys(commandBar, ['open', 'query'], 'state.ui.commandBar');
  return {
    overlayVisible: boolean(value.overlayVisible, 'state.ui.overlayVisible'),
    activeView: oneOf(
      value.activeView,
      ['transcript', 'insights', 'history'] as const,
      'state.ui.activeView'
    ) as ActiveView,
    commandBar: {
      open: boolean(commandBar.open, 'state.ui.commandBar.open'),
      query: typeof commandBar.query === 'string'
        ? text(commandBar.query, 'state.ui.commandBar.query', 0, 160)
        : fail('state.ui.commandBar.query must be a string.')
    }
  };
}

function summary(input: unknown, index: number): SessionSummary {
  const label = `state.history[${index}]`;
  const value = record(input, label);
  exactKeys(
    value,
    [
      'id',
      'sessionId',
      'startedAt',
      'endedAt',
      'segmentCount',
      'finalSegmentCount',
      'readyInsightCount',
      'preview'
    ],
    label
  );
  return {
    id: stringId(value.id, `${label}.id`),
    sessionId: stringId(value.sessionId, `${label}.sessionId`),
    startedAt: timestamp(value.startedAt, `${label}.startedAt`),
    endedAt: timestamp(value.endedAt, `${label}.endedAt`),
    segmentCount: integer(value.segmentCount, `${label}.segmentCount`),
    finalSegmentCount: integer(value.finalSegmentCount, `${label}.finalSegmentCount`),
    readyInsightCount: integer(value.readyInsightCount, `${label}.readyInsightCount`),
    preview: typeof value.preview === 'string'
      ? text(value.preview, `${label}.preview`, 0, 180)
      : fail(`${label}.preview must be a string.`)
  };
}

export function validateAppState(input: unknown): AppState {
  const value = record(input, 'state');
  exactKeys(value, ['session', 'transcript', 'insights', 'ui', 'history'], 'state');
  const insights = record(value.insights, 'state.insights');
  exactKeys(insights, ['items'], 'state.insights');
  if (!Array.isArray(insights.items)) {
    return fail('state.insights.items must be an array.');
  }
  if (!Array.isArray(value.history)) {
    return fail('state.history must be an array.');
  }

  return {
    session: sessionState(value.session),
    transcript: transcriptState(value.transcript),
    insights: {
      items: insights.items.map((item, index) => insightItem(item, index))
    },
    ui: uiState(value.ui),
    history: value.history.map((item, index) => summary(item, index))
  };
}

export function validateAppAction(input: unknown): AppAction {
  const value = record(input, 'action');
  if (typeof value.type !== 'string') {
    return fail('action.type must be a string.');
  }

  switch (value.type) {
    case 'session/start':
      exactKeys(value, ['type', 'sessionId'], 'session/start');
      return { type: value.type, sessionId: stringId(value.sessionId, 'sessionId') };
    case 'session/pause':
    case 'session/resume':
    case 'session/end':
    case 'ui/toggle-overlay':
      exactKeys(value, ['type'], value.type);
      return { type: value.type };
    case 'transcript/append':
      exactKeys(value, ['type', 'segment'], value.type);
      return { type: value.type, segment: transcriptSegment(value.segment, 'segment') };
    case 'transcript/finalize': {
      exactKeys(value, ['type', 'segmentId', 'text'], value.type);
      const result: {
        type: 'transcript/finalize';
        segmentId: string;
        text?: string;
      } = {
        type: value.type,
        segmentId: stringId(value.segmentId, 'segmentId')
      };
      if (value.text !== undefined) {
        result.text = text(value.text, 'text', 1, 2_000);
      }
      return result;
    }
    case 'insight/request':
      exactKeys(value, ['type', 'insightId', 'transcriptRevision'], value.type);
      return {
        type: value.type,
        insightId: stringId(value.insightId, 'insightId'),
        transcriptRevision: integer(value.transcriptRevision, 'transcriptRevision')
      };
    case 'insight/publish':
      exactKeys(value, ['type', 'insightId', 'text'], value.type);
      return {
        type: value.type,
        insightId: stringId(value.insightId, 'insightId'),
        text: text(value.text, 'text', 1, 2_000)
      };
    case 'insight/fail':
      exactKeys(value, ['type', 'insightId', 'error'], value.type);
      return {
        type: value.type,
        insightId: stringId(value.insightId, 'insightId'),
        error: text(value.error, 'error', 1, 500)
      };
    case 'ui/set-active-view':
      exactKeys(value, ['type', 'view'], value.type);
      return {
        type: value.type,
        view: oneOf(
          value.view,
          ['transcript', 'insights', 'history'] as const,
          'view'
        )
      };
    case 'ui/set-command-bar':
      exactKeys(value, ['type', 'open', 'query'], value.type);
      return {
        type: value.type,
        open: boolean(value.open, 'open'),
        query: typeof value.query === 'string'
          ? text(value.query, 'query', 0, 160)
          : fail('query must be a string.')
      };
    default:
      return fail(`Unsupported action type "${value.type}".`);
  }
}
