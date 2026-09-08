'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  isTrustedRendererUrl,
  assertTrustedSender,
  createTrustedIpcHandler,
  validateExternalUrl,
  validateHttpUrl,
  validateString,
} = require('../src/native/security/ipcGuards');

test('packaged and development renderer URLs are matched exactly', () => {
  assert.equal(isTrustedRendererUrl('file:///C:/app/dist-react/index.html', { packaged: true }), true);
  assert.equal(isTrustedRendererUrl('https://evil.example/', { packaged: true }), false);
  assert.equal(isTrustedRendererUrl('file:///C:/app/dist-react/index.html/extra', { packaged: true }), false);
  assert.equal(isTrustedRendererUrl('http://localhost:3000/page', { packaged: false }), true);
  assert.equal(isTrustedRendererUrl('http://localhost.evil:3000/', { packaged: false }), false);

  const appRoot = path.resolve('C:\\safe-app');
  assert.equal(
    isTrustedRendererUrl('file:///C:/safe-app/dist-react/index.html', { packaged: true, appRoot }),
    true,
  );
  assert.equal(
    isTrustedRendererUrl('file:///C:/other/dist-react/index.html', { packaged: true, appRoot }),
    false,
  );

  const sourceRoot = path.resolve(__dirname, '..');
  const localFallback = pathToFileURL(path.join(sourceRoot, 'dist-react', 'index.html')).href;
  const unrelatedLocalFile = pathToFileURL(path.join(sourceRoot, 'splash.html')).href;
  const sourcePolicy = {
    packaged: false,
    appRoot: sourceRoot,
    developmentOrigin: 'http://localhost:3000',
  };
  assert.equal(isTrustedRendererUrl(localFallback, sourcePolicy), true);
  assert.equal(isTrustedRendererUrl(unrelatedLocalFile, sourcePolicy), false);
});

test('external URL validation allows explicit HTTPS hosts only', () => {
  assert.equal(
    validateExternalUrl('https://allowed.example/path', ['allowed.example']),
    'https://allowed.example/path',
  );
  assert.equal(
    validateExternalUrl('https://video.allowed.example/path', ['*.allowed.example']),
    'https://video.allowed.example/path',
  );
  assert.throws(() => validateExternalUrl('file:///C:/secret', ['allowed.example']), /HTTPS/i);
  assert.throws(() => validateExternalUrl('custom://run', ['allowed.example']), /HTTPS/i);
  assert.throws(() => validateExternalUrl('https://user:pass@allowed.example/', ['allowed.example']), /凭据/);
  assert.throws(() => validateExternalUrl('https://evilallowed.example/', ['allowed.example']), /允许/);
  assert.throws(() => validateExternalUrl('https://allowed.example\n.evil/', ['allowed.example']), /控制字符|无效/);
});

test('HTTP and string validators reject ambiguous values', () => {
  assert.equal(validateHttpUrl('http://example.test/a'), 'http://example.test/a');
  assert.equal(validateHttpUrl('https://example.test/a'), 'https://example.test/a');
  assert.throws(() => validateHttpUrl('ftp://example.test/a'), /HTTP/i);
  assert.throws(() => validateString('', { name: '标题', minLength: 1 }), /标题/);
  assert.equal(validateString(' abc ', { name: '标题', maxLength: 5 }), 'abc');
});

test('assertTrustedSender rejects missing and remote senders', () => {
  const policy = { packaged: false };
  assert.equal(assertTrustedSender({ senderFrame: { url: 'http://localhost:3000/' } }, policy), true);
  assert.throws(
    () => assertTrustedSender({ senderFrame: { url: 'https://evil.example/' } }, policy),
    error => error && error.code === 'UNTRUSTED_RENDERER',
  );
  assert.throws(() => assertTrustedSender({}, policy), /不受信任/);
});

test('trusted IPC wrapper returns a stable rejection without running the handler', async () => {
  let calls = 0;
  const wrapped = createTrustedIpcHandler(async (_event, value) => {
    calls += 1;
    return { success: true, value };
  }, { packaged: false });

  assert.deepEqual(
    await wrapped({ senderFrame: { url: 'https://evil.example/' } }, 'secret'),
    { success: false, code: 'UNTRUSTED_RENDERER', error: '请求来源不受信任' },
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await wrapped({ senderFrame: { url: 'http://localhost:3000/' } }, 'ok'),
    { success: true, value: 'ok' },
  );
  assert.equal(calls, 1);
});
