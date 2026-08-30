import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CanonicalStateHost,
  STATE_BRIDGE_PROTOCOL_VERSION
} from '../../.test-build/library/core/index.js';
import {
  allowSynchronousAppAction,
  authorizeAppAction,
  createInitialAppState,
  reduceAppState,
  validateAppAction
} from '../../.test-build/demo/domain/index.js';

const actor = { kind: 'renderer', id: 'window' };

function request(requestId, action) {
  return {
    protocolVersion: STATE_BRIDGE_PROTOCOL_VERSION,
    clientId: 'domain-test',
    requestId,
    action
  };
}

function host() {
  let time = 10_000;
  return new CanonicalStateHost({
    initialState: createInitialAppState(),
    reduce: reduceAppState,
    validateAction: validateAppAction,
    authorize: authorizeAppAction,
    allowSync: allowSynchronousAppAction,
    clock: () => ++time
  });
}

test('models the live-session lifecycle and creates an immutable history summary', async () => {
  const store = host();
  await store.dispatch(request('start', { type: 'session/start', sessionId: 'session-42' }), actor);
  await store.dispatch(request('append', {
    type: 'transcript/append',
    segment: {
      id: 'segment-1',
      speaker: 'guest',
      text: 'A synthetic final transcript line.',
      timestamp: 10_001,
      status: 'final'
    }
  }), actor);
  await store.dispatch(request('insight-request', {
    type: 'insight/request',
    insightId: 'insight-1',
    transcriptRevision: 1
  }), actor);

  const publish = store.dispatchInternal({
    type: 'insight/publish',
    insightId: 'insight-1',
    text: 'The session has one finalized synthetic point.'
  }, 'synthetic-insight');
  assert.equal(publish.ok, true);

  const ended = await store.dispatch(request('end', { type: 'session/end' }), actor);
  assert.equal(ended.ok, true);
  const state = store.getSnapshot().state;
  assert.equal(state.session.status, 'ended');
  assert.equal(state.history.length, 1);
  assert.deepEqual(state.history[0], {
    id: 'summary-session-42-10005',
    sessionId: 'session-42',
    startedAt: 10_001,
    endedAt: 10_005,
    segmentCount: 1,
    finalSegmentCount: 1,
    readyInsightCount: 1,
    preview: 'A synthetic final transcript line.'
  });
});

test('propagates reducer rejections as structured errors without advancing revision', async () => {
  const store = host();
  const rejected = await store.dispatch(request('append-too-early', {
    type: 'transcript/append',
    segment: {
      id: 'segment-1',
      speaker: 'host',
      text: 'No active session exists.',
      timestamp: 10_001,
      status: 'final'
    }
  }), actor);

  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'REDUCER_REJECTED');
  assert.equal(store.getSnapshot().revision, 0);
});
