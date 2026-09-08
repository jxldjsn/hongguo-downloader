'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PAYLOAD_VERSION,
  FIELDS_BY_TYPE,
  buildTaskPayload,
  applyTaskPayload,
  validateTaskPayload,
} = require('../src/native/download/taskPayload');

const FIXTURES = Object.freeze({
  album: {
    albumItems: [
      { type: 'image', url: 'https://media.example/1.jpg', meta: { tags: ['cover'] } },
      { type: 'video', videoUrl: 'https://media.example/2.mp4' },
    ],
    albumFolderName: 'fixture-album',
    failedAlbumItems: [
      { index: 1, url: 'https://media.example/2.mp4', error: 'HTTP 403' },
    ],
    headers: { Referer: 'https://example.test/', nested: { values: ['a', 'b'] } },
  },
  dash: {
    dashVideoUrl: 'https://media.example/video.m4s',
    dashAudioUrl: 'https://media.example/audio.m4s',
    headers: { Authorization: 'Bearer fixture', nested: { values: ['dash'] } },
  },
  m3u8: {
    m3u8Url: 'https://media.example/master.m3u8',
    headers: { Referer: 'https://m3u8.example/', nested: { values: ['m3u8'] } },
  },
  mpd: {
    mpdUrl: 'https://media.example/manifest.mpd',
    headers: { Referer: 'https://mpd.example/', nested: { values: ['mpd'] } },
  },
  ytdl: {
    ytdlUrl: 'https://video.example/watch?v=fixture',
    ytdlMaxHeight: 1080,
  },
  hongguo: {
    hongguoInfo: { vid: 'hg-fixture', episode: 3, sources: [{ url: 'https://media.example/hg.mp4' }] },
    headers: { Referer: 'https://hongguo.example/', nested: { values: ['hongguo'] } },
  },
});

function assertDetached(actual, original, message) {
  if (!original || typeof original !== 'object') return;
  assert.notStrictEqual(actual, original, message);
  if (Array.isArray(original)) {
    for (let index = 0; index < original.length; index += 1) {
      assertDetached(actual[index], original[index], `${message}[${index}]`);
    }
    return;
  }
  for (const key of Object.keys(original)) {
    assertDetached(actual[key], original[key], `${message}.${key}`);
  }
}

function assertInvalid(payload, label) {
  const result = validateTaskPayload(payload);
  assert.equal(result.valid, false, label);
  assert.equal(typeof result.error, 'string', `${label}: error must be a string`);
  assert.ok(result.error.length > 0, `${label}: error must not be empty`);
}

test('buildTaskPayload serializes and applyTaskPayload restores every special task fixture', () => {
  assert.equal(PAYLOAD_VERSION, 1);

  for (const [type, data] of Object.entries(FIXTURES)) {
    const task = { id: `${type}-task`, type, ...data };
    const payload = buildTaskPayload(task);
    assert.deepEqual(payload, { version: 1, type, data }, `${type} payload shape`);

    for (const field of FIELDS_BY_TYPE[type]) {
      assertDetached(payload.data[field], task[field], `${type}.${field} build clone`);
    }

    const parsedPayload = JSON.parse(JSON.stringify(payload));
    const base = { id: task.id, type, status: 'failed' };
    const restored = applyTaskPayload(base, parsedPayload);
    assert.deepEqual(restored, { ...base, ...data }, `${type} restored task`);

    for (const field of FIELDS_BY_TYPE[type]) {
      assertDetached(restored[field], task[field], `${type}.${field} source clone`);
      assertDetached(restored[field], parsedPayload.data[field], `${type}.${field} payload clone`);
    }
  }
});

test('payload allowlists are immutable and runtime values or nested functions are never copied', () => {
  assert.ok(Object.isFrozen(FIELDS_BY_TYPE));
  for (const fields of Object.values(FIELDS_BY_TYPE)) {
    assert.ok(Object.isFrozen(fields));
  }
  assert.throws(() => { FIELDS_BY_TYPE.album.push('runtime'); }, TypeError);
  assert.throws(() => { FIELDS_BY_TYPE.album = ['runtime']; }, TypeError);

  const runtimeNames = [
    'cancelSource',
    'writer',
    'responseStream',
    'childProcess',
    'runtime',
    'ytdlProcess',
  ];
  const task = {
    type: 'album',
    albumItems: [{ url: 'https://media.example/1.jpg', transform() {} }],
    headers: {
      Referer: 'https://example.test/',
      nested: { callback: () => 'forbidden', keep: true },
    },
    albumFolderName: 'safe',
  };
  for (const name of runtimeNames) task[name] = { close() {}, secret: name };

  const payload = buildTaskPayload(task);
  const serialized = JSON.stringify(payload);
  for (const name of runtimeNames) {
    assert.equal(Object.prototype.hasOwnProperty.call(payload.data, name), false, name);
    assert.equal(serialized.includes(name), false, name);
  }

  const visit = value => {
    assert.notEqual(typeof value, 'function');
    if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(payload);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.data.albumItems[0], 'transform'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.data.headers.nested, 'callback'), false);
});

