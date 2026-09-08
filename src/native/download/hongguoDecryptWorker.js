'use strict';

const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const hongguo = require('../hongguo');

function assertAbsoluteFilePath(value, label) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute file path`);
  }
  return path.resolve(value);
}

try {
  const inputPath = assertAbsoluteFilePath(workerData?.inputPath, 'inputPath');
  const outputPath = assertAbsoluteFilePath(workerData?.outputPath, 'outputPath');
  if (inputPath === outputPath) throw new Error('inputPath and outputPath must differ');
  const key = Buffer.from(String(workerData?.keyHex || ''), 'hex');
  if (key.length === 0) throw new Error('decrypt key is required');

  hongguo.decryptMp4File(inputPath, outputPath, key, progress => {
    parentPort.postMessage({ type: 'progress', progress });
  });
  parentPort.postMessage({ type: 'done' });
} catch (error) {
  parentPort.postMessage({
    type: 'error',
    message: error?.message || '红果视频解密失败',
  });
}

