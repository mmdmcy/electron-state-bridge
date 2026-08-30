import {
  ProtocolValidationError,
  ReducerRejectedError,
  errorPayload
} from './errors.js';
import { parseActionRequest } from './protocol.js';
import {
  cloneAndFreezeJson,
  deepFreeze,
  jsonByteLength,
  stableJsonFingerprint
} from './serializable.js';
import {
  STATE_BRIDGE_PROTOCOL_VERSION,
  type ActionAuthorizer,
  type ActionRequest,
  type ActionValidator,
  type BridgeActor,
  type BridgeErrorPayload,
  type CommitEnvelope,
  type DeepReadonly,
  type DispatchResponse,
  type DispatchSuccess,
  type HostCommitListener,
  type SnapshotEnvelope,
  type StateReducer,
  type SyncActionPolicy
} from './types.js';

interface DedupeEntry<State> {
  readonly fingerprint: string;
  readonly result: DispatchSuccess<State>;
}

export interface CanonicalStateHostOptions<State, Action> {
  readonly initialState: State;
  readonly reduce: StateReducer<State, Action>;
  readonly validateAction: ActionValidator<Action>;
  readonly authorize?: ActionAuthorizer<Action>;
  readonly allowSync?: SyncActionPolicy<Action>;
  readonly clock?: () => number;
  readonly maxDedupeEntries?: number;
  readonly onListenerError?: (error: unknown) => void;
  readonly maxSyncSnapshotBytes?: number;
}

export class CanonicalStateHost<State, Action> {
  readonly #reduce: StateReducer<State, Action>;
  readonly #validateAction: ActionValidator<Action>;
  readonly #authorize: ActionAuthorizer<Action>;
  readonly #allowSync: SyncActionPolicy<Action>;
  readonly #clock: () => number;
  readonly #maxDedupeEntries: number;
  readonly #onListenerError: (error: unknown) => void;
  readonly #maxSyncSnapshotBytes: number;
  readonly #listeners = new Set<HostCommitListener<State, Action>>();
  readonly #dedupe = new Map<string, DedupeEntry<State>>();
  #snapshot: SnapshotEnvelope<State>;
  #snapshotSizeBytes: number;
  #internalRequestCounter = 0;

