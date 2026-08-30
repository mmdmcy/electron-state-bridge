import { contextBridge, ipcRenderer } from 'electron';
import { createElectronRendererTransport } from '../../library/electron/renderer-transport.js';
import type { AppAction } from '../domain/types.js';

const stateBridge = createElectronRendererTransport<AppAction>(ipcRenderer);
contextBridge.exposeInMainWorld('stateBridge', stateBridge);
