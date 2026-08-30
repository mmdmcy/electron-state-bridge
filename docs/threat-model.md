# Threat model

## Assets

- canonical application state and revision order;
- synthetic transcript and insight contents in the demo;
- action authorization rules;
- the narrow preload capability;
- availability of the Electron main and renderer event loops.

A real meeting transcript would be sensitive personal or employer data. The
demo intentionally uses generated text only.

## Trust boundaries

### Renderer page

Treated as less trusted than main. It can request only the four preload
operations. It cannot choose IPC channel names, access Node.js, or obtain raw
`ipcRenderer`.

### Preload

Trusted adapter with no domain authority. It forwards fixed methods and wraps
each commit listener so its exact IPC listener can be removed. It does not
expose filesystem, process, network, or generic messaging APIs.

### Main process

Trusted canonical writer. It derives actor identity from Electron's event,
checks that the sender was registered by window creation, validates every
request and action, applies authorization, controls the sync whitelist, and
broadcasts only to the same registered `webContents` set.

## Addressed threats

| Threat | Control |
|---|---|
| arbitrary IPC from compromised page | no raw IPC exposure; fixed methods/channels only |
| action shape confusion | strict validators reject unknown fields and unsupported discriminants |
| lossy or executable object shapes | plain JSON-only clone rejects dangerous keys, non-plain objects, accessors, symbols, sparse arrays, and custom array properties |
| `NaN`, infinity, `BigInt`, functions, cycles | explicit serializability rejection |
| renderer impersonates another actor | main uses `event.sender.id`, not request metadata, for authorization/dedupe scope |
| unregistered window receives passive state | broadcast targets are filtered by the registered `webContents` set; the Electron harness checks zero leaked commits |
| renderer publishes trusted insight result | `insight/publish` and `insight/fail` are main-only |
| retry duplicates an append | bounded request dedupe with content fingerprint |
| request-id collision hides different action | `REQUEST_ID_REUSE` rejection |
| stale window rolls state backward | revisions at renderer; stale events/responses ignored |
| dropped event leaves silent divergence | forward-gap detection and full resync |
| new navigation inherits capability | demo denies navigation and child windows; sender ids are registered by creation |
| internal stack leakage | bounded serializable error payloads cross IPC |
| sync handler freezes UI for hidden work | sync whitelist, pure reducer, 64 KiB full-snapshot guard, deferred observers, and no I/O extension point |

## Residual risks

- A renderer with the bridge can issue many valid actions and cause CPU/memory
  pressure. Add per-window rate limits for hostile-content scenarios.
- Full snapshots duplicate transcript text across processes and may appear in
  memory dumps. Real sensitive transcripts need retention rules, encryption at
  rest if persisted, redaction, and a smaller data plane.
- The dedupe cache is bounded and lost when main restarts. It is retry safety,
  not durable exactly-once processing.
- Main compromise defeats this model; code signing, update integrity, dependency
  review, and OS hardening are deployment concerns.
- The CSP permits same-origin and WebSocket development connections required by
  Vite, and inline styles for development injection. A packaged release should
  remove `ws:`/`wss:` and `unsafe-inline` from its production-only policy.
- Synchronous IPC remains a denial-of-service risk if its whitelist grows,
  reducer complexity regresses, or the configured snapshot budget is raised.
  Keep the benchmark and review every added sync action.

## Data handling guidance

Do not put credentials, authentication tokens, raw audio, employer data, or
unredacted customer transcripts in this demo. A production adaptation should
define collection purpose, consent, retention, deletion, logging, crash-report,
and support-access policies before capture is added.
