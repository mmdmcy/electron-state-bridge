import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const mode = process.argv[2];
if (mode !== 'integration' && mode !== 'benchmark') {
  console.error('Usage: node scripts/run-electron-mode.mjs <integration|benchmark>');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const projectRoot = resolve(import.meta.dirname, '..');
const marker = mode === 'integration'
  ? 'ELECTRON_INTEGRATION_RESULT '
  : 'ELECTRON_BENCHMARK_RESULT ';

const command = process.platform === 'linux' ? 'xvfb-run' : electronPath;
const args = process.platform === 'linux'
  ? ['-a', electronPath, '--no-sandbox', projectRoot]
  : ['--no-sandbox', projectRoot];
const ownsProcessGroup = process.platform !== 'win32';

const child = spawn(command, args, {
  cwd: projectRoot,
  detached: ownsProcessGroup,
  env: {
    ...process.env,
    ELECTRON_STATE_BRIDGE_MODE: mode,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
let finished = false;
let timedOut = false;
let completionTerminationInitiated = false;
let completionTimer;
let completionKillTimer;

function resultLineFromOutput() {
  return stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith(marker));
}

function terminateProcessTree(signal = 'SIGKILL') {
  if (child.pid === undefined) {
    return;
  }
  try {
    if (ownsProcessGroup) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return;
    }
    if (!finished) {
      console.error(`Unable to terminate Electron ${mode} process tree:`, error);
    }
  }
}

function scheduleVerifiedShutdown() {
  if (completionTimer !== undefined || resultLineFromOutput() === undefined) {
    return;
  }

  // Electron/Chromium descendants can retain inherited stdout/stderr handles
  // after the main process has emitted its final proof marker. The harness owns
  // an isolated process group, so once every assertion has passed we close that
  // group deliberately rather than let orphaned pipes hold CI open.
  clearTimeout(timeout);
  completionTimer = setTimeout(() => {
    if (finished) {
      return;
    }
    completionTerminationInitiated = true;
    terminateProcessTree('SIGTERM');
    completionKillTimer = setTimeout(() => {
      if (!finished) {
        terminateProcessTree('SIGKILL');
      }
    }, 2_000);
  }, 100);
}

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  process.stdout.write(chunk);
  scheduleVerifiedShutdown();
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
  process.stderr.write(chunk);
});

const timeout = setTimeout(() => {
  if (!finished) {
    timedOut = true;
    console.error(`Electron ${mode} mode exceeded the 45-second process guard.`);
    terminateProcessTree();
  }
}, 45_000);

child.on('error', (error) => {
  finished = true;
  clearTimeout(timeout);
  clearTimeout(completionTimer);
  clearTimeout(completionKillTimer);
  console.error(`Unable to launch Electron ${mode} mode:`, error);
  process.exitCode = 1;
});

child.on('close', (code, signal) => {
  finished = true;
  clearTimeout(timeout);
  clearTimeout(completionTimer);
  clearTimeout(completionKillTimer);
  const resultLine = resultLineFromOutput();
  const unexpectedExit = code !== 0 && !completionTerminationInitiated;

  if (timedOut || unexpectedExit || resultLine === undefined) {
    console.error(
      `Electron ${mode} mode failed (code=${String(code)}, signal=${String(signal)}, timedOut=${String(timedOut)}).`
    );
    if (resultLine === undefined) {
      console.error(`Expected output marker ${marker.trim()} was not produced.`);
    }
    if (stderr.trim().length === 0) {
      console.error('Electron produced no stderr diagnostics.');
    }
    process.exitCode = 1;
    return;
  }

  try {
    const payload = JSON.parse(resultLine.slice(marker.length));
    console.log(`${mode} verification parsed successfully:`);
    console.log(JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error(`Electron ${mode} mode produced an invalid result payload:`, error);
    process.exitCode = 1;
  }
});
