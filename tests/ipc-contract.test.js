'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(projectRoot, 'preload.js'), 'utf8');
const loginPreloadSource = fs.readFileSync(path.join(projectRoot, 'preload-login.js'), 'utf8');

function collectLiteralChannels(source, apiName, methodName) {
  const expression = new RegExp(
    `${apiName}\\.${methodName}\\(\\s*(['\"\\x60])([^'\"\\x60]+)\\1`,
    'g',
  );
  return new Set(Array.from(source.matchAll(expression), match => match[2]));
}

test('every renderer invoke channel has a main-process handler', () => {
  const invokes = collectLiteralChannels(preloadSource, 'ipcRenderer', 'invoke');
  const handlers = collectLiteralChannels(mainSource, 'ipcMain', 'handle');
  const missing = [...invokes].filter(channel => !handlers.has(channel));

  assert.ok(invokes.size > 0, 'preload should expose at least one invoke channel');
  assert.deepEqual(missing, []);
});

test('every renderer event subscription returns an exact unsubscribe function', () => {
  const subscriptions = collectLiteralChannels(preloadSource, 'ipcRenderer', 'on');
  assert.ok(subscriptions.size > 0, 'preload should expose at least one event subscription');

  for (const channel of subscriptions) {
    const escapedChannel = channel.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
    const cleanup = new RegExp(
      `return\\s*\\(\\)\\s*=>\\s*ipcRenderer\\.removeListener\\(\\s*['\"]${escapedChannel}['\"]\\s*,\\s*handler\\s*\\)`,
    );
    assert.match(preloadSource, cleanup, `${channel} must remove the same handler it registered`);
  }
});

test('login preload confirmation is consumed only by the owning login webContents', () => {
  assert.match(
    loginPreloadSource,
    /ipcRenderer\.send\(`login-confirmed-\$\{platform\}`\)/,
  );
  assert.match(mainSource, /loginWindow\.webContents\.on\('ipc-message'/);
  assert.match(mainSource, /channel === `login-confirmed-\$\{platform\}`/);
  assert.doesNotMatch(mainSource, /ipcMain\.(?:on|once)\(\s*['\"]login-confirmed-/);
});
