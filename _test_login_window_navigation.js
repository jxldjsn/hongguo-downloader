const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function sourceSlice(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.notEqual(start, -1, `Missing source marker: ${startText}`);
  assert.notEqual(end, -1, `Missing source marker: ${endText}`);
  return source.slice(start, end);
}

// Execute the production configuration and CookieManager body with Electron
// interfaces replaced by minimal fakes. This verifies the real navigation path
// without opening a browser window or using the network.
const configSource = sourceSlice(
  'const PLATFORM_COOKIE_CONFIG =',
  'const CONTROL_PANEL_API_URL'
);
const cookieManagerSource = sourceSlice(
  'class CookieManager {',
  'const cookieManager = new CookieManager();'
);

let createdWindow;
const fakeSession = {
  clearCache: () => Promise.resolve(),
  clearStorageData: () => Promise.resolve(),
};

class FakeBrowserWindow {
  constructor(options) {
    this.options = options;
    this.loadedUrls = [];
    this.webContents = {
      setUserAgent() {},
      on() {},
    };
    createdWindow = this;
  }

  loadURL(url) {
    this.loadedUrls.push(url);
    return Promise.resolve();
  }

  isDestroyed() {
    return false;
  }

  on() {}
}

const context = {
  BrowserWindow: FakeBrowserWindow,
  Promise,
  __dirname,
  path,
  session: { fromPartition: () => fakeSession },
  guardExternalNavigation() {},
  setInterval: () => 1,
  clearInterval() {},
  console: { log() {}, warn() {}, error() {} },
};

vm.createContext(context);

const { CookieManager, getPlatformCookieConfig } = new vm.Script(
  `${configSource}\n${cookieManagerSource}\n({ CookieManager, getPlatformCookieConfig })`
).runInContext(context);

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const unhandled = [];
  const captureUnhandled = reason => unhandled.push(reason);

    process.on('unhandledRejection', captureUnhandled);
  try {
    assert.equal(
      getPlatformCookieConfig('kuaishou').loginUrl,
      'https://www.kuaishou.com/new-reco',
      '快手默认登录地址应为 https://www.kuaishou.com/new-reco'
    );

    const platforms = [
      'douyin',
      'tiktok',
      'yuanbao',
      'xiaohongshu',
      'kuaishou',
      'bilibili',
      'youtube',
    ];

    for (const platform of platforms) {
      createdWindow = null;
      const pendingLogin = new CookieManager().openLoginWindow(platform);
      assert.equal(typeof pendingLogin.then, 'function');

      // The real method awaits cache clearing before it calls loadURL().
      await nextTurn();
      await nextTurn();

      assert.ok(createdWindow, `${platform} should create a login BrowserWindow`);
      assert.equal(
        createdWindow.options.webPreferences.partition,
        `persist:${platform}`
      );
      assert.match(
        createdWindow.options.webPreferences.preload,
        /preload-login\.js$/
      );
      assert.deepEqual(createdWindow.loadedUrls, [
        getPlatformCookieConfig(platform).loginUrl,
      ]);
    }

    assert.deepEqual(unhandled, []);
    console.log('PASS: every login window receives its configured URL.');
  } finally {
    process.off('unhandledRejection', captureUnhandled);
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
