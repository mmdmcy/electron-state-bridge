import { STATE_BRIDGE_PROTOCOL_VERSION } from '../../../library/core/types.js';
import { RendererStoreClient } from '../../../library/renderer/renderer-store.js';
import {
  createInitialAppState,
  validateAppState,
  type AppAction,
  type AppState
} from '../../domain/index.js';

export const appStore = new RendererStoreClient<AppState, AppAction>({
  transport: window.stateBridge,
  initialSnapshot: {
    protocolVersion: STATE_BRIDGE_PROTOCOL_VERSION,
    revision: 0,
    state: createInitialAppState()
  },
  validateState: validateAppState,
  onAsyncError: (error) => console.error('Renderer state bridge error:', error)
});

void appStore.ready.catch((error: unknown) => {
  console.error('Initial state hydration failed:', error);
});
