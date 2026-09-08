'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

function workerError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function validateOptions({ inputPath, outputPath, key } = {}) {
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)
    || typeof outputPath !== 'string' || !path.isAbsolute(outputPath)
    || path.resolve(inputPath) === path.resolve(outputPath)) {
    throw workerError('INVALID_DOWNLOAD_PATH', '红果解密路径无效');
  }
  if (!Buffer.isBuffer(key) || key.length === 0) {
    throw workerError('HONGGUO_DECRYPT_FAILED', '红果解密密钥无效');
  }
}

async function removeExactOutput(outputPath) {
  try { await fs.promises.rm(outputPath, { force: true }); } catch (_) { /* exact worker output only */ }
}

function runHongguoDecryptWorker(options = {}) {
  validateOptions(options);
  const {
    inputPath,
    outputPath,
    key,
    signal,
    onProgress,
  } = options;

  if (signal?.aborted) {
    return Promise.reject(workerError('DOWNLOAD_ABORTED', '下载已取消'));
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'hongguoDecryptWorker.js'), {
      workerData: {
        inputPath: path.resolve(inputPath),
        outputPath: path.resolve(outputPath),
        keyHex: key.toString('hex'),
      },
    });
    let settled = false;

    const detach = () => {
      if (signal) signal.removeEventListener('abort', abort);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      detach();
      resolve({ outputPath: path.resolve(outputPath) });
    };

    const fail = async error => {
      if (settled) return;
      settled = true;
      detach();
      try { await worker.terminate(); } catch (_) {}
      await removeExactOutput(outputPath);
      reject(error);
    };

    const abort = () => {
      void fail(workerError('DOWNLOAD_ABORTED', '下载已取消'));
    };

    if (signal) signal.addEventListener('abort', abort, { once: true });
    worker.on('message', message => {
      if (!message || settled) return;
      if (message.type === 'progress') {
        if (typeof onProgress === 'function') onProgress(Number(message.progress) || 0);
        return;
      }
      if (message.type === 'done') {
        succeed();
        return;
      }
      if (message.type === 'error') {
        void fail(workerError(
          'HONGGUO_DECRYPT_FAILED',
          message.message || '红果视频解密失败',
        ));
      }
    });
    worker.on('error', error => {
      void fail(workerError('HONGGUO_DECRYPT_FAILED', '红果解密工作线程异常', error));
    });
    worker.on('exit', code => {
      if (!settled && code !== 0) {
        void fail(workerError('HONGGUO_DECRYPT_FAILED', `红果解密工作线程退出（${code}）`));
      }
    });
  });
}

module.exports = { runHongguoDecryptWorker };

