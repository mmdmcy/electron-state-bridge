# Design

## Objective

Provide one reusable Electron state manager in which the main process owns the
canonical state, every renderer has an immediately readable immutable snapshot,
mutations are typed actions, commits are ordered and acknowledged, React uses a
real external-store hook, and a dropped event is recoverable.

The optional blocking facade is part of the same protocol. It is not a second
architecture.

## Components

### `CanonicalStateHost<State, Action>`

Process-agnostic and synchronous internally. A call validates one request,
checks authorization, checks the sync policy when applicable, runs one pure
reducer against the current snapshot, assigns `revision + 1`, deep-clones and
freezes the result, remembers the request for bounded deduplication, schedules
one commit event outside the dispatch call stack, and returns an acknowledgement
plus the full committed snapshot.

There is no `await` between reading the current snapshot and installing the
next one. JavaScript run-to-completion therefore gives requests a total order in
the main event loop and prevents the read-modify-write race caused by renderer
whole-state replacement.

### Electron main adapter

Owns named IPC handlers and translates Electron sender identity into a
`BridgeActor`. The actor is derived from `event.sender.id`; a renderer cannot
claim another sender identity in its request. A caller-provided trust predicate
must register the `webContents` before it can request a snapshot or dispatch.
The application also supplies an independently trust-filtered broadcast target
list so a denied window cannot receive state passively.

### Preload transport

Exposes only `getSnapshot`, `dispatch`, `dispatchSync`, and `onCommit`. Listener
cleanup removes exactly the wrapped listener. No channel names or generic send
primitive are exposed to page code.

### `RendererStoreClient<State, Action>`

Subscribes before its first hydration request. It owns one snapshot reference,
one stable metadata reference, and listener sets. `getSnapshot()` returns the
same object until a newer state is accepted.

A normal contiguous commit (`local + 1`) is applied. A stale or duplicate
commit (`<= local`) is ignored. A forward gap (`> local + 1`) is not applied as
an incremental event; the client records the gap and requests a full snapshot.
Concurrent resync attempts share one promise. If a gap arrives while hydration
or another resync is already in flight, the client queues one follow-up full
snapshot request so a stale first response cannot leave it silently divergent.
Older snapshot responses are ignored, and completion after `destroy()` cannot
revive the store.

Dispatch responses include the full committed snapshot. This makes the
originating renderer robust to a missed broadcast and lets `dispatchSync`
install the caller's local snapshot before returning.

### React adapter

`useRendererStore` passes the store's stable `subscribe` and `getSnapshot`
functions directly to `useSyncExternalStore`. `useRendererStoreMeta` does the
same for revision/status diagnostics. There is no allocating selector inside a
snapshot getter.

## State model used by the demo

- `session`: idle/listening/paused/ended, id, and authoritative main timestamps;
- `transcript`: ordered synthetic segments and a transcript-specific revision;
- `insights`: pending/ready/error items tied to a transcript revision;
- `ui`: overlay flag, dashboard view, and explicitly committed command-bar data;
- `history`: immutable summaries created when a synthetic session ends.

The generic library has no knowledge of this shape.

## Protocol

All messages use protocol version `1` and strict object shapes.

### Action request

```ts
{
  protocolVersion: 1;
  clientId: string;
  requestId: string;
  action: Action;
}
```

`clientId` and `requestId` are bounded safe identifiers. The main adapter scopes
deduplication by trusted Electron sender identity as well as these identifiers.

### Dispatch response

Success returns:

```ts
{
  ok: true;
  value: {
    ack: { revision: number };
    snapshot: { protocolVersion: 1; revision: number; state: State };
    duplicate: boolean;
  };
}
```

Failure returns a bounded code/message/details object. Error messages are capped
at 500 characters before they cross the bridge. Raw error objects and stacks do
not cross the bridge.

### Commit event

A commit contains the full snapshot plus `actionType`, `committedAt`, and a
coarse `source` (`renderer` or `main`). The full state is intentional for this
small proof: it makes resync semantics obvious and prevents patch-application
ambiguity.

## Invariants

1. **Single writer.** Only the main host installs canonical state.
2. **Total order.** Every successful mutation receives one increasing revision.
3. **No lost append.** Each reducer runs against the latest installed snapshot.
4. **Stable reads.** A renderer snapshot reference changes only when accepted
   state changes.
5. **Boundary validation.** The main validates envelopes, serializability,
   domain shape, sender trust, authorization, and sync eligibility.
6. **Idempotent retry window.** An exact request replay returns its original
   acknowledgement without rerunning the reducer.
7. **Collision rejection.** Reusing one request id for different action content
   fails.
8. **Gap recovery.** A renderer that observes a noncontiguous revision requests
   a full canonical snapshot.
9. **Caller visibility.** Both async and sync success responses carry the
   committed snapshot; sync applies it before return.
10. **Bounded blocking.** The sync whitelist contains only small pure UI
    actions, the current and resulting full snapshots must fit the configured
    64 KiB default budget, and commit observers execute after the call stack.

## Failure handling

| Failure | Behavior |
|---|---|
| malformed envelope/action | structured `VALIDATION_ERROR`; no revision change |
| non-JSON value | `NON_SERIALIZABLE_VALUE`; no reducer call |
| unregistered renderer request | `UNTRUSTED_SENDER` |
| unregistered renderer subscription | excluded from broadcast targets |
| main-only action from renderer | `UNAUTHORIZED_ACTION` |
| non-whitelisted sync action | `SYNC_ACTION_NOT_ALLOWED` |
| sync snapshot above configured byte budget | `SYNC_ACTION_NOT_ALLOWED`; use async dispatch |
| invalid state transition | `REDUCER_REJECTED`; message safe for UI |
| listener/broadcast exception | commit remains installed; error callback records adapter failure |
| duplicate/stale commit | ignored by renderer |
| revision gap | recorded, then one full resync request |
| renderer reload | preload re-exposes the narrow API; new store hydrates current snapshot |
| malformed main response | renderer raises typed `TRANSPORT_ERROR` |

## Why concurrent appends survive

A problematic design lets both windows read transcript array `T`, create
`T + A` and `T + B`, then send two replacements. Whichever arrives last deletes
the other append.

Here both windows send intent only. Main handles `append A`, producing revision
`n + 1` with `T + A`. It then handles `append B` against that new snapshot,
producing revision `n + 2` with `T + A + B`. Tests exercise this both without
Electron and through two real Electron renderer windows.

## Synchronous experiment

Electron's synchronous IPC blocks the renderer. The handler therefore has no
extension point for I/O and the demo whitelist admits only three UI actions
with bounded strings. The host measures the canonical full snapshot encoding
and refuses sync commits above 64 KiB by default; this prevents an otherwise
small UI action from synchronously serializing an ever-growing transcript.
Commit listeners are scheduled on a later timer, while the response snapshot is
installed in the caller before return. Broadcasts to other windows remain
event-driven. Session/transcript/insight mutations are deliberately denied on
this path.

## Lifecycle

The application installs the adapter once, registers each created
`webContents`, removes ids on window close, unsubscribes the host listener, and
removes IPC handlers during shutdown. A renderer store's `destroy()` removes its
specific commit listener and clears subscribers.
