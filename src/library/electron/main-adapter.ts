import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents
} from 'electron';
import { errorPayload } from '../core/errors.js';
import type { CanonicalStateHost } from '../core/canonical-host.js';
import type {
  BridgeActor,
  DispatchResponse,
  SnapshotResponse
} from '../core/types.js';
import { STATE_BRIDGE_CHANNELS } from './channels.js';

export interface ElectronSenderContext {
  readonly sender: WebContents;
  readonly senderId: number;
  readonly url: string;
}

export interface InstallElectronStateBridgeOptions<State, Action> {
  readonly ipcMain: Pick<IpcMain, 'handle' | 'on' | 'removeHandler' | 'removeListener'>;
  readonly host: CanonicalStateHost<State, Action>;
  readonly getBroadcastTargets: () => readonly WebContents[];
  readonly isTrustedSender: (context: ElectronSenderContext) => boolean;
  readonly onBroadcastError?: (error: unknown, target: WebContents) => void;
}

export interface InstalledElectronStateBridge {
  dispose(): void;
}

function senderContext(event: IpcMainInvokeEvent | IpcMainEvent): ElectronSenderContext {
  return {
    sender: event.sender,
    senderId: event.sender.id,
    url: event.senderFrame?.url ?? event.sender.getURL()
  };
}

function actorFor(context: ElectronSenderContext): BridgeActor {
  return { kind: 'renderer', id: `web-contents-${context.senderId}` };
}

function untrustedDispatch<State>(): DispatchResponse<State> {
  return {
    ok: false,
    error: errorPayload(
      'UNTRUSTED_SENDER',
      'This renderer is not registered with the state bridge.'
    )
  };
}

function untrustedSnapshot<State>(): SnapshotResponse<State> {
  return {
    ok: false,
    error: errorPayload(
      'UNTRUSTED_SENDER',
      'This renderer is not registered with the state bridge.'
    )
  };
}

export function installElectronStateBridge<State, Action>(
  options: InstallElectronStateBridgeOptions<State, Action>
): InstalledElectronStateBridge {
  const onBroadcastError = options.onBroadcastError ?? (() => undefined);

  options.ipcMain.handle(
    STATE_BRIDGE_CHANNELS.getSnapshot,
    (event: IpcMainInvokeEvent): SnapshotResponse<State> => {
      const context = senderContext(event);
      if (!options.isTrustedSender(context)) {
        return untrustedSnapshot();
      }
      return {
        ok: true,
        value: { snapshot: options.host.getSnapshot() }
      };
    }
  );

  options.ipcMain.handle(
    STATE_BRIDGE_CHANNELS.dispatch,
    async (event: IpcMainInvokeEvent, request: unknown): Promise<DispatchResponse<State>> => {
      const context = senderContext(event);
      if (!options.isTrustedSender(context)) {
        return untrustedDispatch();
      }
      return options.host.dispatch(request, actorFor(context));
    }
  );

  const syncHandler = (event: IpcMainEvent, request: unknown): void => {
    const context = senderContext(event);
    event.returnValue = options.isTrustedSender(context)
      ? options.host.dispatchSync(request, actorFor(context))
      : untrustedDispatch();
  };
  options.ipcMain.on(STATE_BRIDGE_CHANNELS.dispatchSync, syncHandler);

  const unsubscribe = options.host.subscribe(({ commit }) => {
    for (const target of options.getBroadcastTargets()) {
      if (target.isDestroyed()) {
        continue;
      }
      const context: ElectronSenderContext = {
        sender: target,
        senderId: target.id,
        url: target.getURL()
      };
      if (!options.isTrustedSender(context)) {
        continue;
      }
      try {
        target.send(STATE_BRIDGE_CHANNELS.commit, commit);
      } catch (error) {
        onBroadcastError(error, target);
      }
    }
  });

  return {
    dispose(): void {
      unsubscribe();
      options.ipcMain.removeHandler(STATE_BRIDGE_CHANNELS.getSnapshot);
      options.ipcMain.removeHandler(STATE_BRIDGE_CHANNELS.dispatch);
      options.ipcMain.removeListener(STATE_BRIDGE_CHANNELS.dispatchSync, syncHandler);
    }
  };
}
