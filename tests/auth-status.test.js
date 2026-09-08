'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const authStatusPath = path.join(__dirname, '..', 'src', 'native', 'authStatus.js');

test('auth status service module exists', () => {
  assert.equal(fs.existsSync(authStatusPath), true);
});

test('stored credential status uses the exact sentinel for each platform', () => {
  const { getStoredCredentialStatus } = require(authStatusPath);
  const fixtures = [
    ['xiaohongshu', 'web_session=xhs-value'],
    ['douyin', 'sessionid_ss=douyin-value'],
    ['kuaishou', 'kuaishou.server.webday7_st=ks-value; userId=ks-user; passToken=ks-pass'],
    ['bilibili', 'SESSDATA=bili-value'],
    ['tiktok', 'sessionid=tiktok-value'],
    ['youtube', '__Secure-1PSID=youtube-value'],
  ];

  for (const [platform, cookie] of fixtures) {
    assert.equal(getStoredCredentialStatus(platform, cookie).isLoggedIn, true, platform);
    assert.equal(getStoredCredentialStatus(platform, '').isLoggedIn, false, `${platform} empty`);
  }

  assert.equal(
    getStoredCredentialStatus('kuaishou', 'kuaishou.server.webday7_st=ks-value').isLoggedIn,
    false,
    'kuaishou must have the complete browser session, not only the temporary sentinel',
  );

  assert.equal(getStoredCredentialStatus('bilibili', 'sessionid_ss=douyin-value').isLoggedIn, false);
  assert.equal(getStoredCredentialStatus('douyin', 'SESSDATA=bili-value').isLoggedIn, false);
});

test('unknown platforms are rejected by getStoredCredentialStatus', () => {
  const { getStoredCredentialStatus } = require(authStatusPath);
  assert.throws(() => getStoredCredentialStatus('unknown', 'token=value'), /不支持的平台/);
});

test('login summary returns sanitized statuses', async () => {
  const { createLoginStatusService } = require(authStatusPath);
  const credentials = new Map([
    ['cookie_xiaohongshu', 'web_session=xhs-secret'],
    ['cookie_douyin', 'sessionid_ss=douyin-secret'],
    ['cookie_kuaishou', 'other=value'],
    ['cookie_bilibili', 'SESSDATA=bili-secret'],
  ]);
  const service = createLoginStatusService({
    readCredential: key => credentials.get(key) || '',
    now: () => 123456,
  });

  const result = await service.getSummary();

  assert.equal(result.success, true);
  assert.equal(result.checkedAt, 123456);
  assert.deepEqual(Object.keys(result.statuses), [
    'xiaohongshu', 'douyin', 'kuaishou', 'bilibili',
  ]);
  assert.equal(result.statuses.xiaohongshu.state, 'logged-in');
  assert.equal(result.statuses.douyin.state, 'logged-in');
  assert.equal(result.statuses.kuaishou.state, 'logged-out');
  assert.equal(result.statuses.bilibili.state, 'logged-in');
  assert.doesNotMatch(JSON.stringify(result), /xhs-secret|douyin-secret|bili-secret/);
});

test('login summary isolates platform errors and coalesces concurrent checks', async () => {
  const { createLoginStatusService } = require(authStatusPath);
  const service = createLoginStatusService({
    readCredential: key => {
      if (key === 'cookie_kuaishou') throw new Error('encrypted store unavailable');
      return '';
    },
  });

  const [firstResult, secondResult] = await Promise.all([service.getSummary(), service.getSummary()]);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(firstResult.statuses.kuaishou.state, 'error');
  assert.equal(firstResult.statuses.douyin.state, 'logged-out');
});

test('platform probe can confirm a stale Bilibili cookie through the nav login marker', async () => {
  const { createLoginStatusService } = require(authStatusPath);
  const probed = [];
  const service = createLoginStatusService({
    readCredential: key => key === 'cookie_bilibili' ? 'SESSDATA=stale-session' : '',
    checkCredential: async (platform, cookie) => {
      probed.push({ platform, cookie });
      return { isLoggedIn: false, message: 'B站 nav 返回 isLogin=0' };
    },
  });

  const result = await service.getSummary();

  assert.deepEqual(probed, [{ platform: 'bilibili', cookie: 'SESSDATA=stale-session' }]);
  assert.equal(result.statuses.bilibili.state, 'logged-out');
  assert.equal(result.statuses.bilibili.isLoggedIn, false);
});
