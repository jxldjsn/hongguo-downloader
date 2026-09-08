'use strict';

const dns = require('dns').promises;
const { ABogus } = require('./encrypt/aBogus');
const { getStoredCredentialStatus } = require('./authStatus');

const DOUYIN_FOLLOWING_URL = 'https://www.douyin.com/aweme/v1/web/user/following/list/';
const DOUYIN_SELF_PROFILE_URL = 'https://www.douyin.com/aweme/v1/web/user/profile/self/';
const DOUYIN_ACCOUNT_INFO_URL = 'https://passport.douyin.com/passport/web/account/info/';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

const loginEvents = [];
const MAX_EVENTS = 50;

function recordLoginEvent(stage, detail = {}) {
  const event = {
    time: new Date().toISOString(),
    timestamp: Date.now(),
    stage,
    detail: typeof detail === 'string' ? { message: detail } : detail,
  };
  loginEvents.push(event);
  if (loginEvents.length > MAX_EVENTS) {
    loginEvents.shift();
  }
  const detailStr = typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log('[Douyin Diagnostic] [' + event.time + '] [' + stage + '] ' + detailStr);
  return event;
}

function getRecentLoginEvents() {
  return [...loginEvents];
}

function clearLoginEvents() {
  loginEvents.length = 0;
}

function maskValue(val) {
  const str = String(val || '').trim();
  if (!str) return '(empty)';
  if (str.length <= 8) return str.slice(0, 2) + '***' + str.slice(-2);
  return str.slice(0, 4) + '***' + str.slice(-4) + ' (len: ' + str.length + ')';
}

function parseCookieMap(cookieString) {
  const map = {};
  if (!cookieString || typeof cookieString !== 'string') return map;
  const parts = cookieString.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) map[name] = value;
  }
  return map;
}

function analyzeDouyinCookies(cookieMap) {
  const keys = Object.keys(cookieMap);
  const authKeys = [
    'sessionid_ss',
    'sessionid',
    'sid_guard',
    'sid_tt',
    'passport_auth_status',
    'passport_csrf_token',
    'passport_assist_user',
    'login_source',
    'odin_tt',
    'uid_tt',
    'bd_ticket_guard_client_data',
    'store-region',
    'store-region-src',
    'ttwid',
    'msToken',
  ];

  const keyStatus = {};
  for (const k of authKeys) {
    if (k in cookieMap) {
      keyStatus[k] = {
        present: true,
        preview: maskValue(cookieMap[k]),
        length: cookieMap[k].length,
      };
    } else {
      keyStatus[k] = {
        present: false,
      };
    }
  }

  const hasAnyAuthKey = ['sessionid_ss', 'sessionid', 'sid_guard', 'sid_tt', 'passport_auth_status']
    .some(k => Boolean(cookieMap[k]));

  return {
    totalCount: keys.length,
    allKeyNames: keys.sort(),
    hasAnyAuthKey,
    keyStatus,
  };
}

