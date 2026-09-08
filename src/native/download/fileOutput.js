'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;
const MAX_FINAL_FILENAME_LENGTH = 200;
const MAX_PART_FILENAME_LENGTH = 240;

function createOutputError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) {
    error.cause = cause;
    if (cause.code) error.systemCode = cause.code;
  }
  return error;
}

function truncateFilename(value, maxLength) {
  if (value.length <= maxLength) return value;
  const extension = path.extname(value);
  if (!extension || extension.length >= maxLength) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - extension.length)}${extension}`;
}

function sanitizeFilenameValue(input) {
  const segments = String(input ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment && segment !== '.' && segment !== '..');
  let value = segments.pop() || '';
  value = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '');

  if (!value || value === '.' || value === '..') return '';
  const deviceStem = value.split('.')[0].replace(/[. ]+$/g, '');
  if (WINDOWS_DEVICE_NAME.test(deviceStem)) value = `_${value}`;
  return truncateFilename(value, MAX_FINAL_FILENAME_LENGTH);
}

function sanitizeWindowsFilename(input, fallback = 'download') {
  return sanitizeFilenameValue(input)
    || sanitizeFilenameValue(fallback)
    || 'download';
}

function invalidDownloadPath() {
  return createOutputError(
    'INVALID_DOWNLOAD_PATH',
    'Download path is outside the allowed root',
  );
}

function resolveInsideRoot(root, relativeName) {
  if (typeof root !== 'string' || !root.trim()
    || typeof relativeName !== 'string' || !relativeName.trim()
    || path.isAbsolute(relativeName)
    || relativeName.includes(':')) {
    throw invalidDownloadPath();
  }

  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, relativeName);
  const relative = path.relative(rootPath, targetPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw invalidDownloadPath();
  }
  return targetPath;
}

function createPartPath(finalPath, taskId) {
  const directory = path.dirname(String(finalPath || ''));
  const filename = path.basename(String(finalPath || ''));
  const safeTaskId = (String(taskId || 'task').replace(/[^A-Za-z0-9_-]/g, '_') || 'task').slice(0, 64);
  const suffix = `.${safeTaskId}.part`;
  const safeFilename = truncateFilename(filename, MAX_PART_FILENAME_LENGTH - suffix.length);
  return path.join(directory, `${safeFilename}${suffix}`);
}

function reserveUniquePath(desiredPath, exists = fs.existsSync) {
  if (typeof exists !== 'function') throw new TypeError('exists must be a function');
  if (!exists(desiredPath)) return desiredPath;

  const directory = path.dirname(desiredPath);
  const extension = path.extname(desiredPath);
  const stem = path.basename(desiredPath, extension);
  for (let index = 1; index <= 100000; index += 1) {
    const candidate = path.join(directory, `${stem} (${index})${extension}`);
    if (!exists(candidate)) return candidate;
  }
  throw createOutputError('DOWNLOAD_PATH_EXHAUSTED', '无法为下载文件分配可用名称');
}

function createDirectoryTokenRegistry() {
  const grantsBySender = new Map();
  const senderKey = senderId => (
    senderId === null || typeof senderId === 'undefined' ? null : String(senderId)
  );
  const normalize = directory => {
    if (typeof directory !== 'string' || !directory.trim() || !path.isAbsolute(directory)) return null;
    const resolved = path.resolve(directory);
    const key = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
    return { key, resolved };
  };

  return Object.freeze({
    grant(senderId, directory) {
      const owner = senderKey(senderId);
      const normalized = normalize(directory);
      if (!owner || !normalized) throw invalidDownloadPath();
      let grants = grantsBySender.get(owner);
      if (!grants) {
        grants = new Map();
        grantsBySender.set(owner, grants);
      }
      grants.set(normalized.key, normalized.resolved);
      return normalized.resolved;
    },
    resolve(senderId, token) {
      const owner = senderKey(senderId);
      const normalized = normalize(token);
      if (!owner || !normalized) return null;
      return grantsBySender.get(owner)?.get(normalized.key) || null;
    },
    revokeSender(senderId) {
      const owner = senderKey(senderId);
      return owner ? grantsBySender.delete(owner) : false;
    },
  });
}

async function verifyNonEmptyFile(filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    throw createOutputError('DOWNLOAD_EMPTY_FILE', '下载文件不存在或为空', error);
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw createOutputError('DOWNLOAD_EMPTY_FILE', '下载文件不存在或为空');
  }
  return stat.size;
}

function abortedError(cause) {
  return createOutputError('DOWNLOAD_ABORTED', '下载已取消', cause);
}

async function destroyFileWriter(writer) {
  if (!writer) return;
  if (!writer.destroyed) writer.destroy();
  if (writer.closed) return;
  await new Promise(resolve => {
    const finish = () => {
      writer.removeListener('close', finish);
      resolve();
    };
    writer.once('close', finish);
    if (writer.closed) finish();
  });
}

async function writeStreamToPart({
  readable,
  finalPath,
  taskId,
  expectedLength = 0,
  signal,
  onProgress,
  transform,
} = {}) {
  if (!readable || typeof readable.pipe !== 'function') {
    throw new TypeError('readable stream is required');
  }
  if (typeof finalPath !== 'string' || !finalPath) {
    throw invalidDownloadPath();
  }

  const partPath = createPartPath(finalPath, taskId);
  const expected = Number(expectedLength);
  let bytes = 0;
  let counter;
  let writer;

  try {
    if (signal && signal.aborted) throw abortedError();
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.rm(partPath, { force: true });

    counter = new Transform({
      transform(chunk, encoding, callback) {
        bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
        try {
          if (typeof onProgress === 'function') onProgress(bytes);
          callback(null, chunk);
        } catch (error) {
          callback(error);
        }
      },
    });
    writer = fs.createWriteStream(partPath, { flags: 'wx' });

    const streams = transform
      ? [readable, transform, counter, writer]
      : [readable, counter, writer];
    if (signal) await pipeline(...streams, { signal });
    else await pipeline(...streams);
    if (signal && signal.aborted) throw abortedError();

    const handle = await fs.promises.open(partPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    const size = await verifyNonEmptyFile(partPath);
    if (Number.isFinite(expected) && expected > 0 && size !== expected) {
      throw createOutputError(
        'DOWNLOAD_INTEGRITY_FAILED',
        `下载文件长度不完整（期望 ${expected} 字节，实际 ${size} 字节）`,
      );
    }
    if (size !== bytes) {
      throw createOutputError('DOWNLOAD_INTEGRITY_FAILED', '下载文件写入长度校验失败');
    }
    if (signal && signal.aborted) throw abortedError();

    await fs.promises.rename(partPath, finalPath);
    return { finalPath, bytes: size };
  } catch (error) {
    if (readable && typeof readable.destroy === 'function' && !readable.destroyed) readable.destroy();
    if (transform && typeof transform.destroy === 'function' && !transform.destroyed) transform.destroy();
    if (counter && !counter.destroyed) counter.destroy();
    await destroyFileWriter(writer);
    try { await fs.promises.rm(partPath, { force: true }); } catch (_) { /* exact task part only */ }

    if ((signal && signal.aborted) || error.code === 'ABORT_ERR' || error.name === 'AbortError') {
      if (error.code === 'DOWNLOAD_ABORTED') throw error;
      throw abortedError(error);
    }
    if (Number.isFinite(expected) && expected > 0 && bytes !== expected) {
      throw createOutputError(
        'DOWNLOAD_INTEGRITY_FAILED',
        `下载流提前结束（期望 ${expected} 字节，实际接收 ${bytes} 字节）`,
        error,
      );
    }
    if (error.code && error.code.startsWith('DOWNLOAD_')) throw error;
    throw createOutputError('DOWNLOAD_WRITE_FAILED', '下载文件写入失败', error);
  }
}

async function downloadHttpResponse({ response, finalPath, taskId, signal, onProgress, transform } = {}) {
  if (!response || !response.data || typeof response.data.pipe !== 'function') {
    throw new TypeError('HTTP response stream is required');
  }
  const headers = response.headers || {};
  const rawLength = headers['content-length'] ?? headers['Content-Length'] ?? 0;
  const parsedLength = Number(rawLength);
  const totalBytes = Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : 0;

  return writeStreamToPart({
    readable: response.data,
    finalPath,
    taskId,
    expectedLength: totalBytes,
    signal,
    transform,
    onProgress: receivedBytes => {
      if (typeof onProgress !== 'function') return;
      onProgress({
        receivedBytes,
        totalBytes,
        progress: totalBytes ? Math.min(100, Math.floor((receivedBytes / totalBytes) * 100)) : 0,
      });
    },
  });
}

module.exports = {
  sanitizeWindowsFilename,
  resolveInsideRoot,
  createPartPath,
  reserveUniquePath,
  createDirectoryTokenRegistry,
  writeStreamToPart,
  downloadHttpResponse,
  verifyNonEmptyFile,
};
