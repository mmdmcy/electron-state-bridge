import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATE_BRIDGE_PROTOCOL_VERSION,
  StateBridgeError
} from '../../.test-build/library/core/index.js';
import { RendererStoreClient } from '../../.test-build/library/renderer/index.js';

function validateCounterState(input) {
  if (
    input === null
    || typeof input !== 'object'
    || Array.isArray(input)
    || typeof input.count !== 'number'
    || !Number.isSafeInteger(input.count)
  ) {
    throw new Error('Invalid counter state.');
  }
  return { count: input.count };
}

function snapshot(revision, count) {
  return {
    protocolVersion: STATE_BRIDGE_PROTOCOL_VERSION,
    revision,
    state: { count }
  };
}

function commit(revision, count) {
  return {
    ...snapshot(revision, count),
    actionType: 'counter/increment',
    committedAt: 1_000 + revision,
    source: 'renderer'
  };
}

function success(revision, count, duplicate = false) {
  return {
    ok: true,
    value: {
      ack: { revision },
      snapshot: snapshot(revision, count),
      duplicate
    }
  };
}

function createFakeTransport(initial = snapshot(0, 0)) {
  let current = initial;
  let listener = null;
  let unsubscribeCount = 0;
  let snapshotRequests = 0;
  return {
    api: {
      async getSnapshot() {
        snapshotRequests += 1;
        return { ok: true, value: { snapshot: current } };
      },
      async dispatch() {
        return success(current.revision, current.state.count);
      },
      dispatchSync() {
        return success(current.revision, current.state.count);
      },
      onCommit(nextListener) {
        listener = nextListener;
        return () => {
          unsubscribeCount += 1;
          listener = null;
        };
      }
    },
    setSnapshot(next) {
      current = next;
    },
    emit(next) {
      listener?.(next);
    },
    get snapshotRequests() {
      return snapshotRequests;
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    }
  };
}

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('keeps getSnapshot stable, ignores stale events, and cleans up subscriptions', async () => {
  const fake = createFakeTransport();
  const store = new RendererStoreClient({
    transport: fake.api,
    initialSnapshot: snapshot(0, 0),
    validateState: validateCounterState,
    clientId: 'renderer-test'
  });
  await store.ready;

  const before = store.getSnapshot();
  assert.equal(store.getSnapshot(), before);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  fake.emit(commit(1, 1));
  assert.equal(store.getSnapshot().count, 1);
  assert.notEqual(store.getSnapshot(), before);
  assert.equal(notifications, 1);

  fake.emit(commit(1, 999));
  assert.equal(store.getSnapshot().count, 1);
  assert.equal(notifications, 1);

  unsubscribe();
  store.destroy();
  assert.equal(fake.unsubscribeCount, 1);
  assert.equal(store.getMetaSnapshot().status, 'destroyed');
});

test('detects a revision gap and requests a full resynchronization', async () => {
  const fake = createFakeTransport(snapshot(1, 1));
  const store = new RendererStoreClient({
    transport: fake.api,
    initialSnapshot: snapshot(0, 0),
    validateState: validateCounterState,
    clientId: 'renderer-gap'
  });
  await store.ready;
  assert.equal(store.getRevision(), 1);

  fake.setSnapshot(snapshot(3, 3));
  fake.emit(commit(3, 3));
  await flushAsync();

  assert.equal(store.getRevision(), 3);
  assert.equal(store.getSnapshot().count, 3);
  assert.equal(fake.snapshotRequests, 2);
  assert.deepEqual(store.getMetaSnapshot().lastGap, {
    expected: 2,
    received: 3,
    detectedAt: store.getMetaSnapshot().lastGap.detectedAt
  });
  assert.equal(store.getMetaSnapshot().status, 'ready');
  store.destroy();
});

