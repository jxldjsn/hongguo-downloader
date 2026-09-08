'use strict';

const SECRET_RECORD_VERSION = 1;

function createSecretError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function assertAdapter(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('secret store options are required');
  }
  for (const name of ['getRaw', 'setRaw', 'deleteRaw']) {
    if (typeof options[name] !== 'function') {
      throw new TypeError(`${name} must be a function`);
    }
  }
}

function encryptionAvailable(safeStorage) {
  try {
    return !!safeStorage
      && typeof safeStorage.isEncryptionAvailable === 'function'
      && safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

function requireEncryption(safeStorage) {
  if (!encryptionAvailable(safeStorage)) {
    throw createSecretError(
      'SECURE_STORAGE_UNAVAILABLE',
      'Windows 凭据加密当前不可用，请重新登录 Windows 后再试',
    );
  }
}

function isEncryptedRecord(value) {
  return !!value
    && typeof value === 'object'
    && value.v === SECRET_RECORD_VERSION
    && value.encrypted === true
    && typeof value.data === 'string'
    && value.data.length > 0;
}

function createSecretStore(options) {
  assertAdapter(options);
  const { safeStorage, getRaw, setRaw, deleteRaw } = options;

  function set(key, value) {
    const plaintext = String(value ?? '');
    if (!plaintext) {
      deleteRaw(key);
      return;
    }

    requireEncryption(safeStorage);
    try {
      const ciphertext = safeStorage.encryptString(plaintext);
      setRaw(key, {
        v: SECRET_RECORD_VERSION,
        encrypted: true,
        data: Buffer.from(ciphertext).toString('base64'),
      });
    } catch (error) {
      if (error && error.code === 'SECURE_STORAGE_UNAVAILABLE') throw error;
      throw createSecretError('SECRET_ENCRYPT_FAILED', '凭据加密失败，未保存任何明文', error);
    }
  }

  function get(key, fallback = '') {
    const raw = getRaw(key);
    if (raw === undefined || raw === null || raw === '') return fallback;

    if (isEncryptedRecord(raw)) {
      requireEncryption(safeStorage);
      try {
        return safeStorage.decryptString(Buffer.from(raw.data, 'base64'));
      } catch (error) {
        if (error && error.code === 'SECURE_STORAGE_UNAVAILABLE') throw error;
        throw createSecretError('SECRET_DECRYPT_FAILED', '已保存的凭据无法解密，请清除后重新登录', error);
      }
    }

    if (typeof raw === 'string') {
      // 旧版本以明文保存。只有在能立即加密覆盖时才允许读取，避免继续使用明文副本。
      set(key, raw);
      return raw;
    }

    throw createSecretError('SECRET_FORMAT_INVALID', '已保存的凭据格式无效，请清除后重新登录');
  }

  function remove(key) {
    return deleteRaw(key) !== false;
  }

  return Object.freeze({
    get,
    set,
    delete: remove,
  });
}

function redactSecret(value) {
  const length = String(value ?? '').length;
  return `[REDACTED:${length}]`;
}

module.exports = {
  SECRET_RECORD_VERSION,
  createSecretStore,
  isEncryptedRecord,
  redactSecret,
};
