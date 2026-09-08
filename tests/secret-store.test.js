'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSecretStore,
  redactSecret,
} = require('../src/native/security/secretStore');

function createFakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: value => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: buffer => {
      const value = Buffer.from(buffer).toString('utf8');
      if (!value.startsWith('enc:')) throw new Error('invalid ciphertext');
      return value.slice(4);
    },
  };
}

function createMemorySecretStore(initial = new Map(), available = true) {
  const raw = new Map(initial);
  return {
    raw,
    store: createSecretStore({
      safeStorage: createFakeSafeStorage(available),
      getRaw: key => raw.get(key),
      setRaw: (key, value) => raw.set(key, value),
      deleteRaw: key => raw.delete(key),
    }),
  };
}

test('secret store encrypts plaintext at rest and decrypts it on read', () => {
  const { raw, store } = createMemorySecretStore();

  store.set('cookie_douyin', 'sessionid=plain-secret');

  const persisted = raw.get('cookie_douyin');
  assert.deepEqual(Object.keys(persisted).sort(), ['data', 'encrypted', 'v']);
  assert.equal(persisted.v, 1);
  assert.equal(persisted.encrypted, true);
  assert.doesNotMatch(JSON.stringify(persisted), /plain-secret/);
  assert.equal(
    Buffer.from(persisted.data, 'base64').toString('utf8'),
    'enc:sessionid=plain-secret',
  );
  assert.equal(store.get('cookie_douyin', ''), 'sessionid=plain-secret');
});

test('secret store migrates a legacy plaintext value on first read', () => {
  const { raw, store } = createMemorySecretStore(new Map([
    ['cookie_tiktok', 'sessionid=legacy-plain'],
  ]));

  assert.equal(store.get('cookie_tiktok', ''), 'sessionid=legacy-plain');
  const migrated = raw.get('cookie_tiktok');
  assert.equal(migrated.encrypted, true);
  assert.doesNotMatch(JSON.stringify(migrated), /legacy-plain/);
});

test('secret store refuses new plaintext when OS encryption is unavailable', () => {
  const { raw, store } = createMemorySecretStore(new Map(), false);

  assert.throws(
    () => store.set('cookie_douyin', 'sessionid=plain-secret'),
    error => error && error.code === 'SECURE_STORAGE_UNAVAILABLE',
  );
  assert.equal(raw.has('cookie_douyin'), false);
});

test('secret store deletes persisted values without exposing them', () => {
  const { raw, store } = createMemorySecretStore();
  store.set('cookie_youtube', 'SID=top-secret');

  assert.equal(store.delete('cookie_youtube'), true);
  assert.equal(raw.has('cookie_youtube'), false);
  assert.equal(store.get('cookie_youtube', ''), '');
});

test('redactSecret never contains a recoverable secret prefix', () => {
  const redacted = redactSecret('abcdef');
  assert.equal(typeof redacted, 'string');
  assert.doesNotMatch(redacted, /abc/);
  assert.notEqual(redacted, 'abcdef');
});