  constructor(options: CanonicalStateHostOptions<State, Action>) {
    this.#reduce = options.reduce;
    this.#validateAction = options.validateAction;
    this.#authorize = options.authorize ?? (() => true);
    this.#allowSync = options.allowSync ?? (() => false);
    this.#clock = options.clock ?? Date.now;
    this.#maxDedupeEntries = options.maxDedupeEntries ?? 2_048;
    this.#onListenerError = options.onListenerError ?? (() => undefined);
    this.#maxSyncSnapshotBytes = options.maxSyncSnapshotBytes ?? 64 * 1_024;

    if (!Number.isSafeInteger(this.#maxDedupeEntries) || this.#maxDedupeEntries < 1) {
      throw new Error('maxDedupeEntries must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(this.#maxSyncSnapshotBytes) || this.#maxSyncSnapshotBytes < 1) {
      throw new Error('maxSyncSnapshotBytes must be a positive safe integer.');
    }

    this.#snapshot = cloneAndFreezeJson(
      {
        protocolVersion: STATE_BRIDGE_PROTOCOL_VERSION,
        revision: 0,
        state: options.initialState
      },
      'initialSnapshot'
    ) as SnapshotEnvelope<State>;
    this.#snapshotSizeBytes = jsonByteLength(this.#snapshot);
  }

  getSnapshot = (): SnapshotEnvelope<State> => this.#snapshot;
  getSnapshotSizeBytes = (): number => this.#snapshotSizeBytes;

  subscribe(listener: HostCommitListener<State, Action>): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async dispatch(
    request: unknown,
    actor: BridgeActor
  ): Promise<DispatchResponse<State>> {
    return this.#commitRequest(request, actor, 'async');
  }

  dispatchSync(request: unknown, actor: BridgeActor): DispatchResponse<State> {
    return this.#commitRequest(request, actor, 'sync');
  }

  dispatchInternal(action: Action, label = 'effect'): DispatchResponse<State> {
    this.#internalRequestCounter += 1;
    const request: ActionRequest<Action> = {
      protocolVersion: STATE_BRIDGE_PROTOCOL_VERSION,
      clientId: 'main',
      requestId: `internal-${this.#internalRequestCounter}`,
      action
    };
    return this.#commitRequest(request, { kind: 'main', id: label }, 'async');
  }

  #commitRequest(
    rawRequest: unknown,
    actor: BridgeActor,
    mode: 'async' | 'sync'
  ): DispatchResponse<State> {
    try {
      const request = parseActionRequest(rawRequest, this.#validateAction);

      if (!this.#authorize(request.action, actor)) {
        return this.#failure(
          'UNAUTHORIZED_ACTION',
          `Action "${this.#actionType(request.action)}" is not authorized for ${actor.kind} actors.`
        );
      }

      if (mode === 'sync' && !this.#allowSync(request.action, actor)) {
        return this.#failure(
          'SYNC_ACTION_NOT_ALLOWED',
          `Action "${this.#actionType(request.action)}" is not allowed on the blocking dispatch path.`
        );
      }

      const dedupeKey = JSON.stringify([
        actor.kind,
        actor.id,
        request.clientId,
        request.requestId
      ]);
      const fingerprint = stableJsonFingerprint(request.action);
      const prior = this.#dedupe.get(dedupeKey);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          return this.#failure(
            'REQUEST_ID_REUSE',
            'A requestId may not be reused for a different action.'
          );
        }
        return deepFreeze({
          ok: true,
          value: { ...prior.result, duplicate: true }
        }) as DispatchResponse<State>;
      }

      if (mode === 'sync' && this.#snapshotSizeBytes > this.#maxSyncSnapshotBytes) {
        return this.#failure(
          'SYNC_ACTION_NOT_ALLOWED',
          `The current snapshot exceeds the ${this.#maxSyncSnapshotBytes}-byte synchronous budget.`
        );
      }

      const now = this.#clock();
      if (!Number.isFinite(now) || now < 0) {
        throw new Error('Clock returned an invalid timestamp.');
      }

      const nextRevision = this.#snapshot.revision + 1;
      const nextState = this.#reduce(this.#snapshot.state, request.action, {
        now,
        nextRevision,
        actor
      });

      const snapshot = cloneAndFreezeJson(
        {
          protocolVersion: STATE_BRIDGE_PROTOCOL_VERSION,
          revision: nextRevision,
          state: nextState
        },
        'committedSnapshot'
      ) as SnapshotEnvelope<State>;

      const snapshotSizeBytes = jsonByteLength(snapshot);
      if (mode === 'sync' && snapshotSizeBytes > this.#maxSyncSnapshotBytes) {
        return this.#failure(
          'SYNC_ACTION_NOT_ALLOWED',
          `The committed snapshot would exceed the ${this.#maxSyncSnapshotBytes}-byte synchronous budget.`
        );
      }

      const commit = cloneAndFreezeJson(
        {
          ...snapshot,
          actionType: this.#actionType(request.action),
          committedAt: now,
          source: actor.kind
        },
        'commit'
      ) as CommitEnvelope<State>;

      this.#snapshot = snapshot;
      this.#snapshotSizeBytes = snapshotSizeBytes;
      const result = deepFreeze({
        ack: { revision: nextRevision },
        snapshot,
        duplicate: false
      }) as DispatchSuccess<State>;
      this.#remember(dedupeKey, { fingerprint, result });
      this.#publish(commit, request.action, actor);
      return deepFreeze({ ok: true, value: result }) as DispatchResponse<State>;
    } catch (error) {
      return { ok: false, error: this.#mapError(error) };
    }
  }

  #publish(commit: CommitEnvelope<State>, action: Action, actor: BridgeActor): void {
    const listeners = [...this.#listeners];
    globalThis.setTimeout(() => {
      for (const listener of listeners) {
        if (!this.#listeners.has(listener)) {
          continue;
        }
        try {
          listener({ commit, action, actor });
        } catch (error) {
          this.#onListenerError(error);
        }
      }
    }, 0);
  }

  #remember(key: string, entry: DedupeEntry<State>): void {
    this.#dedupe.set(key, entry);
    while (this.#dedupe.size > this.#maxDedupeEntries) {
      const oldest = this.#dedupe.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.#dedupe.delete(oldest);
    }
  }

  #actionType(action: Action): string {
    if (
      action !== null
      && typeof action === 'object'
      && 'type' in action
      && typeof (action as { readonly type?: unknown }).type === 'string'
    ) {
      return (action as { readonly type: string }).type;
    }
    return 'unknown';
  }

  #failure(code: BridgeErrorPayload['code'], message: string): DispatchResponse<State> {
    return { ok: false, error: errorPayload(code, message) };
  }

  #mapError(error: unknown): BridgeErrorPayload {
    if (error instanceof ProtocolValidationError) {
      return errorPayload(error.code, error.message);
    }
    if (error instanceof ReducerRejectedError) {
      return errorPayload('REDUCER_REJECTED', error.message);
    }
    return errorPayload(
      'INTERNAL_ERROR',
      'The main-process state host could not commit the action.'
    );
  }
}

export type CanonicalSnapshot<State> = DeepReadonly<SnapshotEnvelope<State>>;
