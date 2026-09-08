'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable, PassThrough, Transform } = require('node:stream');
const {
  sanitizeWindowsFilename,
  resolveInsideRoot,
  createPartPath,
  reserveUniquePath,
  writeStreamToPart,
  verifyNonEmptyFile,
  createDirectoryTokenRegistry,
  downloadHttpResponse,
} = require('../src/native/download/fileOutput');

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-file-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function createLocalDownloadServer(t) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (request.url === '/ok') {
      response.writeHead(200, { 'content-length': '4' });
      response.end('test');
      return;
    }
    if (request.url === '/short') {
      response.writeHead(200, { 'content-length': '4' });
      response.write('ab');
      setImmediate(() => response.destroy());
      return;
    }
    if (request.url === '/slow') {
      response.writeHead(200, { 'content-length': '10' });
      response.write('a');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, sockets };
}

function getLocalResponse(url, signal) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => resolve({ data: response, headers: response.headers }));
    request.once('error', reject);
    if (signal) {
      const abort = () => request.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      request.once('close', () => signal.removeEventListener('abort', abort));
    }
  });
}

async function waitFor(condition, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return true;
}

test('sanitizeWindowsFilename removes traversal and Windows-invalid names', () => {
  assert.equal(sanitizeWindowsFilename('CON .mp4'), '_CON .mp4');
  assert.equal(sanitizeWindowsFilename('../a:b?.mp4'), 'a_b_.mp4');
  assert.equal(sanitizeWindowsFilename('LPT1.txt'), '_LPT1.txt');
  assert.equal(sanitizeWindowsFilename('COM¹.txt'), '_COM¹.txt');
  assert.equal(sanitizeWindowsFilename('trailing.  '), 'trailing');
  assert.equal(sanitizeWindowsFilename('..'), 'download');
  assert.equal(sanitizeWindowsFilename(''), 'download');

  const longName = sanitizeWindowsFilename(`${'a'.repeat(300)}.mp4`);
  assert.ok(longName.length <= 200);
  assert.match(longName, /\.mp4$/);
});

test('resolveInsideRoot accepts descendants and rejects traversal or absolute input', t => {
  const root = createTempDir(t);
  assert.equal(resolveInsideRoot(root, path.join('nested', 'video.mp4')), path.join(root, 'nested', 'video.mp4'));

  for (const unsafe of ['../escape.mp4', path.join(root, 'absolute.mp4')]) {
    assert.throws(
      () => resolveInsideRoot(root, unsafe),
      error => error && error.code === 'INVALID_DOWNLOAD_PATH' && /outside/i.test(error.message),
    );
  }
  assert.throws(
    () => resolveInsideRoot(root, 'video.mp4:alternate-stream'),
    error => error && error.code === 'INVALID_DOWNLOAD_PATH',
  );
});

test('part and collision paths stay beside the requested final file', t => {
  const root = createTempDir(t);
  const desired = path.join(root, 'video.mp4');
  const partPath = createPartPath(desired, '../task:1');
  assert.equal(path.dirname(partPath), root);
  assert.match(partPath, /task_1\.part$/);
  assert.ok(path.basename(createPartPath(
    path.join(root, `${'v'.repeat(230)}.mp4`),
    'task'.repeat(80),
  )).length <= 240);

  const occupied = new Set([desired, path.join(root, 'video (1).mp4')]);
  assert.equal(
    reserveUniquePath(desired, candidate => occupied.has(candidate)),
    path.join(root, 'video (2).mp4'),
  );
});

test('directory tokens are scoped to the renderer that selected the folder', t => {
  const root = createTempDir(t);
  const sibling = `${root}-sibling`;
  const registry = createDirectoryTokenRegistry();
  const token = registry.grant(101, root);

  assert.equal(token, path.resolve(root));
  assert.equal(registry.resolve(101, root + path.sep), path.resolve(root));
  assert.equal(registry.resolve(202, root), null);
  assert.equal(registry.resolve(101, sibling), null);
  assert.equal(registry.revokeSender(101), true);
  assert.equal(registry.resolve(101, root), null);
});

test('writeStreamToPart fsyncs and atomically publishes a complete non-empty stream', async t => {
  const root = createTempDir(t);
  const finalPath = path.join(root, 'video.mp4');
  const result = await writeStreamToPart({
    readable: Readable.from([Buffer.from('abc')]),
    finalPath,
    taskId: 'task-ok',
    expectedLength: 3,
  });

  assert.deepEqual(result, { finalPath, bytes: 3 });
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'abc');
  assert.equal(fs.existsSync(createPartPath(finalPath, 'task-ok')), false);
  assert.equal(await verifyNonEmptyFile(finalPath), 3);
});

