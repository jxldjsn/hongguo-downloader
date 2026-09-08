'use strict';

const CREDENTIAL_RULES = Object.freeze({
  douyin: Object.freeze({
    anyOf: Object.freeze(['sessionid_ss', 'sessionid', 'sid_guard', 'sid_tt', 'passport_auth_status']),
  }),
  tiktok: Object.freeze({ anyOf: Object.freeze(['sessionid', 'sessionid_ss', 'sid_guard']) }),
  xiaohongshu: Object.freeze({ allOf: Object.freeze(['web_session']) }),
  // 快手扫码后会先写入临时 webday7_st；只有再出现 userId、passToken
  // （以及旧版兼容的 web_st 二选一）才代表浏览器会话真正完成登录。
  kuaishou: Object.freeze({
    allOf: Object.freeze(['userId']),
    anyOf: Object.freeze(['kuaishou.server.webday7_st', 'kuaishou.server.web_st']),
  }),
  bilibili: Object.freeze({ allOf: Object.freeze(['SESSDATA']) }),
  youtube: Object.freeze({ anyOf: Object.freeze(['__Secure-1PSID', 'SID']) }),
});

const TOP_LOGIN_PLATFORMS = Object.freeze([
  Object.freeze({ key: 'xiaohongshu', credentialKey: 'cookie_xiaohongshu', credentialPlatform: 'xiaohongshu' }),
  Object.freeze({ key: 'douyin', credentialKey: 'cookie_douyin', credentialPlatform: 'douyin' }),
  Object.freeze({ key: 'kuaishou', credentialKey: 'cookie_kuaishou', credentialPlatform: 'kuaishou' }),
  Object.freeze({ key: 'bilibili', credentialKey: 'cookie_bilibili', credentialPlatform: 'bilibili' }),
]);

function cookieNamesWithValues(cookieString) {
  const names = new Set();
  for (const pair of String(cookieString || '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name && value) names.add(name);
  }
  return names;
}

function getStoredCredentialStatus(platform, cookieString) {
  const rule = CREDENTIAL_RULES[platform];
  if (!rule) throw new TypeError(`不支持的平台: ${platform}`);

  const normalizedCookie = String(cookieString || '').trim();
  const names = cookieNamesWithValues(normalizedCookie);
  const hasAll = !rule.allOf || rule.allOf.every(name => names.has(name));
  const hasAny = !rule.anyOf || rule.anyOf.some(name => names.has(name));
  const isLoggedIn = hasAll && hasAny;

  return {
    isValid: normalizedCookie.length > 0,
    isLoggedIn,
    message: isLoggedIn
      ? 'Cookie有效，已登录'
      : (normalizedCookie ? 'Cookie存在但未登录' : 'Cookie为空'),
  };
}

function toPublicStatus(isLoggedIn, message) {
  return {
    state: isLoggedIn ? 'logged-in' : 'logged-out',
    isLoggedIn,
    message: String(message || (isLoggedIn ? '已登录' : '未登录')),
  };
}

function errorStatus() {
  return {
    state: 'error',
    isLoggedIn: false,
    message: '检查失败',
  };
}

function createLoginStatusService(options = {}) {
  const readCredential = options.readCredential;
  const checkCredential = options.checkCredential;
  const now = options.now || Date.now;
  if (typeof readCredential !== 'function') throw new TypeError('readCredential 必须是函数');

  let inFlight = null;

  async function checkPlatform(definition) {
    try {
      const cookieString = await readCredential(definition.credentialKey);
      const stored = getStoredCredentialStatus(definition.credentialPlatform, cookieString);
      if (stored.isLoggedIn && typeof checkCredential === 'function') {
        try {
          const remote = await checkCredential(definition.key, String(cookieString || ''));
          if (remote && typeof remote.isLoggedIn === 'boolean') {
            return toPublicStatus(remote.isLoggedIn, remote.message);
          }
        } catch (probeError) {
          return toPublicStatus(stored.isLoggedIn, stored.message);
        }
      }
      if (!stored.isLoggedIn) return toPublicStatus(false, '未登录');
      return toPublicStatus(true, '已登录');
    } catch (_) {
      return errorStatus();
    }
  }

  async function runCheck() {
    const entries = await Promise.all(TOP_LOGIN_PLATFORMS.map(async definition => [
      definition.key,
      await checkPlatform(definition),
    ]));
    return {
      success: true,
      checkedAt: now(),
      statuses: Object.fromEntries(entries),
    };
  }

  function getSummary() {
    if (inFlight) return inFlight;
    inFlight = runCheck().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return { getSummary };
}

module.exports = {
  CREDENTIAL_RULES,
  TOP_LOGIN_PLATFORMS,
  createLoginStatusService,
  getStoredCredentialStatus,
};
