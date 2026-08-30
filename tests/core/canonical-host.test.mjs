import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CanonicalStateHost,
  STATE_BRIDGE_PROTOCOL_VERSION,
  cloneJson,
  stableJsonFingerprint
} from '../../.test-build/library/core/index.js';
import {
  allowSynchronousAppAction,
  authorizeAppAction,
  createInitialAppState,
  reduceAppState,
  validateAppAction
} from '../../.test-build/demo/domain/index.js';

const rendererA = { kind: 'renderer', id: 'window-a' };
const rendererB = { kind: 'renderer', id: 'window-b' };

function request(clientId, requestId, action) {
  return {
    protocolVersion: STATE_BRIDGE_PROTOCOL_VERSION,
    clientId,
    requestId,
    action
  };
}

function segment(id, speaker = 'host') {
  return {
    id,
    speaker,
    text: `Synthetic segment ${id}`,
    timestamp: 1_000,
    status: 'final'
  };
}

function makeHost(overrides = {}) {
  let now = 1_000;
  return new CanonicalStateHost({
    initialState: createInitialAppState(),
    reduce: reduceAppState,
    validateAction: validateAppAction,
    authorize: authorizeAppAction,
    allowSync: allowSynchronousAppAction,
    clock: () => ++now,
    ...overrides
  });
}

test('serializes concurrent append actions without losing either update', async () => {
  const host = makeHost();
  const start = await host.dispatch(
    request('client-a', 'start', { type: 'session/start', sessionId: 'session-1' }),
    rendererA
  );
  assert.equal(start.ok, true);

  const [first, second] = await Promise.all([
    host.dispatch(
      request('client-a', 'append-a', {
        type: 'transcript/append',
        segment: segment('segment-a', 'host')
      }),
      rendererA
    ),
    host.dispatch(
      request('client-b', 'append-b', {
        type: 'transcript/append',
        segment: segment('segment-b', 'guest')
      }),
      rendererB
    )
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(
    [first.value.ack.revision, second.value.ack.revision].sort((a, b) => a - b),
    [2, 3]
  );
  assert.deepEqual(
    host.getSnapshot().state.transcript.segments.map((item) => item.id),
    ['segment-a', 'segment-b']
  );
  assert.equal(host.getSnapshot().state.transcript.revision, 2);
});

test('deduplicates exact retries and rejects request-id reuse with different content', async () => {
  const host = makeHost();
  await host.dispatch(
    request('client-a', 'start', { type: 'session/start', sessionId: 'session-1' }),
    rendererA
  );

  const appendRequest = request('client-a', 'append-once', {
    type: 'transcript/append',
    segment: segment('segment-a')
  });
  const committed = await host.dispatch(appendRequest, rendererA);
  const replay = await host.dispatch(appendRequest, rendererA);
  const collision = await host.dispatch(
    request('client-a', 'append-once', {
      type: 'transcript/append',
      segment: segment('segment-b')
    }),
    rendererA
  );

  assert.equal(committed.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.value.duplicate, true);
  assert.equal(replay.value.ack.revision, committed.value.ack.revision);
  assert.equal(host.getSnapshot().state.transcript.segments.length, 1);
  assert.equal(collision.ok, false);
  assert.equal(collision.error.code, 'REQUEST_ID_REUSE');
});

test('rejects malformed and renderer-only unauthorized actions at the main boundary', async () => {
  const host = makeHost();
  const malformed = await host.dispatch(
    request('client-a', 'bad', { type: 'not-a-real-action' }),
    rendererA
  );
  const unauthorized = await host.dispatch(
    request('client-a', 'publish', {
      type: 'insight/publish',
      insightId: 'insight-1',
      text: 'This renderer should not publish.'
    }),
    rendererA
  );

  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, 'VALIDATION_ERROR');
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.error.code, 'UNAUTHORIZED_ACTION');
  assert.equal(host.getSnapshot().revision, 0);
});

test('caps oversized validation errors before they cross the bridge', async () => {
  const host = makeHost();
  const result = await host.dispatch(
    request('client-a', 'oversized-error', { type: 'x'.repeat(10_000) }),
    rendererA
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'VALIDATION_ERROR');
  assert.equal(result.error.message.length, 500);
  assert.equal(result.error.message.endsWith('…'), true);
  assert.equal(host.getSnapshot().revision, 0);
});

