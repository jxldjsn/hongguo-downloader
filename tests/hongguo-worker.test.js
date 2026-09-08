'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runHongguoDecryptWorker } = require('../src/native/download/hongguoWorkerRunner');

test('Hongguo worker refuses an already-aborted job without creating output', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-worker-abort-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, 'input.mp4');
  const outputPath = path.join(directory, 'output.part');
  fs.writeFileSync(inputPath, Buffer.from('not-an-mp4'));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    runHongguoDecryptWorker({
      inputPath,
      outputPath,
      key: Buffer.alloc(16),
      signal: controller.signal,
    }),
    error => error && error.code === 'DOWNLOAD_ABORTED',
  );
  assert.equal(fs.existsSync(outputPath), false);
});

test('Hongguo worker reports decrypt errors and removes its exact output', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-worker-error-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputPath = path.join(directory, 'input.mp4');
  const outputPath = path.join(directory, 'output.part');
  fs.writeFileSync(inputPath, Buffer.from('not-an-mp4'));

  await assert.rejects(
    runHongguoDecryptWorker({
      inputPath,
      outputPath,
      key: Buffer.alloc(16),
    }),
    error => error && error.code === 'HONGGUO_DECRYPT_FAILED',
  );
  assert.equal(fs.existsSync(outputPath), false);
});

