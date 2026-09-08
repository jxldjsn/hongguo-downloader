'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function untrustedRendererError() {
  const error = new Error('请求来源不受信任');
  error.code = 'UNTRUSTED_RENDERER';
  return error;
}

function parseUrl(value, label = 'URL') {
  if (typeof value !== 'string' || !value || CONTROL_CHARACTERS.test(value)) {
    throw new TypeError(`${label} 包含控制字符或格式无效`);
  }
  try {
    return new URL(value);
  } catch (cause) {
    const error = new TypeError(`${label} 无效`);
    error.cause = cause;
    throw error;
  }
}

function sameWindowsPath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
}

function isTrustedRendererUrl(value, policy = {}) {
  let parsed;
  try {
    parsed = parseUrl(value, '渲染页面地址');
  } catch (_) {
    return false;
  }

  if (parsed.protocol === 'file:') {
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    let filePath;
    try {
      filePath = fileURLToPath(parsed);
    } catch (_) {
      return false;
    }
    if (policy.appRoot) {
      return sameWindowsPath(filePath, path.join(policy.appRoot, 'dist-react', 'index.html'));
    }
    return policy.packaged === true
      && /(?:^|[\\/])dist-react[\\/]index\.html$/i.test(filePath);
  }

  if (policy.packaged === true) return false;

  const developmentOrigin = policy.developmentOrigin || 'http://localhost:3000';
  let allowed;
  try {
    allowed = new URL(developmentOrigin);
  } catch (_) {
    return false;
  }
  return parsed.protocol === allowed.protocol
    && parsed.hostname === allowed.hostname
    && parsed.port === allowed.port
    && !parsed.username
    && !parsed.password;
}

function assertTrustedSender(event, policy = {}) {
  let senderUrl = '';
  try {
    senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
  } catch (_) {
    throw untrustedRendererError();
  }
  if (!isTrustedRendererUrl(senderUrl, policy)) throw untrustedRendererError();
  return true;
}

function createTrustedIpcHandler(handler, policy = {}) {
  if (typeof handler !== 'function') throw new TypeError('IPC handler must be a function');
  return async (event, ...args) => {
    try {
      assertTrustedSender(event, policy);
    } catch (error) {
      if (error?.code !== 'UNTRUSTED_RENDERER') throw error;
      return {
        success: false,
        code: 'UNTRUSTED_RENDERER',
        error: '请求来源不受信任',
      };
    }
    return handler(event, ...args);
  };
}

function normalizedHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/\.$/, '');
}

function hostMatchesRule(hostname, rule) {
  const host = normalizedHostname(hostname);
  const normalizedRule = normalizedHostname(rule);
  if (!host || !normalizedRule) return false;
  if (normalizedRule.startsWith('*.')) {
    const base = normalizedRule.slice(2);
    return !!base && host !== base && host.endsWith(`.${base}`);
  }
  return host === normalizedRule;
}

function validateExternalUrl(value, allowedHosts = []) {
  const parsed = parseUrl(value, '外部链接');
  if (parsed.protocol !== 'https:') throw new TypeError('外部链接仅允许 HTTPS');
  if (parsed.username || parsed.password) throw new TypeError('外部链接不能包含内嵌凭据');
  if (!Array.isArray(allowedHosts) || !allowedHosts.some(rule => hostMatchesRule(parsed.hostname, rule))) {
    throw new TypeError('外部链接主机不在允许列表中');
  }
  parsed.hostname = normalizedHostname(parsed.hostname);
  return parsed.toString();
}

function validateHttpUrl(value, allowedHosts = null) {
  const parsed = parseUrl(value, 'HTTP 地址');
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('仅允许 HTTP 或 HTTPS 地址');
  if (parsed.username || parsed.password) throw new TypeError('HTTP 地址不能包含内嵌凭据');
  if (Array.isArray(allowedHosts)
    && !allowedHosts.some(rule => hostMatchesRule(parsed.hostname, rule))) {
    throw new TypeError('HTTP 地址主机不在允许列表中');
  }
  parsed.hostname = normalizedHostname(parsed.hostname);
  return parsed.toString();
}

function validateString(value, options = {}) {
  const name = options.name || '字符串';
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) {
    throw new TypeError(`${name}无效`);
  }
  const normalized = options.trim === false ? value : value.trim();
  const minLength = Number.isInteger(options.minLength) ? options.minLength : 0;
  const maxLength = Number.isInteger(options.maxLength) ? options.maxLength : 4096;
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new TypeError(`${name}长度无效`);
  }
  if (options.pattern instanceof RegExp && !options.pattern.test(normalized)) {
    throw new TypeError(`${name}格式无效`);
  }
  return normalized;
}

module.exports = {
  isTrustedRendererUrl,
  assertTrustedSender,
  createTrustedIpcHandler,
  validateExternalUrl,
  validateHttpUrl,
  validateString,
};
