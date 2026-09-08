'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../src/native/loginProbes');

test('Bilibili nav login marker maps isLogin=1 to logged-in without exposing credentials', () => {
  const result = parseBilibiliNavLogin({ data: { isLogin: 1, uname: 'demo-user' } });
  assert.deepEqual(result, { isLoggedIn: true, message: 'B站已登录' });
  assert.doesNotMatch(JSON.stringify(result), /demo-user|SESSDATA/);
});

test('Bilibili nav login marker maps isLogin=0 to logged-out', () => {
  assert.deepEqual(
    parseBilibiliNavLogin({ data: { isLogin: 0 } }),
    { isLoggedIn: false, message: 'B站未登录' },
  );
});

test('Bilibili probe visits the fixed nav endpoint with the existing browser cookie', async () => {
  let request;
  const result = await checkBilibiliLogin('SESSDATA=secret', {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ data: { isLogin: 1 } }) };
    },
  });

  assert.equal(result.isLoggedIn, true);
  assert.equal(request.url, BILIBILI_NAV_URL);
  assert.equal(request.options.headers.Cookie, 'SESSDATA=secret');
  assert.equal(request.options.headers.Referer, 'https://www.bilibili.com/');
});

test('Bilibili probe reports malformed nav responses as errors without returning cookie data', async () => {
  await assert.rejects(
    () => checkBilibiliLogin('SESSDATA=secret', {
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: {} }) }),
    }),
    /isLogin/,
  );
});

test('Douyin probe maps status_code=8 (用户未登录) to logged-out (cookie expired)', () => {
  const result = parseDouyinLoginResponse({ status_code: 8, status_msg: '用户未登录' });
  assert.deepEqual(result, { isLoggedIn: false, message: '抖音 Cookie 已失效，请重新登录' });
});

test('Douyin probe maps valid status_code to logged-in', () => {
  const result = parseDouyinLoginResponse({ status_code: 0 });
  assert.deepEqual(result, { isLoggedIn: true, message: '抖音已登录' });
});

test('Douyin probe visits following endpoint with a_bogus and cookie', async () => {
  let request;
  const result = await checkDouyinLogin('sessionid_ss=secret', {
    axiosImpl: async (cfg) => {
      request = cfg;
      return { status: 200, data: { status_code: 0 } };
    },
  });

  assert.equal(result.isLoggedIn, true);
  assert.equal(request.url, DOUYIN_FOLLOWING_URL);
  assert.equal(request.headers.Cookie, 'sessionid_ss=secret');
  assert.ok(request.params.a_bogus);
});

test('Douyin probe correctly detects stale cookie returned status_code=8', async () => {
  const result = await checkDouyinLogin('sessionid_ss=stale_secret', {
    axiosImpl: async () => {
      return { status: 200, data: { status_code: 8, status_msg: '用户未登录' } };
    },
  });

  assert.equal(result.isLoggedIn, false);
  assert.equal(result.message, '抖音 Cookie 已失效，请重新登录');
});

test('Xiaohongshu probe maps status 500 or loggedIn:false to logged-out (cookie expired)', () => {
  assert.deepEqual(
    parseXiaohongshuLoginResponse(500, ''),
    { isLoggedIn: false, message: '小红书 Cookie 已失效，请重新登录' },
  );
  assert.deepEqual(
    parseXiaohongshuLoginResponse(200, '<script>window.__INITIAL_STATE__={"user":{"loggedIn":false}}</script>'),
    { isLoggedIn: false, message: '小红书 Cookie 已失效或未登录' },
  );
});

test('Xiaohongshu probe maps loggedIn:true to logged-in', () => {
  const result = parseXiaohongshuLoginResponse(
    200,
    '<script>window.__INITIAL_STATE__={"user":{"loggedIn":true,"userInfo":{"nickname":"demo"}}}</script>',
  );
  assert.deepEqual(result, { isLoggedIn: true, message: '小红书已登录' });
  assert.doesNotMatch(JSON.stringify(result), /demo/);
});

test('Xiaohongshu probe visits explore endpoint with existing cookie', async () => {
  let request;
  const result = await checkXiaohongshuLogin('web_session=secret', {
    axiosImpl: async (cfg) => {
      request = cfg;
      return { status: 200, data: '<script>window.__INITIAL_STATE__={"user":{"loggedIn":true}}</script>' };
    },
  });

  assert.equal(result.isLoggedIn, true);
  assert.equal(request.url, XHS_EXPLORE_URL);
  assert.equal(request.headers.Cookie, 'web_session=secret');
});

test('Kuaishou probe maps visionOwnerInfo presence to logged-in', () => {
  const result = parseKuaishouLoginResponse({
    data: { visionOwnerInfo: { id: 'ks-123', name: 'demo-user' } },
  });
  assert.deepEqual(result, { isLoggedIn: true, message: '快手已登录' });
  assert.doesNotMatch(JSON.stringify(result), /demo-user|ks-123/);
});

test('Kuaishou probe maps No Login OR Expired error to logged-out (cookie expired)', () => {
  const result = parseKuaishouLoginResponse({
    errors: [{ message: 'No Login OR Expired', extensions: { code: 'UNAUTHENTICATED' } }],
  });
  assert.deepEqual(result, { isLoggedIn: false, message: '快手 Cookie 已失效，请重新登录' });
});

test('Kuaishou probe visits graphql endpoint with existing cookie', async () => {
  let request;
  const result = await checkKuaishouLogin('kuaishou.server.webday7_st=secret', {
    axiosImpl: async (cfg) => {
      request = cfg;
      return {
        status: 200,
        data: { data: { visionOwnerInfo: { id: 'user-id' } } },
      };
    },
  });

  assert.equal(result.isLoggedIn, true);
  assert.equal(request.url, KUAISHOU_GRAPHQL_URL);
  assert.equal(request.headers.Cookie, 'kuaishou.server.webday7_st=secret');
});
