'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateManifestUrl,
  serializeFfmpegHeaders,
  buildManifestFfmpegArgs,
} = require('../src/native/download/manifestDownload');

test('manifest URLs allow only credential-free HTTP and HTTPS', () => {
  assert.equal(validateManifestUrl('https://media.example/master.m3u8'), 'https://media.example/master.m3u8');
  assert.equal(validateManifestUrl('http://media.example/manifest.mpd'), 'http://media.example/manifest.mpd');

  for (const invalid of [
    'file:///C:/secret.txt',
    'concat:https://one|https://two',
    'ftp://media.example/file.m3u8',
    'https://user:pass@media.example/file.m3u8',
    'not a URL',
  ]) {
    assert.throws(
      () => validateManifestUrl(invalid),
      error => error && error.code === 'INVALID_MANIFEST_URL',
      invalid,
    );
  }
});

test('ffmpeg header serialization rejects CRLF and invalid header names', () => {
  assert.equal(
    serializeFfmpegHeaders({ Referer: 'https://example.test/', 'User-Agent': 'Fixture/1.0' }),
    'Referer: https://example.test/\r\nUser-Agent: Fixture/1.0\r\n',
  );
  assert.throws(
    () => serializeFfmpegHeaders({ Referer: 'ok\r\nX-Injected: yes' }),
    error => error && error.code === 'INVALID_DOWNLOAD_HEADER',
  );
  assert.throws(
    () => serializeFfmpegHeaders({ 'Bad Header': 'value' }),
    error => error && error.code === 'INVALID_DOWNLOAD_HEADER',
  );
});

test('manifest ffmpeg args use a strict protocol allowlist and explicit mp4 part output', () => {
  const args = buildManifestFfmpegArgs({
    manifestUrl: 'https://media.example/master.m3u8',
    headers: { Referer: 'https://example.test/' },
    partPath: 'C:\\Downloads\\video.task.part',
  });

  assert.deepEqual(args.slice(0, 4), ['-nostdin', '-y', '-protocol_whitelist', 'file,http,https,tcp,tls,crypto']);
  assert.ok(args.includes('-headers'));
  assert.ok(args.includes('https://media.example/master.m3u8'));
  assert.deepEqual(args.slice(-3), ['-f', 'mp4', 'C:\\Downloads\\video.task.part']);
});

