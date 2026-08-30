# Evaluation record

This file separates measurements actually performed from commands that merely
exist.

## Local validation run

A fresh review run used Linux x86_64, Node.js `v24.19.0`, and npm `11.7.0`.
Locked dependencies were installed with:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run verify
npm run benchmark:sync:built
npm audit --audit-level=high --no-fund
```

Observed result:

```text
20 tests, 20 passed, 0 failed
npm audit: found 0 vulnerabilities
```

Covered inputs include two concurrent append requests, exact retry, request-id
collision, malformed and unauthorized actions, denied and over-budget sync
actions, deferred commit observers, canonical fingerprints, rejection of
lossy JSON shapes, stable/frozen snapshots, session history, reducer rejection,
stale commits, revision `1 → 3` gap recovery, a gap during initial hydration,
queued resync, destroy-during-hydration, synchronous response application,
malformed transport response, and subscription cleanup.

## Repository CI run

The workflow installs the locked dependency graph under Node 24, runs full
TypeScript checking, repeats core tests, builds the library and Electron app,
actually builds the Docker verification image, launches a real Electron
integration test under Xvfb, and runs the bounded synchronous benchmark.

The release workflow completed successfully. Its benchmark artifact recorded
250 calls with a median of approximately
`0.4 ms`, p95 of `1.2 ms`, and maximum of `3.2 ms` using Electron `44.0.0`,
Chromium `152.0.7977.54`, and Node `24.18.1`.

| Check | Status | Evidence |
|---|---|---|
| full dependency install | verified | repository CI workflow |
| 20 core tests | verified | `npm run test:core` |
| full typecheck | verified | `npm run typecheck` |
| library + Electron build | verified | `npm run build` |
| Docker verification image | verified | `docker build --tag electron-state-bridge:ci .` |
| real Electron integration | verified | `npm run test:electron:built` |
| sync median/p95 | verified | 250-call benchmark artifact |

## Benchmark method

- one hidden real Electron renderer;
- 25 warm-up calls;
- 250 measured `dispatchSync` calls;
- action: `ui/set-command-bar` with a short bounded changing query;
- each call performs renderer-to-main synchronous IPC, request/action
  validation, pure reduction, revision assignment, full small-state snapshot
  cloning/freezing, the 64 KiB snapshot guard, acknowledgement serialization,
  and caller-side return; host listeners are deferred outside this interval;
- renderer `performance.now()` measures the blocking interval;
- output reports count, minimum, median, p95, maximum, final revision, Electron,
  Chromium, and Node versions.

The number is hardware- and load-specific. It does not justify using sync IPC
for transcript events, typing streams, network operations, persistence, or
inference.

## Fresh reviewer commands

```bash
npm ci
npm run verify
npm run benchmark:sync
```

Docker is an alternate reproducible build check for the non-runtime portions:

```bash
docker build -t electron-state-bridge .
```
