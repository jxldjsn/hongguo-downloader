'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pollingPath = path.join(__dirname, '..', 'src', 'utils', 'loginStatusPolling.mjs');
const pollingUrl = pathToFileURL(pollingPath).href;

test('login status polling module exists', () => {
  assert.equal(fs.existsSync(pollingPath), true);
});

test('poller checks immediately, every ten minutes, and after a credential change', async () => {
  const { createLoginStatusPoller, LOGIN_STATUS_REFRESH_MS } = await import(pollingUrl);
  let intervalCallback = null;
  let intervalDelay = null;
  let changeCallback = null;
  let refreshCalls = 0;
  const poller = createLoginStatusPoller({
    refresh: async () => { refreshCalls += 1; },
    subscribe: callback => {
      changeCallback = callback;
      return () => {};
    },
    setIntervalFn: (callback, delay) => {
      intervalCallback = callback;
      intervalDelay = delay;
      return 42;
    },
    clearIntervalFn: () => {},
  });

  poller.start();
  await poller.run();
  assert.equal(refreshCalls, 1);
  assert.equal(LOGIN_STATUS_REFRESH_MS, 600000);
  assert.equal(intervalDelay, 600000);

  intervalCallback();
  await poller.run();
  changeCallback({ platform: 'bilibili' });
  await poller.run();
  assert.equal(refreshCalls, 3);
});

test('poller coalesces refreshes and cleans its exact timer and subscription', async () => {
  const { createLoginStatusPoller } = await import(pollingUrl);
  let release;
  let refreshCalls = 0;
  let clearedTimer = null;
  let unsubscribed = 0;
  const deferred = new Promise(resolve => { release = resolve; });
  const poller = createLoginStatusPoller({
    refresh: () => {
      refreshCalls += 1;
      return deferred;
    },
    subscribe: () => () => { unsubscribed += 1; },
    setIntervalFn: () => 77,
    clearIntervalFn: timer => { clearedTimer = timer; },
  });

  const first = poller.run();
  const second = poller.run();
  assert.equal(first, second);
  assert.equal(refreshCalls, 1);
  release();
  await first;

  poller.start();
  poller.stop();
  poller.stop();
  assert.equal(clearedTimer, 77);
  assert.equal(unsubscribed, 1);
});
