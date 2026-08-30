import { useSyncExternalStore } from 'react';
import type { DeepReadonly, RendererStoreMeta } from '../core/types.js';
import type { RendererStoreClient } from '../renderer/renderer-store.js';

export function useRendererStore<State, Action>(
  store: RendererStoreClient<State, Action>
): DeepReadonly<State> {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
}

export function useRendererStoreMeta<State, Action>(
  store: RendererStoreClient<State, Action>
): RendererStoreMeta {
  return useSyncExternalStore(
    store.subscribeMeta,
    store.getMetaSnapshot,
    store.getMetaSnapshot
  );
}
