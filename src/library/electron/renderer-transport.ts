import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type { ActionRequest, StateBridgeTransport } from '../core/types.js';
import { STATE_BRIDGE_CHANNELS } from './channels.js';

export function createElectronRendererTransport<Action>(
  ipcRenderer: Pick<IpcRenderer, 'invoke' | 'sendSync' | 'on' | 'removeListener'>
): StateBridgeTransport<Action> {
  return Object.freeze({
    getSnapshot: () => ipcRenderer.invoke(STATE_BRIDGE_CHANNELS.getSnapshot),
    dispatch: (request: ActionRequest<Action>) =>
      ipcRenderer.invoke(STATE_BRIDGE_CHANNELS.dispatch, request),
    dispatchSync: (request: ActionRequest<Action>) =>
      ipcRenderer.sendSync(STATE_BRIDGE_CHANNELS.dispatchSync, request),
    onCommit: (listener: (commit: unknown) => void) => {
      const wrapped = (_event: IpcRendererEvent, commit: unknown): void => {
        listener(commit);
      };
      ipcRenderer.on(STATE_BRIDGE_CHANNELS.commit, wrapped);
      return () => {
        ipcRenderer.removeListener(STATE_BRIDGE_CHANNELS.commit, wrapped);
      };
    }
  });
}
