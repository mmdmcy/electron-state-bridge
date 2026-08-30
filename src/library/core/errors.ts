import type { BridgeErrorCode, BridgeErrorPayload, JsonValue } from './types.js';

const MAX_ERROR_MESSAGE_LENGTH = 500;
const ERROR_MESSAGE_TRUNCATION_SUFFIX = '…';

function boundedErrorMessage(message: string): string {
  if (message.length === 0) {
    return 'State bridge request failed.';
  }
  if (message.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return message;
  }
  const truncated = message.slice(
    0,
    MAX_ERROR_MESSAGE_LENGTH - ERROR_MESSAGE_TRUNCATION_SUFFIX.length
  );
  return `${truncated}${ERROR_MESSAGE_TRUNCATION_SUFFIX}`;
}

export class StateBridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly details: Readonly<Record<string, JsonValue>> | undefined;

  constructor(payload: BridgeErrorPayload) {
    super(payload.message);
    this.name = 'StateBridgeError';
    this.code = payload.code;
    this.details = payload.details;
  }
}

export class ReducerRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReducerRejectedError';
  }
}

export class ProtocolValidationError extends Error {
  readonly code: Extract<
    BridgeErrorCode,
    'PROTOCOL_MISMATCH' | 'VALIDATION_ERROR' | 'NON_SERIALIZABLE_VALUE'
  >;

  constructor(
    code: Extract<
      BridgeErrorCode,
      'PROTOCOL_MISMATCH' | 'VALIDATION_ERROR' | 'NON_SERIALIZABLE_VALUE'
    >,
    message: string
  ) {
    super(message);
    this.name = 'ProtocolValidationError';
    this.code = code;
  }
}

export function errorPayload(
  code: BridgeErrorCode,
  message: string,
  details?: Readonly<Record<string, JsonValue>>
): BridgeErrorPayload {
  const boundedMessage = boundedErrorMessage(message);
  return details === undefined
    ? { code, message: boundedMessage }
    : { code, message: boundedMessage, details };
}