test('an incomplete stream removes only its own part file and never publishes', async t => {
  const root = createTempDir(t);
  const finalPath = path.join(root, 'video.mp4');
  const unrelatedPart = createPartPath(finalPath, 'another-task');
  fs.writeFileSync(unrelatedPart, 'keep');

  await assert.rejects(
    writeStreamToPart({
      readable: Readable.from([Buffer.from('ab')]),
      finalPath,
      taskId: 'task-short',
      expectedLength: 4,
    }),
    error => error && error.code === 'DOWNLOAD_INTEGRITY_FAILED',
  );

  assert.equal(fs.existsSync(finalPath), false);
  assert.equal(fs.existsSync(createPartPath(finalPath, 'task-short')), false);
  assert.equal(fs.readFileSync(unrelatedPart, 'utf8'), 'keep');
});

test('an empty unknown-length stream is rejected and not published', async t => {
  const root = createTempDir(t);
  const finalPath = path.join(root, 'empty.mp4');

  await assert.rejects(
    writeStreamToPart({
      readable: Readable.from([]),
      finalPath,
      taskId: 'task-empty',
      expectedLength: 0,
    }),
    error => error && error.code === 'DOWNLOAD_EMPTY_FILE',
  );

  assert.equal(fs.existsSync(finalPath), false);
  assert.equal(fs.existsSync(createPartPath(finalPath, 'task-empty')), false);
});

test('aborting a live stream destroys it and removes the exact part file', async t => {
  const root = createTempDir(t);
  const finalPath = path.join(root, 'slow.mp4');
  const source = new PassThrough();
  const controller = new AbortController();
  const downloading = writeStreamToPart({
    readable: source,
    finalPath,
    taskId: 'task-abort',
    expectedLength: 10,
    signal: controller.signal,
  });

  source.write(Buffer.from('a'));
  controller.abort();

  await assert.rejects(
    downloading,
    error => error && error.code === 'DOWNLOAD_ABORTED',
  );
  assert.equal(source.destroyed, true);
  assert.equal(fs.existsSync(finalPath), false);
  assert.equal(fs.existsSync(createPartPath(finalPath, 'task-abort')), false);
});

test('downloadHttpResponse publishes complete HTTP responses and rejects short or aborted streams', { timeout: 5000 }, async t => {
  const root = createTempDir(t);
  const { baseUrl, sockets } = await createLocalDownloadServer(t);

  const okPath = path.join(root, 'ok.mp4');
  const okResponse = await getLocalResponse(`${baseUrl}/ok`);
  const progressEvents = [];
  await downloadHttpResponse({
    response: okResponse,
    finalPath: okPath,
    taskId: 'http-ok',
    onProgress: event => progressEvents.push(event),
  });
  assert.equal(fs.readFileSync(okPath, 'utf8'), 'test');
  assert.deepEqual(progressEvents.at(-1), {
    receivedBytes: 4,
    totalBytes: 4,
    progress: 100,
  });

  const shortPath = path.join(root, 'short.mp4');
  const shortResponse = await getLocalResponse(`${baseUrl}/short`);
  await assert.rejects(
    downloadHttpResponse({ response: shortResponse, finalPath: shortPath, taskId: 'http-short' }),
    error => error && error.code === 'DOWNLOAD_INTEGRITY_FAILED',
  );
  assert.equal(fs.existsSync(shortPath), false);

  const slowPath = path.join(root, 'slow.mp4');
  const controller = new AbortController();
  const slowResponse = await getLocalResponse(`${baseUrl}/slow`, controller.signal);
  const slowDownload = downloadHttpResponse({
    response: slowResponse,
    finalPath: slowPath,
    taskId: 'http-slow',
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    slowDownload,
    error => error && error.code === 'DOWNLOAD_ABORTED',
  );
  assert.equal(fs.existsSync(slowPath), false);
  assert.equal(await waitFor(() => sockets.size === 0), true, 'all local HTTP sockets must close');
});

test('downloadHttpResponse pipelines an in-place length-preserving transform', async t => {
  const root = createTempDir(t);
  const finalPath = path.join(root, 'decoded.bin');
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      for (let index = 0; index < chunk.length; index += 1) chunk[index] ^= 0x20;
      callback(null, chunk);
    },
  });

  await downloadHttpResponse({
    response: {
      data: Readable.from([Buffer.from('TEST')]),
      headers: { 'content-length': '4' },
    },
    finalPath,
    taskId: 'http-transform',
    transform,
  });

  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'test');
});
