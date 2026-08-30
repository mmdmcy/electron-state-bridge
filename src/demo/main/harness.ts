import type { BrowserWindow } from 'electron';
import type { CanonicalStateHost } from '../../library/core/canonical-host.js';
import {
  parseDispatchResponse,
  parseSnapshotResponse
} from '../../library/core/protocol.js';
import { STATE_BRIDGE_PROTOCOL_VERSION } from '../../library/core/types.js';
import type { AppAction, AppState, TranscriptSegment } from '../domain/types.js';
import { validateAppState } from '../domain/validation.js';

interface HarnessOptions {
  readonly host: CanonicalStateHost<AppState, AppAction>;
  readonly createWindow: () => Promise<BrowserWindow>;
  readonly createUntrustedWindow?: () => Promise<BrowserWindow>;
}

function phase(mode: 'integration' | 'benchmark', name: string): void {
  console.log(`ELECTRON_${mode.toUpperCase()}_PHASE ${name}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function request(clientId: string, requestId: string, action: AppAction): string {
  return JSON.stringify({
    protocolVersion: STATE_BRIDGE_PROTOCOL_VERSION,
    clientId,
    requestId,
    action
  });
}

async function evaluate(window: BrowserWindow, expression: string): Promise<unknown> {
  return window.webContents.executeJavaScript(expression, true);
}

async function dispatch(
  window: BrowserWindow,
  clientId: string,
  requestId: string,
  action: AppAction
) {
  const raw = await evaluate(
    window,
    `window.stateBridge.dispatch(${request(clientId, requestId, action)})`
  );
  return parseDispatchResponse(raw, validateAppState);
}

async function getSnapshot(window: BrowserWindow) {
  const raw = await evaluate(window, 'window.stateBridge.getSnapshot()');
  return parseSnapshotResponse(raw, validateAppState);
}

async function reload(window: BrowserWindow): Promise<void> {
  const loaded = new Promise<void>((resolve) => {
    window.webContents.once('did-finish-load', () => resolve());
  });
  window.reload();
  await loaded;
}

async function waitForCommitRevisions(
  window: BrowserWindow,
  expected: readonly number[],
  timeoutMs = 2_000
): Promise<readonly number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(window, 'window.__trustedCommitRevisions');
    if (
      Array.isArray(value)
      && value.every((item) => Number.isSafeInteger(item))
      && JSON.stringify(value) === JSON.stringify(expected)
    ) {
      return value as readonly number[];
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Trusted renderer did not receive revisions ${expected.join(', ')} in order.`);
}

