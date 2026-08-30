# Final QA review

The final skeptical pass focused on lifecycle and trust behavior that is easy to miss in a basic IPC demonstration.

## Hardened paths

- A renderer can retry hydration after `getSnapshot()` throws synchronously; the client no longer retains a permanently rejected resync promise.
- The Electron main adapter re-checks `isTrustedSender` for every broadcast target, so passive state delivery is protected inside the adapter rather than only by application-side target filtering.
- Window creation enforces the preload path, `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and disabled spellcheck after caller options are applied.
- The real Electron harness records ordered broadcast revisions, verifies an unregistered window receives no commits, invokes the preload unsubscribe function, and proves the removed listener receives no later commit.
- Successful canonical-host responses are frozen, and listeners that unsubscribe before deferred delivery are skipped.

## Local evidence

The TypeScript/core path passes 20 of 20 tests. The repository workflow also
verifies the locked dependency graph, full typecheck, library and application
builds, Docker image, real Electron integration, and bounded sync benchmark.
See `docs/evaluation.md` for the recorded evidence and limitations.
