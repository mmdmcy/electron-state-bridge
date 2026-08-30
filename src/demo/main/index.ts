import { app, BrowserWindow, ipcMain, type BrowserWindowConstructorOptions } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanonicalStateHost } from '../../library/core/canonical-host.js';
import { installElectronStateBridge } from '../../library/electron/main-adapter.js';
import {
  allowSynchronousAppAction,
  authorizeAppAction,
  createInitialAppState,
  reduceAppState,
  validateAppAction,
  type AppAction,
  type AppState
} from '../domain/index.js';
import { runIntegrationHarness, runSyncBenchmark } from './harness.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const executionMode = process.env.ELECTRON_STATE_BRIDGE_MODE;
const trustedWebContents = new Set<number>();
let overlayWindow: BrowserWindow | null = null;
let dashboardWindow: BrowserWindow | null = null;
let bridgeDisposed = false;

if (executionMode !== undefined) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
}

const host = new CanonicalStateHost<AppState, AppAction>({
  initialState: createInitialAppState(),
  reduce: reduceAppState,
  validateAction: validateAppAction,
  authorize: authorizeAppAction,
  allowSync: allowSynchronousAppAction,
  onListenerError: (error) => console.error('State bridge listener failed:', error)
});

const installedBridge = installElectronStateBridge({
  ipcMain,
  host,
  getBroadcastTargets: () => BrowserWindow.getAllWindows()
    .map((window) => window.webContents),
  isTrustedSender: ({ senderId }) => trustedWebContents.has(senderId),
  onBroadcastError: (error, target) => {
    console.error(`Commit broadcast failed for webContents ${target.id}:`, error);
  }
});

host.subscribe(({ action }) => {
  if (action.type !== 'insight/request') {
    return;
  }

  setTimeout(() => {
    const pending = host.getSnapshot().state.insights.items.find(
      (item) => item.id === action.insightId && item.status === 'pending'
    );
    if (pending === undefined) {
      return;
    }
    host.dispatchInternal(
      {
        type: 'insight/publish',
        insightId: action.insightId,
        text: `Synthetic insight for transcript revision ${action.transcriptRevision}: the bridge preserved an ordered, immutable session snapshot.`
      },
      'synthetic-insight'
    );
  }, 260);
});

function secureWindow(
  options: BrowserWindowConstructorOptions,
  registerWithBridge = true
): BrowserWindow {
  const { webPreferences, ...windowOptions } = options;
  const window = new BrowserWindow({
    ...windowOptions,
    show: false,
    backgroundColor: '#0c1017',
    webPreferences: {
      ...webPreferences,
      preload: join(currentDirectory, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false
    }
  });

  if (registerWithBridge) {
    trustedWebContents.add(window.webContents.id);
    window.once('closed', () => {
      trustedWebContents.delete(window.webContents.id);
    });
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    const currentUrl = window.webContents.getURL();
    if (currentUrl !== '' && targetUrl !== currentUrl) {
      event.preventDefault();
    }
  });
  return window;
}

async function loadDemo(window: BrowserWindow, view: 'overlay' | 'dashboard'): Promise<void> {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl !== undefined) {
    const url = new URL(developmentUrl);
    url.searchParams.set('view', view);
    await window.loadURL(url.toString());
  } else {
    await window.loadFile(join(currentDirectory, '../renderer/index.html'), {
      query: { view }
    });
  }
  window.show();
}

async function createOverlayWindow(): Promise<BrowserWindow> {
  const window = secureWindow({
    width: 430,
    height: 560,
    minWidth: 390,
    minHeight: 500,
    alwaysOnTop: true,
    title: 'Session Bridge Overlay'
  });
  await loadDemo(window, 'overlay');
  return window;
}

async function createDashboardWindow(): Promise<BrowserWindow> {
  const window = secureWindow({
    width: 1_160,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    title: 'Session Bridge Dashboard'
  });
  await loadDemo(window, 'dashboard');
  return window;
}

async function createHarnessWindow(registerWithBridge = true): Promise<BrowserWindow> {
  const window = secureWindow({ width: 500, height: 400 }, registerWithBridge);
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>state bridge harness</title>')}`
  );
  return window;
}

function disposeBridge(): void {
  if (!bridgeDisposed) {
    installedBridge.dispose();
    bridgeDisposed = true;
  }
}

async function launch(): Promise<void> {
  if (executionMode === 'integration') {
    await runIntegrationHarness({
      host,
      createWindow: () => createHarnessWindow(true),
      createUntrustedWindow: () => createHarnessWindow(false)
    });
    disposeBridge();
    app.exit(0);
    return;
  }
  if (executionMode === 'benchmark') {
    await runSyncBenchmark({ host, createWindow: () => createHarnessWindow(true) });
    disposeBridge();
    app.exit(0);
    return;
  }
  if (executionMode !== undefined) {
    throw new Error(`Unsupported ELECTRON_STATE_BRIDGE_MODE: ${executionMode}`);
  }

  overlayWindow = await createOverlayWindow();
  dashboardWindow = await createDashboardWindow();
}

app.whenReady().then(launch).catch((error: unknown) => {
  console.error('ELECTRON_STATE_BRIDGE_FATAL', error);
  app.exit(1);
});

app.on('activate', () => {
  if (executionMode === undefined && BrowserWindow.getAllWindows().length === 0) {
    void launch();
  }
});

app.on('window-all-closed', () => {
  if (executionMode !== undefined || process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  disposeBridge();
  overlayWindow = null;
  dashboardWindow = null;
});