test('validateTaskPayload rejects malformed envelopes and unsupported versions', () => {
  const invalidPayloads = [
    null,
    [],
    {},
    { version: 1, type: '', data: {} },
    { version: 1, type: 'album', data: null },
    { version: 2, type: 'album', data: { albumItems: [{}] } },
    { version: '1', type: 'album', data: { albumItems: [{}] } },
  ];
  invalidPayloads.forEach((payload, index) => assertInvalid(payload, `malformed payload ${index}`));
});

test('validateTaskPayload enforces every special task key while allowing optional fields', () => {
  const validWithoutOptional = [
    { version: 1, type: 'album', data: { albumItems: [{ url: 'one' }] } },
    { version: 1, type: 'dash', data: { dashVideoUrl: 'video', dashAudioUrl: 'audio' } },
    { version: 1, type: 'm3u8', data: { m3u8Url: 'manifest' } },
    { version: 1, type: 'mpd', data: { mpdUrl: 'manifest' } },
    { version: 1, type: 'ytdl', data: { ytdlUrl: 'source' } },
    { version: 1, type: 'hongguo', data: { hongguoInfo: { vid: 'vid-1' } } },
  ];
  for (const payload of validWithoutOptional) {
    assert.deepEqual(validateTaskPayload(payload), { valid: true }, payload.type);
  }

  const missingOrInvalid = [
    { version: 1, type: 'album', data: { albumItems: [] } },
    { version: 1, type: 'album', data: {} },
    { version: 1, type: 'album', data: { albumItems: [{ url: 'one' }], failedAlbumItems: 'bad' } },
    { version: 1, type: 'dash', data: { dashVideoUrl: 'video' } },
    { version: 1, type: 'dash', data: { dashVideoUrl: '', dashAudioUrl: 'audio' } },
    { version: 1, type: 'm3u8', data: {} },
    { version: 1, type: 'mpd', data: { mpdUrl: '' } },
    { version: 1, type: 'ytdl', data: { ytdlUrl: '' } },
    { version: 1, type: 'ytdl', data: { ytdlUrl: 'source', ytdlMaxHeight: -1 } },
    { version: 1, type: 'ytdl', data: { ytdlUrl: 'source', ytdlMaxHeight: Infinity } },
    { version: 1, type: 'hongguo', data: { hongguoInfo: {} } },
    { version: 1, type: 'hongguo', data: { hongguoInfo: [] } },
  ];
  missingOrInvalid.forEach((payload, index) => assertInvalid(payload, `special payload ${index}`));
});

test('validateTaskPayload keeps ordinary and unknown task types compatible', () => {
  for (const type of ['video', 'comments', 'future-downloader']) {
    assert.deepEqual(validateTaskPayload({ version: 1, type, data: {} }), { valid: true });
  }
});

test('ordinary tasks without an explicit type use a file payload and retain request headers', () => {
  const headers = {
    Referer: 'https://media.example/',
    'User-Agent': 'offline-test-agent',
  };
  const task = { id: 'ordinary-file', status: 'failed', headers };

  const payload = buildTaskPayload(task);
  assert.deepEqual(payload, { version: 1, type: 'file', data: { headers } });
  assert.deepEqual(validateTaskPayload(payload), { valid: true });

  const restored = applyTaskPayload(
    { id: task.id, type: null, status: task.status },
    JSON.parse(JSON.stringify(payload)),
  );
  assert.deepEqual(restored.headers, headers);
  assert.notStrictEqual(restored.headers, headers);
});

test('unknown direct-download types retain generic request headers', () => {
  const task = {
    id: 'future-file',
    type: 'future-downloader',
    headers: { Referer: 'https://future.example/' },
  };
  const payload = buildTaskPayload(task);
  assert.deepEqual(payload.data, { headers: task.headers });
  const restored = applyTaskPayload({ id: task.id, type: task.type }, payload);
  assert.deepEqual(restored.headers, task.headers);
});
