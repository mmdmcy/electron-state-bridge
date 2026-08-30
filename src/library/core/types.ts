export const STATE_BRIDGE_PROTOCOL_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type DeepReadonly<T> =
  T extends JsonPrimitive ? T
    : T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[]
      : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : never;

export interface SnapshotEnvelope<State> {
  readonly protocolVersion: typeof STATE_BRIDGE_PROTOCOL_VERSION;
  readonly revision: number;
  readonly state: DeepReadonly<State>;
}

export interface CommitEnvelope<State> extends SnapshotEnvelope<State> {
  readonly actionType: string;
  readonly committedAt: number;
  readonly source: 'renderer' | 'main';
}

export interface DispatchAck {
  readonly revision: number;
}

export interface ActionRequest<Action> {
  readonly protocolVersion: typeof STATE_BRIDGE_PROTOCOL_VERSION;
  readonly clientId: string;
  readonly requestId: string;
  readonly action: Action;
}

export type BridgeErrorCode =
  | 'PROTOCOL_MISMATCH'
  | 'VALIDATION_ERROR'
  | 'NON_SERIALIZABLE_VALUE'
  | 'UNTRUSTED_SENDER'
  | 'UNAUTHORIZED_ACTION'
  | 'SYNC_ACTION_NOT_ALLOWED'
  | 'REQUEST_ID_REUSE'
  | 'REDUCER_REJECTED'
  | 'INTERNAL_ERROR'
  | 'TRANSPORT_ERROR';

export interface BridgeErrorPayload {
  readonly code: BridgeErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export interface DispatchSuccess<State> {
  readonly ack: DispatchAck;
  readonly snapshot: SnapshotEnvelope<State>;
  readonly duplicate: boolean;
}

export type DispatchResponse<State> =
  | { readonly ok: true; readonly value: DispatchSuccess<State> }
  | { readonly ok: false; readonly error: BridgeErrorPayload };

export type SnapshotResponse<State> =
  | { readonly ok: true; readonly value: { readonly snapshot: SnapshotEnvelope<State> } }
  | { readonly ok: false; readonly error: BridgeErrorPayload };

export interface BridgeActor {
  readonly kind: 'renderer' | 'main';
  readonly id: string;
}

export interface ReducerContext {
  readonly now: number;
  readonly nextRevision: number;
  readonly actor: BridgeActor;
}

export type StateReducer<State, Action> = (
  state: DeepReadonly<State>,
  action: Action,
  context: ReducerContext
) => State;

export type ActionValidator<Action> = (input: unknown) => Action;
export type StateValidator<State> = (input: unknown) => State;
export type ActionAuthorizer<Action> = (action: Action, actor: BridgeActor) => boolean;
export type SyncActionPolicy<Action> = (action: Action, actor: BridgeActor) => boolean;

export interface HostCommitEvent<State, Action> {
  readonly commit: CommitEnvelope<State>;
  readonly action: Action;
  readonly actor: BridgeActor;
}

export type HostCommitListener<State, Action> = (
  event: HostCommitEvent<State, Action>
) => void;

export interface RendererStore<State, Action> {
  getSnapshot(): DeepReadonly<State>;
  subscribe(listener: () => void): () => void;
  dispatch(action: Action): Promise<DispatchAck>;
}

export interface OptionalSyncRendererStore<State, Action>
  extends RendererStore<State, Action> {
  dispatchSync(action: Action): DispatchAck;
}

export type RendererStoreStatus =
  | 'booting'
  | 'ready'
  | 'resyncing'
  | 'error'
  | 'destroyed';

export interface RevisionGap {
  readonly expected: number;
  readonly received: number;
  readonly detectedAt: number;
}

export interface RendererStoreMeta {
  readonly revision: number;
  readonly status: RendererStoreStatus;
  readonly lastGap: RevisionGap | null;
  readonly lastError: BridgeErrorPayload | null;
}

export interface StateBridgeTransport<Action> {
  getSnapshot(): Promise<unknown>;
  dispatch(request: ActionRequest<Action>): Promise<unknown>;
  dispatchSync(request: ActionRequest<Action>): unknown;
  onCommit(listener: (commit: unknown) => void): () => void;
}
