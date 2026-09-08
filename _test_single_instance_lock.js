const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = source.indexOf('function setupSingleInstanceLock(');
const end = source.indexOf('let mainWindow = null;', start);

assert.notEqual(start, -1, 'main process should define the single-instance guard');
assert.notEqual(end, -1, 'main process should initialize its window after the guard helper');

const setupSingleInstanceLock = new vm.Script(
  `${source.slice(start, end)}\nsetupSingleInstanceLock`
).runInNewContext({});

function createFakeApp(lockGranted) {
  const listeners = new Map();
  return {
    quitCalled: false,
    requestSingleInstanceLock() {
      return lockGranted;
    },
    quit() {
      this.quitCalled = true;
    },
    on(event, listener) {
      listeners.set(event, listener);
    },
    emitSecondInstance() {
      listeners.get('second-instance')?.();
    },
    hasSecondInstanceHandler() {
      return listeners.has('second-instance');
    },
  };
}

const primaryApp = createFakeApp(true);
const windowCalls = [];
const primaryWindow = {
  isDestroyed: () => false,
  isMinimized: () => true,
  restore: () => windowCalls.push('restore'),
  show: () => windowCalls.push('show'),
  focus: () => windowCalls.push('focus'),
};

assert.equal(
  setupSingleInstanceLock(primaryApp, () => primaryWindow),
  true,
  'the primary process should continue starting'
);
assert.equal(primaryApp.quitCalled, false);
assert.equal(primaryApp.hasSecondInstanceHandler(), true);
primaryApp.emitSecondInstance();
assert.deepEqual(windowCalls, ['restore', 'show', 'focus']);

const secondaryApp = createFakeApp(false);
assert.equal(
  setupSingleInstanceLock(secondaryApp, () => primaryWindow),
  false,
  'a second process should not start another Electron instance'
);
assert.equal(secondaryApp.quitCalled, true);
assert.equal(secondaryApp.hasSecondInstanceHandler(), false);

console.log('PASS: duplicate Electron launches exit and focus the primary window.');
