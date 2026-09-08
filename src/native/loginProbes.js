'use strict';

const { ABogus } = require('./encrypt/aBogus');

const BILIBILI_NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const DOUYIN_FOLLOWING_URL = 'https://www.douyin.com/aweme/v1/web/user/following/list/';
const XHS_EXPLORE_URL = 'https://www.xiaohongshu.com/explore';
const KUAISHOU_GRAPHQL_URL = 'https://www.kuaishou.com/graphql';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

function parseBilibiliNavLogin(payload) {
  const marker = payload && payload.data ? payload.data.isLogin : undefined;
  if (marker === 1 || marker === true) {
    return { isLoggedIn: true, message: 'B站已登录' };
  }
  if (marker === 0 || marker === false) {
    return { isLoggedIn: false, message: 'B站未登录' };
  }
  throw new Error('B站 nav 响应缺少 isLogin');
}

async function checkBilibiliLogin(cookieString, options = {}) {
  const cookie = String(cookieString || '').trim();
  if (!cookie) return { isLoggedIn: false, message: 'B站 Cookie 为空' };

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络检查');

  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 8000;
  const controller = !options.signal && typeof AbortController === 'function'
    ? new AbortController()
    : null;
  const signal = options.signal || controller?.signal;
  const timeout = controller && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetchImpl(BILIBILI_NAV_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        Cookie: cookie,
        Referer: 'https://www.bilibili.com/',
        Origin: 'https://www.bilibili.com',
      },
      signal,
    });
    if (!response || response.ok === false) {
      throw new Error(`B站 nav 请求失败 (${response?.status || 'unknown'})`);
    }
    const payload = await response.json();
    return parseBilibiliNavLogin(payload);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function parseDouyinLoginResponse(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('抖音探针响应非有效对象');
  }
  if (payload.status_code === 8 || payload.status_msg === '用户未登录') {
    return { isLoggedIn: false, message: '抖音 Cookie 已失效，请重新登录' };
  }
  if (typeof payload.status_code === 'number') {
    return { isLoggedIn: true, message: '抖音已登录' };
  }
  throw new Error('抖音探针响应缺少 status_code');
}

async function checkDouyinLogin(cookieString, options = {}) {
  const cookie = String(cookieString || '').trim();
  if (!cookie) return { isLoggedIn: false, message: '抖音 Cookie 为空' };

  const axiosImpl = options.axiosImpl || require('axios');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 8000;

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

  try {
    const response = await axiosImpl({
      url: DOUYIN_FOLLOWING_URL,
      method: 'GET',
      params: fullParams,
      headers: {
        'User-Agent': DEFAULT_UA,
        'Referer': 'https://www.douyin.com/?recommend=1',
        'Cookie': cookie,
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    if (!response || !response.data) {
      throw new Error('抖音探针未收到响应数据');
    }
    return parseDouyinLoginResponse(response.data);
  } catch (error) {
    if (error.message.includes('抖音探针')) throw error;
    throw new Error(`抖音登录探针请求失败 (${error.message})`);
  }
}

function parseXiaohongshuLoginResponse(status, html) {
  if (status === 500) {
    return { isLoggedIn: false, message: '小红书 Cookie 已失效，请重新登录' };
  }
  const body = String(html || '');
  if (body.includes('"loggedIn":true')) {
    return { isLoggedIn: true, message: '小红书已登录' };
  }
  if (body.includes('"loggedIn":false') || body.includes('"guest":true')) {
    return { isLoggedIn: false, message: '小红书 Cookie 已失效或未登录' };
  }
  throw new Error('小红书响应未能解析登录状态');
}

async function checkXiaohongshuLogin(cookieString, options = {}) {
  const cookie = String(cookieString || '').trim();
  if (!cookie) return { isLoggedIn: false, message: '小红书 Cookie 为空' };

  const axiosImpl = options.axiosImpl || require('axios');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 8000;

  try {
    const response = await axiosImpl({
      url: XHS_EXPLORE_URL,
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cookie': cookie,
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    return parseXiaohongshuLoginResponse(response.status, response.data);
  } catch (error) {
    if (error.message.includes('小红书')) throw error;
    throw new Error(`小红书登录探针请求失败 (${error.message})`);
  }
}

function parseKuaishouLoginResponse(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('快手探针响应非有效对象');
  }
  if (payload.data && payload.data.visionOwnerInfo && payload.data.visionOwnerInfo.id) {
    return { isLoggedIn: true, message: '快手已登录' };
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const firstErr = payload.errors[0];
    if (firstErr?.message === 'No Login OR Expired' || firstErr?.extensions?.code === 'UNAUTHENTICATED') {
      return { isLoggedIn: false, message: '快手 Cookie 已失效，请重新登录' };
    }
  }
  return { isLoggedIn: false, message: '快手 Cookie 已失效或未登录' };
}

async function checkKuaishouLogin(cookieString, options = {}) {
  const cookie = String(cookieString || '').trim();
  if (!cookie) return { isLoggedIn: false, message: '快手 Cookie 为空' };

  const axiosImpl = options.axiosImpl || require('axios');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 8000;

  try {
    const response = await axiosImpl({
      url: KUAISHOU_GRAPHQL_URL,
      method: 'POST',
      data: {
        operationName: 'visionOwnerInfo',
        variables: {},
        query: 'query visionOwnerInfo { visionOwnerInfo { id name } }',
      },
      headers: {
        'User-Agent': DEFAULT_UA,
        'Content-Type': 'application/json',
        'Referer': 'https://www.kuaishou.com/',
        'Origin': 'https://www.kuaishou.com',
        'Cookie': cookie,
      },
      timeout: timeoutMs,
      validateStatus: () => true,
    });

    if (!response || !response.data) {
      throw new Error('快手探针未收到响应数据');
    }
    return parseKuaishouLoginResponse(response.data);
  } catch (error) {
    if (error.message.includes('快手')) throw error;
    throw new Error(`快手登录探针请求失败 (${error.message})`);
  }
}

module.exports = {
  BILIBILI_NAV_URL,
  DOUYIN_FOLLOWING_URL,
  XHS_EXPLORE_URL,
  KUAISHOU_GRAPHQL_URL,
  parseBilibiliNavLogin,
  checkBilibiliLogin,
  parseDouyinLoginResponse,
  checkDouyinLogin,
  parseXiaohongshuLoginResponse,
  checkXiaohongshuLogin,
  parseKuaishouLoginResponse,
  checkKuaishouLogin,
};
