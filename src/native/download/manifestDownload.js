'use strict';

const FFMPEG_PROTOCOL_ALLOWLIST = 'file,http,https,tcp,tls,crypto';
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function manifestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateManifestUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch (_) {
    throw manifestError('INVALID_MANIFEST_URL', '播放清单地址无效');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || !parsed.hostname
    || parsed.username
    || parsed.password) {
    throw manifestError('INVALID_MANIFEST_URL', '播放清单仅允许无凭据的 HTTP/HTTPS 地址');
  }
  return parsed.href;
}

function serializeFfmpegHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw manifestError('INVALID_DOWNLOAD_HEADER', '下载请求头结构无效');
  }
  const lines = [];
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (rawValue === null || typeof rawValue === 'undefined') continue;
    const name = String(rawName);
    const value = String(rawValue);
    if (!HEADER_NAME.test(name) || /[\r\n\0]/.test(value)) {
      throw manifestError('INVALID_DOWNLOAD_HEADER', '下载请求头包含非法字符');
    }
    lines.push(`${name}: ${value}\r\n`);
  }
  return lines.join('');
}

function buildManifestFfmpegArgs({ manifestUrl, headers = {}, partPath } = {}) {
  const safeUrl = validateManifestUrl(manifestUrl);
  if (typeof partPath !== 'string' || !partPath) {
    throw manifestError('INVALID_DOWNLOAD_PATH', '播放清单输出路径无效');
  }
  const args = [
    '-nostdin',
    '-y',
    '-protocol_whitelist', FFMPEG_PROTOCOL_ALLOWLIST,
  ];
  const serializedHeaders = serializeFfmpegHeaders(headers);
  if (serializedHeaders) args.push('-headers', serializedHeaders);
  args.push(
    '-i', safeUrl,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-f', 'mp4',
    partPath,
  );
  return args;
}

module.exports = {
  FFMPEG_PROTOCOL_ALLOWLIST,
  validateManifestUrl,
  serializeFfmpegHeaders,
  buildManifestFfmpegArgs,
};