test('bounds synchronous dispatch to the explicit pure UI whitelist', () => {
  const host = makeHost();
  const allowed = host.dispatchSync(
    request('client-a', 'toggle', { type: 'ui/toggle-overlay' }),
    rendererA
  );
  const denied = host.dispatchSync(
    request('client-a', 'start-sync', {
      type: 'session/start',
      sessionId: 'session-sync'
    }),
    rendererA
  );

  assert.equal(allowed.ok, true);
  assert.equal(allowed.value.snapshot.state.ui.overlayVisible, false);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'SYNC_ACTION_NOT_ALLOWED');
});

test('rejects synchronous dispatch when the full response exceeds its byte budget', async () => {
  const host = makeHost({ maxSyncSnapshotBytes: 1 });
  const denied = host.dispatchSync(
    request('client-a', 'toggle-too-large', { type: 'ui/toggle-overlay' }),
    rendererA
  );

  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'SYNC_ACTION_NOT_ALLOWED');
  assert.equal(host.getSnapshot().revision, 0);

  const asyncAllowed = await host.dispatch(
    request('client-a', 'toggle-async', { type: 'ui/toggle-overlay' }),
    rendererA
  );
  assert.equal(asyncAllowed.ok, true);
  assert.equal(asyncAllowed.value.ack.revision, 1);
});

test('defers commit observers outside the synchronous dispatch call stack', async () => {
  const host = makeHost();
  let observed = false;
  host.subscribe(() => {
    observed = true;
  });

  const result = host.dispatchSync(
    request('client-a', 'toggle-deferred', { type: 'ui/toggle-overlay' }),
    rendererA
  );

  assert.equal(result.ok, true);
  assert.equal(observed, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(observed, true);
});

test('does not invoke an observer that unsubscribes before deferred delivery', async () => {
  const host = makeHost();
  let observed = false;
  const unsubscribe = host.subscribe(() => {
    observed = true;
  });

  const result = host.dispatchSync(
    request('client-a', 'toggle-unsubscribed', { type: 'ui/toggle-overlay' }),
    rendererA
  );
  unsubscribe();

  assert.equal(result.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(observed, false);
});

test('freezes successful responses so a direct caller cannot corrupt retry state', async () => {
  const host = makeHost();
  const actionRequest = request(
    'client-a',
    'immutable-response',
    { type: 'ui/toggle-overlay' }
  );

  const committed = await host.dispatch(actionRequest, rendererA);
  assert.equal(committed.ok, true);
  assert.equal(Object.isFrozen(committed), true);
  assert.equal(Object.isFrozen(committed.value), true);
  assert.equal(Object.isFrozen(committed.value.ack), true);
  assert.throws(() => {
    committed.value.ack.revision = 999;
  }, TypeError);

  const replay = await host.dispatch(actionRequest, rendererA);
  assert.equal(replay.ok, true);
  assert.equal(replay.value.duplicate, true);
  assert.equal(replay.value.ack.revision, 1);
  assert.equal(Object.isFrozen(replay), true);
  assert.equal(Object.isFrozen(replay.value), true);
});

test('uses an order-independent JSON fingerprint and rejects lossy JSON shapes', () => {
  assert.equal(
    stableJsonFingerprint({ beta: 2, alpha: { second: false, first: true } }),
    stableJsonFingerprint({ alpha: { first: true, second: false }, beta: 2 })
  );

  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () => cloneJson(sparse),
    (error) => error?.code === 'NON_SERIALIZABLE_VALUE'
  );

  let getterInvoked = false;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() {
      getterInvoked = true;
      return 1;
    }
  });
  assert.throws(
    () => cloneJson(accessor),
    (error) => error?.code === 'NON_SERIALIZABLE_VALUE'
  );
  assert.equal(getterInvoked, false);

  const symbolKeyed = { safe: true };
  symbolKeyed[Symbol('hidden')] = 'not-json';
  assert.throws(
    () => cloneJson(symbolKeyed),
    (error) => error?.code === 'NON_SERIALIZABLE_VALUE'
  );
});

test('keeps the canonical snapshot stable until a commit and freezes committed data', async () => {
  const host = makeHost();
  const before = host.getSnapshot();
  assert.equal(host.getSnapshot(), before);
  assert.equal(Object.isFrozen(before), true);
  assert.equal(Object.isFrozen(before.state.ui), true);

  await host.dispatch(
    request('client-a', 'toggle', { type: 'ui/toggle-overlay' }),
    rendererA
  );
  const after = host.getSnapshot();
  assert.notEqual(after, before);
  assert.equal(host.getSnapshot(), after);
});
