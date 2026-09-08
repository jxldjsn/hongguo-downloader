'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { runCancellableProcess } = require('../src/native/download/processRunner');

test('runCancellableProcess resolves exit 0 and streams stdout', async () => {
  const chunks = [];
  const result = await runCancellableProcess({
    command: process.execPath,
    args: ['-e', "process.stdout.write('ready')"],
    onStdout: chunk => chunks.push(chunk.toString()),
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'ready');
  assert.equal(chunks.join(''), 'ready');
});

test('runCancellableProcess forwards an explicit environment', async () => {
  const result = await runCancellableProcess({
    command: process.execPath,
    args: ['-e', "process.stdout.write(process.env.PROCESS_RUNNER_FIXTURE || 'missing')"],
    env: { ...process.env, PROCESS_RUNNER_FIXTURE: 'present' },
  });
  assert.equal(result.stdout, 'present');
});

test('runCancellableProcess rejects nonzero exit with capped stderr', async () => {
  await assert.rejects(
    runCancellableProcess({
      command: process.execPath,
      args: ['-e', "process.stderr.write('fixture failure'); process.exit(7)"],
    }),
    error => error
      && error.code === 'PROCESS_EXIT_NONZERO'
      && error.exitCode === 7
      && error.stderr.includes('fixture failure')
      && error.stderr.length <= 65536,
  );
});

test('AbortSignal terminates the exact spawned process and rejects as cancelled', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  const running = runCancellableProcess({
    command: process.execPath,
    args: ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
    signal: controller.signal,
    onStdout: chunk => {
      if (chunk.toString().includes('ready')) controller.abort();
    },
  });

  await assert.rejects(
    running,
    error => error && error.code === 'DOWNLOAD_ABORTED',
  );
});

test('a nonexistent executable rejects as a spawn failure without hanging', { timeout: 5000 }, async () => {
  const missing = path.join(os.tmpdir(), `missing-process-${Date.now()}.exe`);
  await assert.rejects(
    runCancellableProcess({ command: missing, args: [] }),
    error => error && error.code === 'PROCESS_SPAWN_FAILED',
  );
});