export async function runIntegrationHarness(options: HarnessOptions): Promise<void> {
  phase('integration', 'create-windows');
  const first = await options.createWindow();
  const second = await options.createWindow();
  const untrusted = await options.createUntrustedWindow?.();

  try {
    phase('integration', 'verify-preload-and-trust');
    const preloadType = await evaluate(first, 'typeof window.stateBridge');
    assert(preloadType === 'object', 'The contextBridge API was not exposed.');
    await evaluate(
      second,
      `(() => {
        window.__trustedCommitRevisions = [];
        window.__unsubscribeTrustedCommits = window.stateBridge.onCommit((commit) => {
          window.__trustedCommitRevisions.push(commit.revision);
        });
      })()`
    );

    if (untrusted !== undefined) {
      await evaluate(
        untrusted,
        `(() => {
          window.__untrustedCommitCount = 0;
          window.stateBridge.onCommit(() => {
            window.__untrustedCommitCount += 1;
          });
        })()`
      );
      const rejected = await getSnapshot(untrusted);
      assert(
        !rejected.ok && rejected.error.code === 'UNTRUSTED_SENDER',
        'An unregistered webContents accessed the state bridge.'
      );
    }

    phase('integration', 'dispatch-session-and-errors');
    const started = await dispatch(first, 'window-a', 'start', {
      type: 'session/start',
      sessionId: 'integration-session'
    });
    assert(started.ok, 'Session start failed through real Electron IPC.');
    assert(started.value.ack.revision === 1, 'Session start should commit revision 1.');

    const rejectedTransition = await dispatch(first, 'window-a', 'start-again', {
      type: 'session/start',
      sessionId: 'integration-session-2'
    });
    assert(
      !rejectedTransition.ok && rejectedTransition.error.code === 'REDUCER_REJECTED',
      'A reducer rejection was not propagated through Electron IPC.'
    );
    assert(options.host.getSnapshot().revision === 1, 'Rejected transition advanced revision.');

    phase('integration', 'dispatch-concurrent-appends');
    const segmentA: TranscriptSegment = {
      id: 'integration-segment-a',
      speaker: 'host',
      text: 'Synthetic append from integration window A.',
      timestamp: Date.now(),
      status: 'final'
    };
    const segmentB: TranscriptSegment = {
      id: 'integration-segment-b',
      speaker: 'guest',
      text: 'Synthetic append from integration window B.',
      timestamp: segmentA.timestamp + 1,
      status: 'final'
    };
    const [appendA, appendB] = await Promise.all([
      dispatch(first, 'window-a', 'append-a', {
        type: 'transcript/append',
        segment: segmentA
      }),
      dispatch(second, 'window-b', 'append-b', {
        type: 'transcript/append',
        segment: segmentB
      })
    ]);
    assert(appendA.ok && appendB.ok, 'Concurrent append dispatch failed.');
    assert(
      new Set([appendA.value.ack.revision, appendB.value.ack.revision]).size === 2,
      'Concurrent appends did not receive distinct revisions.'
    );

    const current = await getSnapshot(first);
    assert(current.ok, 'Snapshot request failed after concurrent dispatch.');
    assert(current.value.snapshot.revision === 3, 'Expected revision 3 after two appends.');
    assert(
      current.value.snapshot.state.transcript.segments.length === 2,
      'One concurrent transcript append was lost.'
    );

    phase('integration', 'verify-dedupe-and-boundary-errors');
    const replay = await dispatch(first, 'window-a', 'append-a', {
      type: 'transcript/append',
      segment: segmentA
    });
    assert(replay.ok && replay.value.duplicate, 'Exact request replay was not deduplicated.');

    const malformedRaw = await evaluate(
      first,
      `window.stateBridge.dispatch(${JSON.stringify({
        protocolVersion: STATE_BRIDGE_PROTOCOL_VERSION,
        clientId: 'window-a',
        requestId: 'malformed',
        action: { type: 'not-supported' }
      })})`
    );
    assert(
      typeof malformedRaw === 'object'
        && malformedRaw !== null
        && 'ok' in malformedRaw
        && malformedRaw.ok === false
        && 'error' in malformedRaw
        && typeof malformedRaw.error === 'object'
        && malformedRaw.error !== null
        && 'code' in malformedRaw.error
        && malformedRaw.error.code === 'VALIDATION_ERROR',
      'Malformed action was not rejected at the main boundary.'
    );

    const unauthorized = await dispatch(first, 'window-a', 'unauthorized-publish', {
      type: 'insight/publish',
      insightId: 'integration-insight',
      text: 'Renderer publication must be denied.'
    });
    assert(
      !unauthorized.ok && unauthorized.error.code === 'UNAUTHORIZED_ACTION',
      'Renderer-only authorization policy was not enforced.'
    );

    phase('integration', 'dispatch-sync');
    const syncRaw = await evaluate(
      first,
      `window.stateBridge.dispatchSync(${request('window-a', 'sync-toggle', {
        type: 'ui/toggle-overlay'
      })})`
    );
    const syncResult = parseDispatchResponse(syncRaw, validateAppState);
    assert(syncResult.ok, 'Bounded synchronous dispatch failed.');
    assert(syncResult.value.ack.revision === 4, 'Synchronous dispatch should commit revision 4.');

    phase('integration', 'verify-broadcast-order-and-cleanup');
    const broadcastRevisions = await waitForCommitRevisions(second, [1, 2, 3, 4]);
    await evaluate(second, 'window.__unsubscribeTrustedCommits()');
    const afterUnsubscribe = await dispatch(first, 'window-a', 'view-after-unsubscribe', {
      type: 'ui/set-active-view',
      view: 'insights'
    });
    assert(afterUnsubscribe.ok, 'Post-unsubscribe dispatch failed.');
    assert(
      afterUnsubscribe.value.ack.revision === 5,
      'Post-unsubscribe dispatch should commit revision 5.'
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const revisionsAfterUnsubscribe = await evaluate(
      second,
      'window.__trustedCommitRevisions'
    );
    assert(
      JSON.stringify(revisionsAfterUnsubscribe) === JSON.stringify(broadcastRevisions),
      'Removed preload listener received another commit.'
    );

    if (untrusted !== undefined) {
      const untrustedCommitCount = await evaluate(
        untrusted,
        'window.__untrustedCommitCount'
      );
      assert(
        untrustedCommitCount === 0,
        'An unregistered webContents received a committed state broadcast.'
      );
    }

    phase('integration', 'reload-and-rehydrate');
    await reload(second);
    const rehydrated = await getSnapshot(second);
    assert(rehydrated.ok, 'Reloaded renderer could not rehydrate.');
    assert(rehydrated.value.snapshot.revision === 5, 'Reloaded renderer received a stale revision.');
    assert(
      rehydrated.value.snapshot.state.transcript.segments.length === 2,
      'Reloaded renderer did not recover the complete transcript.'
    );

    console.log(`ELECTRON_INTEGRATION_RESULT ${JSON.stringify({
      status: 'pass',
      revision: rehydrated.value.snapshot.revision,
      segmentIds: rehydrated.value.snapshot.state.transcript.segments.map((item) => item.id),
      broadcastRevisions,
      subscriptionCleanup: true,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node
    })}`);
  } finally {
    first.destroy();
    second.destroy();
    untrusted?.destroy();
  }
}

export async function runSyncBenchmark(options: HarnessOptions): Promise<void> {
  phase('benchmark', 'create-window');
  const window = await options.createWindow();
  try {
    phase('benchmark', 'measure');
    const result = await evaluate(
      window,
      `(() => {
        const samples = [];
        const call = (index, warmup) => {
          const request = {
            protocolVersion: ${STATE_BRIDGE_PROTOCOL_VERSION},
            clientId: 'benchmark-window',
            requestId: (warmup ? 'warmup-' : 'sample-') + index,
            action: {
              type: 'ui/set-command-bar',
              open: index % 2 === 0,
              query: 'bounded-' + (index % 10)
            }
          };
          const started = performance.now();
          const response = window.stateBridge.dispatchSync(request);
          const elapsed = performance.now() - started;
          if (!response || response.ok !== true) {
            throw new Error('Synchronous benchmark dispatch failed.');
          }
          return elapsed;
        };
        for (let index = 0; index < 25; index += 1) call(index, true);
        for (let index = 0; index < 250; index += 1) samples.push(call(index, false));
        samples.sort((a, b) => a - b);
        const percentile = (p) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)];
        return {
          count: samples.length,
          medianMs: percentile(0.5),
          p95Ms: percentile(0.95),
          minMs: samples[0],
          maxMs: samples[samples.length - 1]
        };
      })()`
    );

    console.log(`ELECTRON_BENCHMARK_RESULT ${JSON.stringify({
      ...(result as Record<string, unknown>),
      finalRevision: options.host.getSnapshot().revision,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node
    })}`);
  } finally {
    window.destroy();
  }
}
