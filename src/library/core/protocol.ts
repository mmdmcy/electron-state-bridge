import { ProtocolValidationError } from './errors.js';
import { cloneAndFreezeJson, cloneJson } from './serializable.js';
import {
  STATE_BRIDGE_PROTOCOL_VERSION,
  type ActionRequest,
  type ActionValidator,
  type BridgeErrorCode,
  type BridgeErrorPayload,
  type CommitEnvelope,
  type DispatchResponse,
  type DispatchSuccess,
  type JsonValue,
  type SnapshotEnvelope,
  type SnapshotResponse,
  type StateValidator
} from './types.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ERROR_CODES = new Set<BridgeErrorCode>([
  'PROTOCOL_MISMATCH',
  'VALIDATION_ERROR',
  'NON_SERIALIZABLE_VALUE',
  'UNTRUSTED_SENDER',
  'UNAUTHORIZED_ACTION',
  'SYNC_ACTION_NOT_ALLOWED',
  'REQUEST_ID_REUSE',
  'REDUCER_REJECTED',
  'INTERNAL_ERROR',
  'TRANSPORT_ERROR'
]);

function record(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProtocolValidationError('VALIDATION_ERROR', `${label} must be an object.`);
  }
  return input as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allowedSet.has(key));
  if (extra !== undefined) {
    throw new ProtocolValidationError(
      'VALIDATION_ERROR',
      `${label} contains the unsupported field "${extra}".`
    );
  }
}

function protocolVersion(value: unknown): typeof STATE_BRIDGE_PROTOCOL_VERSION {
  if (value !== STATE_BRIDGE_PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      'PROTOCOL_MISMATCH',
      `Expected protocol version ${STATE_BRIDGE_PROTOCOL_VERSION}.`
    );
  }
  return STATE_BRIDGE_PROTOCOL_VERSION;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ProtocolValidationError(
      'VALIDATION_ERROR',
      `${label} must be 1-96 safe identifier characters.`
    );
  }
  return value;
}

function revision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProtocolValidationError(
      'VALIDATION_ERROR',
      `${label} must be a non-negative safe integer.`
    );
  }
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ProtocolValidationError(
      'VALIDATION_ERROR',
      `${label} must be a non-negative finite number.`
    );
  }
  return value;
}

export function parseActionRequest<Action>(
  input: unknown,
  validateAction: ActionValidator<Action>
): ActionRequest<Action> {
  const value = record(input, 'Action request');
  exactKeys(value, ['protocolVersion', 'clientId', 'requestId', 'action'], 'Action request');

  const action = validateAction(cloneJson(value.action, 'request.action'));
  return cloneAndFreezeJson(
    {
      protocolVersion: protocolVersion(value.protocolVersion),
      clientId: identifier(value.clientId, 'clientId'),
      requestId: identifier(value.requestId, 'requestId'),
      action
    },
    'request'
  ) as ActionRequest<Action>;
}

export function parseSnapshotEnvelope<State>(
  input: unknown,
  validateState: StateValidator<State>
): SnapshotEnvelope<State> {
  const value = record(input, 'Snapshot');
  exactKeys(value, ['protocolVersion', 'revision', 'state'], 'Snapshot');
  const state = validateState(cloneJson(value.state, 'snapshot.state'));

  return cloneAndFreezeJson(
    {
      protocolVersion: protocolVersion(value.protocolVersion),
      revision: revision(value.revision, 'snapshot.revision'),
      state
    },
    'snapshot'
  ) as SnapshotEnvelope<State>;
}

export function parseCommitEnvelope<State>(
  input: unknown,
  validateState: StateValidator<State>
): CommitEnvelope<State> {
  const value = record(input, 'Commit');
  exactKeys(
    value,
    ['protocolVersion', 'revision', 'state', 'actionType', 'committedAt', 'source'],
    'Commit'
  );

  if (typeof value.actionType !== 'string' || value.actionType.length === 0 || value.actionType.length > 128) {
    throw new ProtocolValidationError(
      'VALIDATION_ERROR',
      'commit.actionType must be a non-empty string up to 128 characters.'
    );
  }
  if (value.source !== 'renderer' && value.source !== 'main') {
    throw new ProtocolValidationError('VALIDATION_ERROR', 'commit.source is invalid.');
  }

  const state = validateState(cloneJson(value.state, 'commit.state'));
  return cloneAndFreezeJson(
    {
      protocolVersion: protocolVersion(value.protocolVersion),
      revision: revision(value.revision, 'commit.revision'),
      state,
      actionType: value.actionType,
      committedAt: timestamp(value.committedAt, 'commit.committedAt'),
      source: value.source
    },
    'commit'
  ) as CommitEnvelope<State>;
}

