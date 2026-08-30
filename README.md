# electron-state-bridge

[![verify](https://github.com/mmdmcy/electron-state-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/mmdmcy/electron-state-bridge/actions/workflows/ci.yml)

A reusable, revisioned global-state protocol for Electron. The main process is
the single writer, renderer windows keep immutable local snapshots, React reads
those snapshots through `useSyncExternalStore`, and mutations cross the preload
boundary as validated domain actions.

The included two-window live-session demo exists to prove the manager. It is
not a meeting product and does not copy another application's interface or
private implementation.

## What “synchronous” means here

This project uses the term narrowly and honestly:

- `getSnapshot()` and React reads are immediate local reads.
- The normal cross-process transport is asynchronous.
- Main-process commits are serialized, acknowledged, and assigned increasing
  revisions.
- Every live window converges, ignores stale/duplicate commits, and requests a
  full snapshot when it detects a revision gap.
- `dispatchSync` is an opt-in experiment for a small whitelist of pure,
  serializable UI actions. It is refused when the current or resulting full
  snapshot exceeds the default 64 KiB sync-response budget. Its response
  contains the committed snapshot, so the calling renderer's local
  `getSnapshot()` reflects that commit before `dispatchSync` returns.
- Commit observers and broadcasts are scheduled after the dispatch call stack;
  other windows receive the commit through normal event delivery.
- Separate renderer processes are not promised to repaint at the exact same
  instant.

Asynchronous IPC by itself is not presented as “completely synchronous across
processes.”

## Architecture

```text
renderer A                         Electron main                         renderer B
──────────                         ─────────────                         ──────────
React                              CanonicalStateHost                   React
  │ useSyncExternalStore                 │                                │
RendererStoreClient ─ typed request ───> validate + authorize <──── typed request
  │                                      reduce once                       │
  │ <─ ack + full snapshot ───────────── revision++ ───── ack + snapshot ─>│
  │                                      broadcast commit                  │
  └──────── stable local snapshot <────── ordered event ────────> stable snapshot
                        gap detected → invoke full resync
```

The reusable code is under `src/library/`:

- `core`: protocol types, JSON-value enforcement, immutable snapshots, the
  canonical host, canonical action fingerprints, deduplication,
  acknowledgements, revisions, and the sync snapshot-size budget;
- `renderer`: local snapshot client, hydration, stale-event handling, gap
  detection, resynchronization, cleanup, async dispatch, and bounded sync
  dispatch;
- `react`: `useSyncExternalStore` hooks with stable snapshots;
- `electron`: narrow channel constants, preload transport, and main-process IPC
  adapter.

The generic manager does not know about sessions or transcripts. The demo
domain under `src/demo/domain/` supplies a reducer, validators, authorization,
and the synchronous-action whitelist.

## Quick start

Requirements: Node.js 22.12+ and a desktop environment supported by Electron.

```bash
npm install
npm run dev
```

The app opens:

1. an always-on-top overlay/command window; and
2. a dashboard/transcript window reading the same canonical state.

A useful manual path is: start a session, emit transcript events from the
overlay, dispatch a competing pair from the dashboard, request an insight,
reload the dashboard, then use **Full resync**. The revision and gap indicators
make the protocol visible.

## Public API

```ts
interface RendererStore<State, Action> {
  getSnapshot(): Readonly<State>;
  subscribe(listener: () => void): () => void;
  dispatch(action: Action): Promise<{ revision: number }>;
}

interface OptionalSyncRendererStore<State, Action>
  extends RendererStore<State, Action> {
  dispatchSync(action: Action): { revision: number };
}
```

Create the main-process host with an initial state, pure reducer, action
validator, authorization policy, and optional sync whitelist:

```ts
const host = new CanonicalStateHost({
  initialState,
  reduce,
  validateAction,
  authorize: (action, actor) => actor.kind === 'main' || isRendererAction(action),
  allowSync: (action, actor) =>
    actor.kind === 'renderer' && action.type === 'ui/toggle-overlay'
});
```

Install the Electron adapter without exposing `ipcRenderer`:

```ts
installElectronStateBridge({
  ipcMain,
  host,
  getBroadcastTargets: () => BrowserWindow.getAllWindows()
    .map((window) => window.webContents)
    .filter((contents) => registeredWindowIds.has(contents.id)),
  isTrustedSender: ({ senderId }) => registeredWindowIds.has(senderId)
});
```

The preload exposes only four bounded capabilities:

```ts
contextBridge.exposeInMainWorld(
  'stateBridge',
  createElectronRendererTransport(ipcRenderer)
);
```

Create one renderer client and consume its stable snapshot in React:

```ts
const store = new RendererStoreClient({
  transport: window.stateBridge,
  initialSnapshot,
  validateState
});

function Screen() {
  const state = useRendererStore(store);
  return <output>{state.session.status}</output>;
}
```

No selector that allocates a new object runs inside `getSnapshot()`. This
version deliberately rerenders subscribers for each committed state change. A
future selector layer should use a tested equality adapter rather than weaken
snapshot stability.

## Action protocol

The demo uses intent-bearing actions, including:

```text
session/start        session/pause       session/resume       session/end
transcript/append    transcript/finalize
insight/request      insight/publish     insight/fail
ui/toggle-overlay    ui/set-active-view  ui/set-command-bar
```

There is no arbitrary `setState(key, value)` and no whole-array replacement.
Two concurrent `transcript/append` requests are reduced against consecutive
canonical snapshots, so both survive. Each request also carries a client and
request identifier; exact retries are deduplicated within a bounded main-process
cache, while reuse of an identifier for different content is rejected.

## Bounded `dispatchSync`

The synchronous channel accepts only three small demo UI actions. Session,
transcript, and insight actions are rejected on this channel even though their
reducers are pure. The handler performs no file, network, database, timer, or
long-running work. The host also rejects the call when either the current or
resulting full snapshot is above 64 KiB by default, and it schedules commit
observers outside the blocking call stack. Use normal `dispatch` for ordinary
mutations and for all high-frequency input.

Run the measured renderer-blocking experiment with:

```bash
npm run benchmark:sync
```

It performs 25 warm-ups and 250 measured calls in a hidden real Electron
renderer and reports median/p95 latency. See `docs/evaluation.md` for the exact
recorded environment and limitations.

## Verification

```bash
npm run typecheck
npm run test:core
npm run build
npm run test:electron
npm run benchmark:sync
npm run verify
```

`test:core` is independent of Electron and covers concurrent updates,
deduplication, authorization, reducer errors, strict JSON normalization,
snapshot stability, stale events, hydration races, revision gaps, queued
resync, sync response limits/application, destruction races, and subscription
cleanup.
`test:electron` launches actual Electron windows under Xvfb on Linux and checks
the preload bridge, concurrent cross-window actions, malformed/unauthorized
rejection, denial of requests and broadcasts to an unregistered window,
synchronous dispatch, reload, and rehydration.

A Dockerfile runs the dependency install, full typecheck, core tests, library
build, and Electron bundle build without downloading the Electron runtime:

```bash
docker build -t electron-state-bridge .
```

CI actually builds that Docker image, then runs the real Electron integration
test and benchmark under Xvfb. AWS resources are intentionally absent: this is
a local inter-process state protocol, and adding a cloud service would not
strengthen its core contract.

## Security posture

- `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`;
- raw `ipcRenderer` never crosses `contextBridge`;
- only registered `webContents` may use handlers or receive commit broadcasts;
- request envelopes and domain actions are strict and reject unknown fields;
- only lossless plain, finite JSON values are accepted; cycles, class
  instances, accessors, symbol keys, sparse arrays, functions, `BigInt`, `NaN`,
  infinities, and prototype-pollution keys fail;
- renderer publication of main-owned insight results is denied;
- navigation and child-window creation are blocked in the demo;
- errors crossing IPC are short structured payloads, not raw stacks.

Read `docs/threat-model.md` before adapting the demo state to real transcript or
customer data.

## Limitations

- The main process is a deliberate single point of consistency and failure.
- State is in memory; persistence and migrations are outside this project's
  scope.
- Broadcasts carry full snapshots for clarity. Large states should use bounded
  snapshots, pagination, or a separate data plane.
- Deduplication is bounded and process-local, not durable exactly-once delivery.
- A renderer cannot process broadcasts while it is blocked in `dispatchSync`;
  only the caller's returned snapshot is synchronous. Once the full state grows
  beyond the configured sync budget, the blocking facade intentionally refuses
  new commits and callers must use normal asynchronous dispatch.
- There is no claim of simultaneous repaint across OS processes.
- The demo uses synthetic text only and performs no capture, inference, or
  external communication.

## Contributing and security

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the
development and verification workflow. Please report security issues through
the private process in [`SECURITY.md`](SECURITY.md), not a public issue.

## Documentation

- [`docs/design.md`](docs/design.md) — protocol, invariants, and failure handling
- [`docs/alternatives.md`](docs/alternatives.md) — rejected/adjacent approaches
- [`docs/threat-model.md`](docs/threat-model.md) — trust boundaries and data risk
- [`docs/evaluation.md`](docs/evaluation.md) — commands, versions, measurements
- [`docs/qa-review.md`](docs/qa-review.md) — final lifecycle and trust hardening
- [`docs/demo-script.md`](docs/demo-script.md) — 60–90 second walkthrough