async function runDouyinProbes(cookieString, options = {}) {
  const axiosImpl = options.axiosImpl || require('axios');
  const timeoutMs = options.timeoutMs || 8000;
  const probes = [];

  const cookie = String(cookieString || '').trim();
  if (!cookie) {
    return {
      success: false,
      summary: '没有 Cookie，跳过远端探针测试',
      probes: [],
    };
  }

  // 探针 1: 关注列表接口 (核心探针)
  try {
    const aBogus = new ABogus(DEFAULT_UA);
    const baseParams = {
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      count: '20',
      max_time: '0',
    };
    const queryString = new URLSearchParams(baseParams).toString();
    const aBogusValue = aBogus.getValue(queryString, 'GET');
    const fullParams = { ...baseParams, a_bogus: aBogusValue };

    const startTime = Date.now();
    const resp = await axiosImpl({
      url: DOUYIN_FOLLOWING_URL,
      method: 'GET',
      params: fullParams,
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': 'https://www.douyin.com/?recommend=1',
        'Cookie': cookie,
        'Accept': 'application/json, text/plain, */*',
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    const elapsed = Date.now() - startTime;

    const isJson = typeof resp.data === 'object' && resp.data !== null;
    const statusCode = isJson ? resp.data.status_code : null;
    const statusMsg = isJson ? resp.data.status_msg : null;
    const isHtml = typeof resp.data === 'string' && (resp.data.includes('<!DOCTYPE html>') || resp.data.includes('<html'));

    let probeResult = 'unknown';
    let detailNote = '';
    if (resp.status === 200) {
      if (isJson) {
        if (statusCode === 0) {
          probeResult = 'logged-in';
          detailNote = '接口返回成功 (status_code: 0)，登录态完全有效！';
        } else if (statusCode === 8 || statusMsg === '用户未登录') {
          probeResult = 'logged-out';
          detailNote = '抖音服务端返回未登录 (status_code: ' + statusCode + ', msg: ' + statusMsg + ')';
        } else {
          probeResult = 'logged-in';
          detailNote = '接口返回 status_code: ' + statusCode + ', msg: ' + (statusMsg || 'ok');
        }
      } else if (isHtml) {
        probeResult = 'risk-blocked';
        detailNote = '接口返回了 HTML 页面（可能命中防爬滑块或安全验证页）';
      } else {
        probeResult = 'unrecognized-response';
        detailNote = '未识别的响应类型 (' + typeof resp.data + ')';
      }
    } else {
      probeResult = 'http-error-' + resp.status;
      detailNote = 'HTTP 响应状态码异常 (' + resp.status + ' ' + (resp.statusText || '') + ')';
    }

    probes.push({
      name: '关注列表接口 (following/list)',
      url: DOUYIN_FOLLOWING_URL,
      httpStatus: resp.status,
      elapsedMs: elapsed,
      result: probeResult,
      detailNote,
      responseSummary: {
        contentType: resp.headers ? resp.headers['content-type'] : null,
        isJson,
        statusCode,
        statusMsg,
        followingsCount: Array.isArray(resp.data?.followings) ? resp.data.followings.length : null,
        rawSnippet: typeof resp.data === 'string' ? resp.data.slice(0, 300) : JSON.stringify(resp.data).slice(0, 300),
      },
    });
  } catch (err) {
    probes.push({
      name: '关注列表接口 (following/list)',
      url: DOUYIN_FOLLOWING_URL,
      httpStatus: null,
      elapsedMs: null,
      result: 'network-error',
      detailNote: '网络请求失败: ' + err.message,
      error: { message: err.message, code: err.code },
    });
  }

  // 探针 2: 自身资料接口 (profile/self)
  try {
    const aBogus = new ABogus(DEFAULT_UA);
    const baseParams = {
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
    };
    const queryString = new URLSearchParams(baseParams).toString();
    const aBogusValue = aBogus.getValue(queryString, 'GET');
    const fullParams = { ...baseParams, a_bogus: aBogusValue };

    const startTime = Date.now();
    const resp = await axiosImpl({
      url: DOUYIN_SELF_PROFILE_URL,
      method: 'GET',
      params: fullParams,
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': 'https://www.douyin.com/?recommend=1',
        'Cookie': cookie,
        'Accept': 'application/json, text/plain, */*',
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    const elapsed = Date.now() - startTime;

    const isJson = typeof resp.data === 'object' && resp.data !== null;
    const user = resp.data?.user;
    const nickname = user?.nickname;
    const uid = user?.uid;
    const secUid = user?.sec_uid;

    probes.push({
      name: '用户资料接口 (profile/self)',
      url: DOUYIN_SELF_PROFILE_URL,
      httpStatus: resp.status,
      elapsedMs: elapsed,
      result: nickname ? 'logged-in' : (resp.data?.status_code === 8 ? 'logged-out' : 'unknown'),
      detailNote: nickname ? ('成功识别登录账号: ' + nickname + ' (UID: ' + uid + ')') : ('响应: status_code=' + resp.data?.status_code),
      userInfo: nickname ? { nickname, uid, secUid: maskValue(secUid) } : null,
      responseSummary: {
        isJson,
        statusCode: resp.data?.status_code,
        statusMsg: resp.data?.status_msg,
        rawSnippet: typeof resp.data === 'string' ? resp.data.slice(0, 300) : JSON.stringify(resp.data).slice(0, 300),
      },
    });
  } catch (err) {
    probes.push({
      name: '用户资料接口 (profile/self)',
      url: DOUYIN_SELF_PROFILE_URL,
      httpStatus: null,
      elapsedMs: null,
      result: 'network-error',
      detailNote: '网络请求失败: ' + err.message,
      error: { message: err.message, code: err.code },
    });
  }

  // 探针 3: Passport 账号信息接口 (passport/web/account/info)
  try {
    const startTime = Date.now();
    const resp = await axiosImpl({
      url: DOUYIN_ACCOUNT_INFO_URL,
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': 'https://www.douyin.com/',
        'Cookie': cookie,
        'Accept': 'application/json, text/plain, */*',
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    const elapsed = Date.now() - startTime;

    const isJson = typeof resp.data === 'object' && resp.data !== null;
    const name = resp.data?.data?.name || resp.data?.data?.user_id;

    probes.push({
      name: '通行证信息接口 (passport/account/info)',
      url: DOUYIN_ACCOUNT_INFO_URL,
      httpStatus: resp.status,
      elapsedMs: elapsed,
      result: name ? 'logged-in' : (resp.data?.message === 'error' ? 'logged-out' : 'ok'),
      detailNote: name ? ('通行证已登录: user_id=' + resp.data?.data?.user_id) : ('通行证返回: ' + (resp.data?.message || resp.status)),
      responseSummary: {
        isJson,
        message: resp.data?.message,
        data: resp.data?.data,
        rawSnippet: typeof resp.data === 'string' ? resp.data.slice(0, 300) : JSON.stringify(resp.data).slice(0, 300),
      },
    });
  } catch (err) {
    probes.push({
      name: '通行证信息接口 (passport/account/info)',
      url: DOUYIN_ACCOUNT_INFO_URL,
      httpStatus: null,
      elapsedMs: null,
      result: 'network-error',
      detailNote: '网络请求失败: ' + err.message,
      error: { message: err.message, code: err.code },
    });
  }

  return {
    success: true,
    probes,
  };
}

async function runDouyinDiagnostic(options = {}) {
  const db = options.db;
  const session = options.session;
  const axiosImpl = options.axiosImpl || require('axios');
  const now = new Date();

  const report = {
    diagnosedAt: now.toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      electronVersion: process.versions.electron || 'N/A',
      chromeVersion: process.versions.chrome || 'N/A',
    },
    dns: {},
    dbStorage: {},
    sessionPartition: {},
    localRuleCheck: {},
    remoteProbes: {},
    recentEvents: getRecentLoginEvents(),
    deduction: {
      status: 'unknown',
      summary: '',
      suggestedActions: [],
    },
  };

  // 1. DNS 测试
  try {
    const addresses = await dns.resolve4('www.douyin.com').catch(() => []);
    report.dns = {
      host: 'www.douyin.com',
      resolvedIps: addresses,
      status: addresses.length > 0 ? 'ok' : 'resolve-failed',
    };
  } catch (e) {
    report.dns = { host: 'www.douyin.com', status: 'error', error: e.message };
  }

  // 2. DB 本地存储分析
  const dbCookieString = db && typeof db.getKV === 'function'
    ? String(db.getKV('cookie_douyin', '') || '').trim()
    : '';
  const dbCookieMap = parseCookieMap(dbCookieString);
  const dbAnalysis = analyzeDouyinCookies(dbCookieMap);

  report.dbStorage = {
    hasStoredCookie: dbCookieString.length > 0,
    cookieLength: dbCookieString.length,
    totalCookies: dbAnalysis.totalCount,
    allKeyNames: dbAnalysis.allKeyNames,
    hasAuthKeys: dbAnalysis.hasAnyAuthKey,
    keyDetails: dbAnalysis.keyStatus,
  };

  // 3. Electron 会话分区分析
  if (session && typeof session.fromPartition === 'function') {
    try {
      const partition = session.fromPartition('persist:douyin');
      const allCookies = await partition.cookies.get({});
      const domainGroups = {};

      for (const c of allCookies) {
        const d = String(c.domain || '').toLowerCase();
        if (!domainGroups[d]) domainGroups[d] = [];
        domainGroups[d].push(c.name);
      }

      const partitionCookieMap = {};
      allCookies.forEach(c => {
        if (c.name && c.value) partitionCookieMap[c.name] = c.value;
      });
      const partitionAnalysis = analyzeDouyinCookies(partitionCookieMap);

      report.sessionPartition = {
        accessible: true,
        totalCookies: allCookies.length,
        domains: domainGroups,
        hasAuthKeys: partitionAnalysis.hasAnyAuthKey,
        keyDetails: partitionAnalysis.keyStatus,
      };
    } catch (e) {
      report.sessionPartition = {
        accessible: false,
        error: e.message,
      };
    }
  } else {
    report.sessionPartition = {
      accessible: false,
      note: 'Session 对象未传入或不可用',
    };
  }

  // 4. 本地规则检查
  const activeCookie = dbCookieString || '';
  const localRuleResult = getStoredCredentialStatus('douyin', activeCookie);
  report.localRuleCheck = {
    inputCookieLength: activeCookie.length,
    isValid: localRuleResult.isValid,
    isLoggedIn: localRuleResult.isLoggedIn,
    message: localRuleResult.message,
  };

  // 5. 远端接口探针测试
  if (activeCookie) {
    try {
      const probeData = await runDouyinProbes(activeCookie, { axiosImpl, timeoutMs: 8000 });
      report.remoteProbes = probeData;
    } catch (e) {
      report.remoteProbes = { success: false, error: e.message };
    }
  } else {
    report.remoteProbes = {
      success: false,
      summary: '未找到已保存的抖音 Cookie，未执行远端探针测试',
    };
  }

  // 6. 智能归因与诊断推导
  const hasDb = report.dbStorage.hasStoredCookie;
  const hasAuth = report.dbStorage.hasAuthKeys;
  const localLoggedIn = report.localRuleCheck.isLoggedIn;
  const probeList = report.remoteProbes.probes || [];
  const followingProbe = probeList.find(p => p.name.includes('following/list'));
  const profileProbe = probeList.find(p => p.name.includes('profile/self'));

  if (!hasDb) {
    report.deduction.status = 'no-cookie';
    report.deduction.summary = '本地数据库中未保存任何抖音 Cookie。扫码登录后可能未点击「确认登录并返回」，或者窗口关闭时未成功捕获 Cookie。';
    report.deduction.suggestedActions = [
      '点击「打开登录窗口」，在弹出的页面扫码登录',
      '手机扫码并确认后，务必点击弹窗右下角的「✓ 确认登录并返回」按钮',
      '若点击无反应，可以在浏览器中登录后使用「从本机浏览器导入」或「手动粘贴 Cookie」',
    ];
  } else if (!hasAuth) {
    report.deduction.status = 'missing-sessionid';
    report.deduction.summary = '已保存 ' + report.dbStorage.totalCookies + ' 个 Cookie，但缺少关键登录凭据（如 sessionid_ss / sessionid / sid_guard）。当前抓取到的主要是游客或临时标识。';
    report.deduction.suggestedActions = [
      '重新点击「打开登录窗口」',
      '扫码后在页面上等待 2~3 秒，确认右上角已出现个人头像/昵称后再点击「确认登录并返回」',
      '如果使用的是 Edge/Chrome，推荐直接使用「从本机浏览器导入」',
    ];
  } else if (followingProbe && followingProbe.result === 'risk-blocked') {
    report.deduction.status = 'risk-control';
    report.deduction.summary = '抖音服务端接口触发了安全验证或滑块验证码拦截，导致探针接口无法验证登录态。';
    report.deduction.suggestedActions = [
      '在登录窗口中浏览并播放任意 1~2 个视频，完成滑块验证',
      '尝试切换网络环境（如切换手机热点），避免 IP 被抖音风控',
    ];
  } else if (followingProbe && followingProbe.result === 'logged-out') {
    report.deduction.status = 'cookie-expired';
    report.deduction.summary = '本地存在 sessionid_ss 等凭据，但抖音服务器接口返回 status_code: 8（用户未登录），说明当前 Cookie 已在服务器端失效或被注销。';
    report.deduction.suggestedActions = [
      '点击「清除 Cookie」彻底清除旧凭据',
      '重新点击「打开登录窗口」重新扫码登录',
    ];
  } else if (profileProbe && profileProbe.userInfo) {
    report.deduction.status = 'healthy';
    report.deduction.summary = '登录态正常有效！已识别账号: ' + profileProbe.userInfo.nickname;
    report.deduction.suggestedActions = ['当前登录状态正常，可正常使用全部功能'];
  } else if (localLoggedIn && (!followingProbe || followingProbe.result === 'logged-in')) {
    report.deduction.status = 'logged-in-local';
    report.deduction.summary = '本地凭据完整有效，已判定为已登录状态。';
    report.deduction.suggestedActions = ['若主界面显示未登录，请点击右上角「↻ 检查登录状态」刷新'];
  } else {
    report.deduction.status = 'abnormal';
    report.deduction.summary = '登录态检测异常，请将下方的诊断报告复制并提供给技术支持排查。';
    report.deduction.suggestedActions = ['点击「复制完整诊断报告」发送给开发者'];
  }

  report.markdownReport = generateMarkdownReport(report);
  return report;
}

function generateMarkdownReport(r) {
  const lines = [];
  lines.push('# 🩺 抖音登录状态诊断报告');
  lines.push('- **诊断时间**: ' + r.diagnosedAt);
  lines.push('- **运行环境**: ' + r.environment.platform + ' (' + r.environment.arch + ') / Node: ' + r.environment.nodeVersion + ' / Electron: ' + r.environment.electronVersion);
  lines.push('- **DNS 解析**: ' + r.dns.host + ' -> ' + ((r.dns.resolvedIps || []).join(', ') || r.dns.status));
  lines.push('');

  lines.push('## 📊 综合诊断结果');
  lines.push('- **状态识别**: ' + r.deduction.status + '');
  lines.push('- **结论说明**: ' + r.deduction.summary);
  if (r.deduction.suggestedActions && r.deduction.suggestedActions.length > 0) {
    lines.push('- **建议操作**:');
    r.deduction.suggestedActions.forEach(function(act, i) { lines.push('  ' + (i + 1) + '. ' + act); });
  }
  lines.push('');

  lines.push('## 💾 本地持久化存储 (cookie_douyin)');
  lines.push('- **已保存 Cookie**: ' + (r.dbStorage.hasStoredCookie ? '✓ 是' : '✗ 否') + ' (字符长度: ' + (r.dbStorage.cookieLength || 0) + ')');
  lines.push('- **Cookie 条目数**: ' + (r.dbStorage.totalCookies || 0));
  lines.push('- **包含核心认证键**: ' + (r.dbStorage.hasAuthKeys ? '✓ 是' : '✗ 否'));
  if (r.dbStorage.keyDetails) {
    lines.push('- **核心认证键列表**:');
    for (const [k, v] of Object.entries(r.dbStorage.keyDetails)) {
      lines.push('  - ' + k + ': ' + (v.present ? ('✓ 存在 (' + v.preview + ')') : '✗ 缺失'));
    }
  }
  lines.push('- **所有 Cookie 键名**: ' + ((r.dbStorage.allKeyNames || []).join(', ') || '(无)') + '');
  lines.push('');

  lines.push('## 🌐 会话分区 (persist:douyin)');
  if (r.sessionPartition.accessible) {
    lines.push('- **分区内 Cookie 总数**: ' + (r.sessionPartition.totalCookies || 0));
    lines.push('- **包含核心认证键**: ' + (r.sessionPartition.hasAuthKeys ? '✓ 是' : '✗ 否'));
    if (r.sessionPartition.domains) {
      lines.push('- **域名分布**:');
      for (const [dom, keys] of Object.entries(r.sessionPartition.domains)) {
        lines.push('  - ' + dom + ' (' + keys.length + '): ' + keys.slice(0, 10).join(', ') + (keys.length > 10 ? ' ...' : ''));
      }
    }
  } else {
    lines.push('- **分区读取情况**: ' + (r.sessionPartition.note || r.sessionPartition.error || '不可用'));
  }
  lines.push('');

  lines.push('## 🔍 本地规则校验 (getStoredCredentialStatus)');
  lines.push('- **判定结果**: ' + (r.localRuleCheck.isLoggedIn ? '✓ 已登录 (true)' : '✗ 未登录 (false)'));
  lines.push('- **提示文案**: ' + r.localRuleCheck.message);
  lines.push('');

  lines.push('## 📡 远端 API 探针实测');
  if (r.remoteProbes && r.remoteProbes.probes && r.remoteProbes.probes.length > 0) {
    r.remoteProbes.probes.forEach(function(p, idx) {
      lines.push('### 探针 ' + (idx + 1) + ': ' + p.name);
      lines.push('- **HTTP 状态**: ' + (p.httpStatus || 'N/A') + ' (耗时: ' + (p.elapsedMs || 'N/A') + 'ms)');
      lines.push('- **探针判定**: ' + p.result + '');
      lines.push('- **详细说明**: ' + p.detailNote);
      if (p.userInfo) {
        lines.push('- **已识别用户**: 昵称 ' + p.userInfo.nickname + ' / UID ' + p.userInfo.uid + '');
      }
      if (p.responseSummary) {
        lines.push('- **响应摘要**: status_code=' + p.responseSummary.statusCode + ', status_msg=' + (p.responseSummary.statusMsg || '') + '');
        if (p.responseSummary.rawSnippet) {
          lines.push('- **响应片段**: ' + p.responseSummary.rawSnippet.replace(/[\\r\\n]+/g, ' ') + '');
        }
      }
      lines.push('');
    });
  } else {
    lines.push('- ' + (r.remoteProbes.summary || '未执行远端探针'));
    lines.push('');
  }

  lines.push('## 🕒 最近登录事件记录 (Flight Recorder)');
  if (r.recentEvents && r.recentEvents.length > 0) {
    r.recentEvents.slice(-15).forEach(function(e) {
      lines.push('- [' + e.time.split('T')[1].replace('Z', '') + '] **[' + e.stage + ']**: ' + JSON.stringify(e.detail));
    });
  } else {
    lines.push('- 暂无事件记录');
  }

  return lines.join('\\n');
}

module.exports = {
  recordLoginEvent,
  getRecentLoginEvents,
  clearLoginEvents,
  runDouyinDiagnostic,
  analyzeDouyinCookies,
  runDouyinProbes,
  maskValue,
  parseCookieMap,
};
