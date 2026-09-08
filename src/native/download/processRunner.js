'use strict';

const { spawn } = require('node:child_process');

const MAX_CAPTURE_LENGTH = 64 * 1024;

function processError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function capTail(current, chunk) {
  const combined = current + Buffer.from(chunk).toString('utf8');
  return combined.length > MAX_CAPTURE_LENGTH
    ? combined.slice(-MAX_CAPTURE_LENGTH)
    : combined;
}

function terminateProcessTree(child) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return Promise.resolve(false);
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(false);

  if (process.platform !== 'win32') {
    try { return Promise.resolve(child.kill('SIGTERM')); } catch (_) { return Promise.resolve(false); }
  }

  const pid = String(child.pid);
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let killer;
    try {
      killer = spawn('taskkill.exe', ['/PID', pid, '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (_) {
      try { child.kill(); } catch (_) {}
      done(false);
      return;
    }
    killer.once('error', () => {
      try { child.kill(); } catch (_) {}
      done(false);
    });
    killer.once('close', code => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch (_) {}
      }
      done(code === 0);
    });
  });
}

function rejectedRunner(error) {
  const promise = Promise.reject(error);
  Object.defineProperty(promise, 'child', { value: null, enumerable: true });
  return promise;
}

function runCancellableProcess({
  command,
  args = [],
  cwd,
  env,
  signal,
  onStdout,
  onStderr,
  windowsHide = true,
  onSpawn,
} = {}) {
  if (typeof command !== 'string' || !command) {
    return rejectedRunner(processError('PROCESS_SPAWN_FAILED', '外部程序路径无效'));
  }
  if (signal?.aborted) {
    return rejectedRunner(processError('DOWNLOAD_ABORTED', '下载已取消'));
  }

  let child;
  try {
    child = spawn(command, Array.isArray(args) ? args : [], {
      cwd,
      env,
      windowsHide,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    return rejectedRunner(processError('PROCESS_SPAWN_FAILED', '外部程序启动失败', { cause }));
  }

  if (typeof onSpawn === 'function') {
    try { onSpawn(child); } catch (_) { /* observer errors do not change process lifecycle */ }
  }

  const completion = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let aborted = false;

    const detach = () => {
      if (signal) signal.removeEventListener('abort', abort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      detach();
      callback(value);
    };
    const abort = () => {
      if (settled || aborted) return;
      aborted = true;
      void terminateProcessTree(child);
    };

    child.stdout?.on('data', chunk => {
      stdout = capTail(stdout, chunk);
      if (typeof onStdout === 'function') {
        try { onStdout(chunk); } catch (_) { /* progress observers are isolated */ }
      }
    });
    child.stderr?.on('data', chunk => {
      stderr = capTail(stderr, chunk);
      if (typeof onStderr === 'function') {
        try { onStderr(chunk); } catch (_) { /* progress observers are isolated */ }
      }
    });

    child.once('error', cause => {
      const error = aborted || signal?.aborted
        ? processError('DOWNLOAD_ABORTED', '下载已取消', { cause, stdout, stderr })
        : processError('PROCESS_SPAWN_FAILED', '外部程序启动失败', { cause, stdout, stderr });
      settle(reject, error);
    });
    child.once('close', (code, closeSignal) => {
      if (aborted || signal?.aborted) {
        settle(reject, processError('DOWNLOAD_ABORTED', '下载已取消', {
          exitCode: code,
          signal: closeSignal,
          stdout,
          stderr,
        }));
        return;
      }
      if (code === 0) {
        settle(resolve, { code, signal: closeSignal, stdout, stderr });
        return;
      }
      settle(reject, processError('PROCESS_EXIT_NONZERO', `外部程序退出（${code}）`, {
        exitCode: code,
        signal: closeSignal,
        stdout,
        stderr,
      }));
    });

    if (signal) {
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }
  });
  Object.defineProperty(completion, 'child', { value: child, enumerable: true });
  return completion;
}

module.exports = {
  runCancellableProcess,
  terminateProcessTree,
};
