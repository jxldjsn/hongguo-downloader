'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  recordLoginEvent,
  getRecentLoginEvents,
  clearLoginEvents,
  analyzeDouyinCookies,
  runDouyinProbes,
  runDouyinDiagnostic,
  maskValue,
  parseCookieMap,
} = require('../src/native/douyinDiagnostic');

test('maskValue correctly masks credentials and displays length', () => {
  assert.equal(maskValue(''), '(empty)');
  assert.equal(maskValue(null), '(empty)');
  assert.equal(maskValue('abcdefgh'), 'ab***gh');
  assert.equal(maskValue('1234567890abcdef'), '1234***cdef (len: 16)');
});

test('parseCookieMap correctly extracts key-value pairs', () => {
  const cookieStr = 'sessionid_ss=abc12345; sid_guard=xyz999; ttwid=123';
  const map = parseCookieMap(cookieStr);
  assert.equal(map.sessionid_ss, 'abc12345');
  assert.equal(map.sid_guard, 'xyz999');
  assert.equal(map.ttwid, '123');
});

test('analyzeDouyinCookies identifies auth keys and builds key status', () => {
  const cookieMap = {
    sessionid_ss: 'abcdef123456',
    odin_tt: 'sample_odin',
    ttwid: 'sample_ttwid',
    random_cookie: '1',
  };
  const analysis = analyzeDouyinCookies(cookieMap);
  assert.equal(analysis.totalCount, 4);
  assert.equal(analysis.hasAnyAuthKey, true);
  assert.equal(analysis.keyStatus.sessionid_ss.present, true);
  assert.equal(analysis.keyStatus.sessionid.present, false);
});

test('recordLoginEvent logs and caps events buffer', () => {
  clearLoginEvents();
  recordLoginEvent('test-event-1', { data: 123 });
  recordLoginEvent('test-event-2', 'simple text');
  const events = getRecentLoginEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].stage, 'test-event-1');
  assert.equal(events[1].stage, 'test-event-2');
});

test('runDouyinProbes executes mock following and profile requests', async () => {
  const mockAxios = async (config) => {
    if (config.url.includes('following/list')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: { status_code: 0, status_msg: 'ok', followings: [{ uid: '1' }] },
      };
    }
    if (config.url.includes('profile/self')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: { status_code: 0, user: { nickname: '测试用户', uid: '123456', sec_uid: 'sec_123456789' } },
      };
    }
    if (config.url.includes('passport/web/account/info')) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: { message: 'success', data: { user_id: '123456', name: '测试用户' } },
      };
    }
    return { status: 404, data: {} };
  };

  const probeResult = await runDouyinProbes('sessionid_ss=mocked_session', { axiosImpl: mockAxios });
  assert.equal(probeResult.success, true);
  assert.equal(probeResult.probes.length, 3);
  assert.equal(probeResult.probes[0].result, 'logged-in');
  assert.equal(probeResult.probes[1].userInfo.nickname, '测试用户');
});

test('runDouyinDiagnostic outputs comprehensive structured and markdown report', async () => {
  const fakeDb = {
    getKV: (k) => (k === 'cookie_douyin' ? 'sessionid_ss=abc12345678; sid_guard=xyz;' : ''),
  };
  const fakeSession = {
    fromPartition: () => ({
      cookies: {
        get: async () => [
          { name: 'sessionid_ss', value: 'abc12345678', domain: '.douyin.com' },
          { name: 'ttwid', value: 'ttwid_value', domain: '.douyin.com' },
        ],
      },
    }),
  };
  const mockAxios = async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: { status_code: 0, status_msg: 'ok', user: { nickname: '抖音达人', uid: '999', sec_uid: 'sec_999' } },
  });

  const report = await runDouyinDiagnostic({ db: fakeDb, session: fakeSession, axiosImpl: mockAxios });
  assert.ok(report.diagnosedAt);
  assert.equal(report.dbStorage.hasStoredCookie, true);
  assert.equal(report.dbStorage.hasAuthKeys, true);
  assert.equal(report.sessionPartition.accessible, true);
  assert.equal(report.localRuleCheck.isLoggedIn, true);
  assert.ok(report.markdownReport.includes('🩺 抖音登录状态诊断报告'));
  assert.ok(report.markdownReport.includes('sessionid_ss'));
});