export function parseBridgeErrorPayload(input: unknown): BridgeErrorPayload {
  const value = record(input, 'Bridge error');
  exactKeys(value, ['code', 'message', 'details'], 'Bridge error');

  if (typeof value.code !== 'string' || !ERROR_CODES.has(value.code as BridgeErrorCode)) {
    throw new ProtocolValidationError('VALIDATION_ERROR', 'Bridge error code is invalid.');
  }
  if (typeof value.message !== 'string' || value.message.length === 0 || value.message.length > 500) {
    throw new ProtocolValidationError('VALIDATION_ERROR', 'Bridge error message is invalid.');
  }

  const details = value.details === undefined
    ? undefined
    : cloneAndFreezeJson(record(value.details, 'Bridge error details'));

  return details === undefined
    ? { code: value.code as BridgeErrorCode, message: value.message }
    : {
        code: value.code as BridgeErrorCode,
        message: value.message,
        details: details as Readonly<Record<string, JsonValue>>
      };
}

function parseDispatchSuccess<State>(
  input: unknown,
  validateState: StateValidator<State>
): DispatchSuccess<State> {
  const value = record(input, 'Dispatch success');
  exactKeys(value, ['ack', 'snapshot', 'duplicate'], 'Dispatch success');
  const ack = record(value.ack, 'Dispatch acknowledgement');
  exactKeys(ack, ['revision'], 'Dispatch acknowledgement');
  if (typeof value.duplicate !== 'boolean') {
    throw new ProtocolValidationError('VALIDATION_ERROR', 'Dispatch duplicate flag is invalid.');
  }

  const parsedSnapshot = parseSnapshotEnvelope(value.snapshot, validateState);
  const ackRevision = revision(ack.revision, 'ack.revision');
  if (ackRevision !== parsedSnapshot.revision) {
    throw new ProtocolValidationError(
      'VALIDATION_ERROR',
      'Dispatch acknowledgement and snapshot revisions do not match.'
    );
  }

  return {
    ack: { revision: ackRevision },
    snapshot: parsedSnapshot,
    duplicate: value.duplicate
  };
}

export function parseDispatchResponse<State>(
  input: unknown,
  validateState: StateValidator<State>
): DispatchResponse<State> {
  const value = record(input, 'Dispatch response');
  if (value.ok === true) {
    exactKeys(value, ['ok', 'value'], 'Dispatch response');
    return { ok: true, value: parseDispatchSuccess(value.value, validateState) };
  }
  if (value.ok === false) {
    exactKeys(value, ['ok', 'error'], 'Dispatch response');
    return { ok: false, error: parseBridgeErrorPayload(value.error) };
  }
  throw new ProtocolValidationError('VALIDATION_ERROR', 'Dispatch response has no valid ok flag.');
}

export function parseSnapshotResponse<State>(
  input: unknown,
  validateState: StateValidator<State>
): SnapshotResponse<State> {
  const value = record(input, 'Snapshot response');
  if (value.ok === true) {
    exactKeys(value, ['ok', 'value'], 'Snapshot response');
    const success = record(value.value, 'Snapshot response value');
    exactKeys(success, ['snapshot'], 'Snapshot response value');
    return {
      ok: true,
      value: { snapshot: parseSnapshotEnvelope(success.snapshot, validateState) }
    };
  }
  if (value.ok === false) {
    exactKeys(value, ['ok', 'error'], 'Snapshot response');
    return { ok: false, error: parseBridgeErrorPayload(value.error) };
  }
  throw new ProtocolValidationError('VALIDATION_ERROR', 'Snapshot response has no valid ok flag.');
}
