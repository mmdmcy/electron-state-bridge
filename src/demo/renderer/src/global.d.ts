import type { StateBridgeTransport } from '../../../library/core/types.js';
import type { AppAction } from '../../domain/types.js';

declare global {
  interface Window {
    readonly stateBridge: StateBridgeTransport<AppAction>;
  }
}

export {};