test('queues a second resync when a gap appears during initial hydration', async () => {
  let listener = null;
  let resolveFirstSnapshot;
  let snapshotRequests = 0;
  const transport = {
    getSnapshot() {
      snapshotRequests += 1;
      if (snapshotRequests === 1) {
        return new Promise((resolve) => {
          resolveFirstSnapshot = resolve;
        });
      }
      return Promise.resolve({ ok: true, value: { snapshot: snapshot(3, 3) } });
    },
    async dispatch() {
      return success(3, 3);
    },
    dispatchSync() {
      return success(3, 3);
    },
    onCommit(nextListener) {
      listener = nextListener;
      return () => {
        listener = null;
      };
    }
  };

  const store = new RendererStoreClient({
    transport,
    initialSnapshot: snapshot(0, 0),
    validateState: validateCounterState,
    clientId: 'renderer-hydration-race'
  });

  listener?.(commit(3, 3));
  resolveFirstSnapshot({ ok: true, value: { snapshot: snapshot(0, 0) } });
  await store.ready;
  await flushAsync();
  await flushAsync();

  assert.equal(snapshotRequests, 2);
  assert.equal(store.getRevision(), 3);
  assert.equal(store.getSnapshot().count, 3);
  assert.equal(store.getMetaSnapshot().status, 'ready');
  store.destroy();
});

test('does not revive a destroyed store when hydration completes later', async () => {
  let resolveSnapshot;
  const transport = {
    getSnapshot() {
      return new Promise((resolve) => {
        resolveSnapshot = resolve;
      });
    },
    async dispatch() {
      return success(1, 1);
    },
    dispatchSync() {
      return success(1, 1);
    },
    onCommit() {
      return () => undefined;
    }
  };
  const store = new RendererStoreClient({
    transport,
    initialSnapshot: snapshot(0, 0),
    validateState: validateCounterState,
    clientId: 'renderer-destroy-race'
  });

  store.destroy();
  resolveSnapshot({ ok: true, value: { snapshot: snapshot(1, 1) } });
  await store.ready;

  assert.equal(store.getRevision(), 0);
  assert.equal(store.getMetaSnapshot().status, 'destroyed');
});

test('applies the returned snapshot before dispatchSync returns', async () => {
  const fake = createFakeTransport();
  fake.api.dispatchSync = () => success(1, 7);
  const store = new RendererStoreClient({
    transport: fake.api,
    initialSnapshot: snapshot(0, 0),
    validateState: validateCounterState,
    clientId: 'renderer-sync'
  });
  await store.ready;

  const ack = store.dispatchSync({ type: 'counter/set', value: 7 });
  assert.equal(ack.revision, 1);
  assert.equal(store.getSnapshot().count, 7);
  assert.equal(store.getRevision(), 1);
  store.destroy();
});

test('can retry hydration after a transport throws synchronously', async () => {
  let attempts = 0;
  const transport = {
    getSnapshot() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('Synthetic synchronous transport failure.');
      }
      return Promise.resolve({ ok: true, value: { snapshot: snapshot(2, 2) } });
    },
    async dispatch() {
      return success(2, 2);
    },
    dispatchSync() {
      return success(2, 2);
    },
    onCommit() {
      return () => undefined;
    }
  };
  const store = new RendererStoreClient({
    transport,
    initialSnapshot: snapshot(0, 0),
    validateState: validateCounterState,
    clientId: 'renderer-sync-throw'
  });

  await assert.rejects(
    store.ready,
    (error) => error instanceof StateBridgeError && error.code === 'TRANSPORT_ERROR'
  );
  assert.equal(store.getMetaSnapshot().status, 'error');

  await store.resync('retry-after-sync-throw');
  assert.equal(attempts, 2);
  assert.equal(store.getRevision(), 2);
  assert.equal(store.getSnapshot().count, 2);
  assert.equal(store.getMetaSnapshot().status, 'ready');
  store.destroy();
});

test('turns malformed transport responses into a typed transport error', async () => {
  const fake = createFakeTransport();
  fake.api.dispatch = async () => ({ ok: true, value: { broken: true } });
  const store = new RendererStoreClient({
    transport: fake.api,
    initialSnapshot: snapshot(0, 0),
    validateState: validateCounterState,
    clientId: 'renderer-malformed'
  });
  await store.ready;

  await assert.rejects(
    store.dispatch({ type: 'counter/set', value: 1 }),
    (error) => error instanceof StateBridgeError && error.code === 'TRANSPORT_ERROR'
  );
  assert.equal(store.getMetaSnapshot().lastError?.code, 'TRANSPORT_ERROR');
  store.destroy();
});
