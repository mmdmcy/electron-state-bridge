import {
  ProtocolValidationError,
  StateBridgeError,
  errorPayload
} from '../core/errors.js';
import {
  parseCommitEnvelope,
  parseDispatchResponse,
  parseSnapshotEnvelope,
  parseSnapshotResponse
} from '../core/protocol.js';
import { cloneAndFreezeJson } from '../core/serializable.js';
import {
  STATE_BRIDGE_PROTOCOL_VERSION,
  type ActionRequest,
  type BridgeErrorPayload,
  type DeepReadonly,
  type DispatchAck,
  type OptionalSyncRendererStore,
  type RendererStoreMeta,
  type SnapshotEnvelope,
  type StateBridgeTransport,
  type StateValidator
} from '../core/types.js';

export interface RendererStoreClientOptions<State, Action> {
  readonly transport: StateBridgeTransport<Action>;
  readonly initialSnapshot: SnapshotEnvelope<State>;
  readonly validateState: StateValidator<State>;
  readonly clientId?: string;
  readonly requestIdFactory?: () => string;
  readonly now?: () => number;
  readonly onAsyncError?: (error: unknown) => void;
}

function randomIdentifier(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) {
    return `${prefix}-${uuid}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class RendererStoreClient<State, Action>
implements OptionalSyncRendererStore<State, Action> {
  readonly #transport: StateBridgeTransport<Action>;
  readonly #validateState: StateValidator<State>;
  readonly #clientId: string;
  readonly #requestIdFactory: () => string;
  readonly #now: () => number;
  readonly #onAsyncError: (error: unknown) => void;
  readonly #listeners = new Set<() => void>();
  readonly #metaListeners = new Set<() => void>();
  #snapshot: SnapshotEnvelope<State>;
  #meta: RendererStoreMeta;
  #transportUnsubscribe: (() => void) | null = null;
  #resyncPromise: Promise<void> | null = null;
  #resyncQueued = false;
  #requestCounter = 0;
  #destroyed = false;

  readonly ready: Promise<void>;

  constructor(options: RendererStoreClientOptions<State, Action>) {
    this.#transport = options.transport;
    this.#validateState = options.validateState;
    this.#clientId = options.clientId ?? randomIdentifier('renderer');
    this.#requestIdFactory = options.requestIdFactory ?? (() => {
      this.#requestCounter += 1;
      return `request-${this.#requestCounter}`;
    });
    this.#now = options.now ?? Date.now;
    this.#onAsyncError = options.onAsyncError ?? (() => undefined);
    this.#snapshot = parseSnapshotEnvelope(options.initialSnapshot, this.#validateState);
    this.#meta = this.#createMeta({
      revision: this.#snapshot.revision,
      status: 'booting',
      lastGap: null,
      lastError: null
    });

    this.#transportUnsubscribe = this.#transport.onCommit((commit) => {
      this.#handleCommit(commit);
    });
    this.ready = this.resync('initial-hydration');
  }

  getSnapshot = (): DeepReadonly<State> => this.#snapshot.state;
  getRevision = (): number => this.#snapshot.revision;
  getMetaSnapshot = (): RendererStoreMeta => this.#meta;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  subscribeMeta = (listener: () => void): (() => void) => {
    this.#metaListeners.add(listener);
    return () => {
      this.#metaListeners.delete(listener);
    };
  };

  async dispatch(action: Action): Promise<DispatchAck> {
    this.#assertLive();
    let rawResponse: unknown;
    try {
      rawResponse = await this.#transport.dispatch(this.#request(action));
      this.#assertLive();
    } catch (error) {
      const payload = errorPayload('TRANSPORT_ERROR', 'Asynchronous IPC dispatch failed.');
      this.#setMeta({ ...this.#meta, lastError: payload });
      throw new StateBridgeError(payload);
    }

    const response = this.#parseDispatch(rawResponse);
    if (!response.ok) {
      this.#setMeta({ ...this.#meta, lastError: response.error });
      throw new StateBridgeError(response.error);
    }

    this.#applyFullSnapshot(response.value.snapshot);
    return response.value.ack;
  }

  dispatchSync(action: Action): DispatchAck {
    this.#assertLive();
    let rawResponse: unknown;
    try {
      rawResponse = this.#transport.dispatchSync(this.#request(action));
    } catch (error) {
      const payload = errorPayload('TRANSPORT_ERROR', 'Synchronous IPC dispatch failed.');
      this.#setMeta({ ...this.#meta, lastError: payload });
      throw new StateBridgeError(payload);
    }

    const response = this.#parseDispatch(rawResponse);
    if (!response.ok) {
      this.#setMeta({ ...this.#meta, lastError: response.error });
      throw new StateBridgeError(response.error);
    }

    // The response carries the committed full snapshot, so a local read made
    // immediately after dispatchSync observes the commit before this call returns.
    this.#applyFullSnapshot(response.value.snapshot);
    return response.value.ack;
  }

  resync(reason = 'manual'): Promise<void> {
    this.#assertLive();
    if (this.#resyncPromise !== null) {
      return this.#resyncPromise;
    }

    this.#setMeta({ ...this.#meta, status: 'resyncing', lastError: null });
    const operation = this.#performResync(reason).finally(() => {
      if (this.#resyncPromise === operation) {
        this.#resyncPromise = null;
      }
      if (this.#resyncQueued && !this.#destroyed) {
        this.#resyncQueued = false;
        void this.resync('queued-revision-gap').catch((error: unknown) => {
          this.#reportAsyncError(error);
        });
      }
    });

    this.#resyncPromise = operation;
    return operation;
  }

  async #performResync(reason: string): Promise<void> {
    try {
      const rawResponse = await this.#transport.getSnapshot();
      if (this.#destroyed) {
        return;
      }
      const response = parseSnapshotResponse(rawResponse, this.#validateState);
      if (!response.ok) {
        throw new StateBridgeError(response.error);
      }
      this.#applyFullSnapshot(response.value.snapshot);
      this.#setMeta({ ...this.#meta, status: 'ready', lastError: null });
    } catch (error) {
      if (this.#destroyed) {
        return;
      }
      const payload = this.#errorFromUnknown(
        error,
        `Full state resynchronization failed (${reason}).`
      );
      this.#setMeta({ ...this.#meta, status: 'error', lastError: payload });
      throw error instanceof StateBridgeError ? error : new StateBridgeError(payload);
    }
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#transportUnsubscribe?.();
    this.#transportUnsubscribe = null;
    this.#listeners.clear();
    this.#setMeta({ ...this.#meta, status: 'destroyed' });
    this.#metaListeners.clear();
  }

  #request(action: Action): ActionRequest<Action> {
    return {
      protocolVersion: STATE_BRIDGE_PROTOCOL_VERSION,
      clientId: this.#clientId,
      requestId: this.#requestIdFactory(),
      action
    };
  }

  #handleCommit(rawCommit: unknown): void {
    if (this.#destroyed) {
      return;
    }

    try {
      const commit = parseCommitEnvelope(rawCommit, this.#validateState);
      if (commit.revision <= this.#snapshot.revision) {
        return;
      }

      const expected = this.#snapshot.revision + 1;
      if (commit.revision !== expected) {
        this.#setMeta({
          ...this.#meta,
          lastGap: {
            expected,
            received: commit.revision,
            detectedAt: this.#now()
          }
        });
        if (this.#resyncPromise !== null) {
          this.#resyncQueued = true;
        }
        void this.resync('revision-gap').catch((error: unknown) => {
          this.#reportAsyncError(error);
        });
        return;
      }

      this.#applyFullSnapshot(commit);
    } catch (error) {
      const payload = this.#errorFromUnknown(error, 'Renderer received a malformed commit event.');
      this.#setMeta({ ...this.#meta, lastError: payload });
      this.#reportAsyncError(new StateBridgeError(payload));
    }
  }

  #applyFullSnapshot(snapshot: SnapshotEnvelope<State>): void {
    if (snapshot.revision <= this.#snapshot.revision) {
      return;
    }
    this.#snapshot = snapshot;
    this.#setMeta({
      ...this.#meta,
      revision: snapshot.revision,
      status: this.#meta.status === 'booting' ? 'booting' : 'ready',
      lastError: null
    });
    this.#notify(this.#listeners);
  }

  #parseDispatch(rawResponse: unknown) {
    try {
      return parseDispatchResponse(rawResponse, this.#validateState);
    } catch (error) {
      const payload = this.#errorFromUnknown(error, 'Main process returned a malformed dispatch response.');
      this.#setMeta({ ...this.#meta, lastError: payload });
      throw new StateBridgeError(payload);
    }
  }

  #errorFromUnknown(error: unknown, fallbackMessage: string): BridgeErrorPayload {
    if (error instanceof StateBridgeError) {
      return {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      };
    }
    if (error instanceof ProtocolValidationError) {
      return errorPayload('TRANSPORT_ERROR', fallbackMessage, {
        protocolIssue: error.message
      });
    }
    return errorPayload('TRANSPORT_ERROR', fallbackMessage);
  }

  #setMeta(meta: RendererStoreMeta): void {
    this.#meta = this.#createMeta(meta);
    this.#notify(this.#metaListeners);
  }

  #notify(listeners: ReadonlySet<() => void>): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        this.#reportAsyncError(error);
      }
    }
  }

  #reportAsyncError(error: unknown): void {
    try {
      this.#onAsyncError(error);
    } catch {
      // Observer diagnostics must not break state propagation.
    }
  }

  #createMeta(meta: RendererStoreMeta): RendererStoreMeta {
    return cloneAndFreezeJson(meta, 'rendererStoreMeta') as RendererStoreMeta;
  }

  #assertLive(): void {
    if (this.#destroyed) {
      throw new StateBridgeError(
        errorPayload('TRANSPORT_ERROR', 'Renderer store has been destroyed.')
      );
    }
  }
}
