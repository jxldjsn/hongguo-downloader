'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const releaseRoot = path.join(projectRoot, 'release');
const electronPath = require('electron');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForFallbackPage(child, port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Electron source instance exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, {
        signal: AbortSignal.timeout(2000),
      });
      const targets = await response.json();
      const page = targets.find(target => target.type === 'page'
        && /\/dist-react\/index\.html$/.test(target.url));
      if (page) return page;
    } catch (_) {
      // Electron and its debugging endpoint can take a few seconds to become ready.
    }
    await delay(250);
  }
  throw new Error('Source fallback did not load dist-react/index.html within 30 seconds');
}

function evaluateSettings(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Timed out while evaluating the fallback-page IPC probe'));
    }, 10000);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: 'window.electronAPI.getSettings()',
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    });

    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text || 'IPC probe evaluation failed'));
        return;
      }
      resolve(message.result?.result?.value);
    });

    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Could not connect to the Electron debugging endpoint'));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(5000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  fs.mkdirSync(releaseRoot, { recursive: true });
  const smokeRoot = fs.mkdtempSync(path.join(releaseRoot, 'source-fallback-smoke-'));
  const stdoutPath = path.join(smokeRoot, 'electron.stdout.log');
  const stderrPath = path.join(smokeRoot, 'electron.stderr.log');
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  const port = await getFreeLoopbackPort();
  let child;

  try {
    child = spawn(electronPath, [
      '.',
      `--user-data-dir=${smokeRoot}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
    ], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['ignore', stdoutFd, stderrFd],
    });

    const page = await waitForFallbackPage(child, port);
    const settings = await evaluateSettings(page.webSocketDebuggerUrl);
    if (settings?.code === 'UNTRUSTED_RENDERER' || settings?.error === '请求来源不受信任') {
      throw new Error('Local fallback IPC was still rejected as untrusted');
    }
    if (!settings || !Number.isInteger(settings.concurrency)) {
      throw new Error(`Settings IPC returned an unexpected value: ${JSON.stringify(settings)}`);
    }

    console.log('SOURCE_FALLBACK_IPC=PASS');
    console.log(`RENDERER_URL=${page.url}`);
    console.log(`SETTINGS_CONCURRENCY=${settings.concurrency}`);
  } catch (error) {
    let stderr = '';
    try {
      stderr = fs.readFileSync(stderrPath, 'utf8').trim();
    } catch (_) {
      // Keep the original failure if no diagnostic log is available.
    }
    if (stderr) error.message += `\nElectron stderr:\n${stderr.slice(-2000)}`;
    throw error;
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    await stopChild(child);
    await delay(500);
    fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
