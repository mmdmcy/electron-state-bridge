# Alternatives considered

This project implements one protocol: a main-owned canonical reducer with
revisioned snapshots and an optional bounded synchronous facade. The options
below explain why adjacent mechanisms were not made competing implementations.

| Approach | Strength | Problem for this brief | Decision |
|---|---|---|---|
| Plain async `ipcRenderer.invoke` plus broadcasts | Simple and non-blocking | Without a reusable local store, acknowledgements, revisions, gap handling, and a React hook it remains a tutorial-level synchronization demo | Used only as the normal transport underneath the full manager |
| Bounded `sendSync` | Caller can receive the committed snapshot before returning | Blocks the renderer; dangerous if reducers perform I/O, unbounded validation, listener work, or expensive serialization | Included only for three small pure UI actions, a 64 KiB full-snapshot budget, deferred observers, and a benchmark |
| `MessagePort` / `MessageChannelMain` | Efficient dedicated channels and transferable ownership | Still asynchronous, requires lifecycle/port recovery logic, and does not by itself solve canonical ordering or React snapshot stability | Reasonable future transport adapter, not a separate state design |
| CRDT or replicated event log | Supports multi-writer/offline merge and durable history | Considerably larger semantics, conflict policy, persistence, compaction, and testing surface than a single-machine Electron state manager needs | Rejected for this scoped workaround |
| Shared memory plus `SharedArrayBuffer`/Atomics | True shared bytes and blocking primitives are possible | Complex memory layout, cross-origin isolation concerns, manual serialization, torn logical reads, and poor fit for object-rich React state | Rejected; not justified for this product-shaped proof |

## Why not renderer-owned state

A renderer can reload, crash, or be destroyed. Choosing one renderer as the
writer makes ownership and failover ambiguous. Electron main already has the
lifecycle and identity needed to serialize requests from all windows.

## Why full snapshots instead of patches

For this bounded synthetic domain, full snapshots make every commit
self-describing and let dispatch responses repair missed broadcasts. A large
production transcript should separate metadata state from bulk transcript data
or introduce validated patches/checkpoints. That optimization should preserve
the same revision and resync contract.
