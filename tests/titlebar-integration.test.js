'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
const readOptional = relativePath => {
  const target = path.join(projectRoot, relativePath);
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
};

const mainSource = read('main.js');
const preloadSource = read('preload.js');
const appSource = read('src/App.jsx');
const sidebarSource = read('src/components/Sidebar.jsx');
const titleBarSource = readOptional('src/components/TitleBar.jsx');
const titleBarCss = readOptional('src/components/TitleBar.css');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('only the main application window is frameless and retains the Windows thick frame', () => {
  const createMainWindow = sourceBetween(mainSource, 'function createMainWindow()', '// ===== Cookie管理器 =====');
  const loginWindow = sourceBetween(mainSource, 'async openLoginWindow', 'injectConfirmButton(platform)');

  assert.match(createMainWindow, /frame\s*:\s*false/);
  assert.match(createMainWindow, /thickFrame\s*:\s*true/);
  assert.doesNotMatch(loginWindow, /frame\s*:\s*false/);
});

test('trusted IPC controls only the sender window and publishes maximize state', () => {
  assert.match(mainSource, /ipcMain\.handle\('window-control'/);
  assert.match(mainSource, /ipcMain\.handle\('get-window-state'/);
  assert.match(mainSource, /BrowserWindow\.fromWebContents\(event\.sender\)/);
  assert.match(mainSource, /window\.minimize\(\)/);
  assert.match(mainSource, /window\.isMaximized\(\)[\s\S]*window\.unmaximize\(\)[\s\S]*window\.maximize\(\)/);
  assert.match(mainSource, /window\.close\(\)/);
  assert.match(mainSource, /mainWindow\.on\('maximize'/);
  assert.match(mainSource, /mainWindow\.on\('unmaximize'/);
  assert.match(mainSource, /webContents\.send\('window-state-changed'/);
});

test('login summary IPC is sanitized and credential changes emit only a platform key', () => {
  const summaryHandler = sourceBetween(mainSource, "ipcMain.handle('get-login-status-summary'", "ipcMain.handle('check-cookie-status'");
  assert.match(mainSource, /createLoginStatusService/);
  assert.match(summaryHandler, /loginStatusService\.getSummary\(\)/);
  assert.doesNotMatch(summaryHandler, /cookieString|entry\.value/);
  assert.match(mainSource, /function\s+notifyLoginStatusChanged\s*\(/);
  assert.match(mainSource, /webContents\.send\('login-status-changed',\s*\{\s*platform\s*:\s*[^}]+\}\)/);
  assert.ok((mainSource.match(/notifyLoginStatusChanged\s*\(/g) || []).length >= 5);
});

test('platform status handlers use the shared exact-platform checker', () => {
  const checkHandler = sourceBetween(mainSource, "ipcMain.handle('check-cookie-status'", '// ===== 控制端API处理程序 =====');
  const manualHandler = sourceBetween(mainSource, "ipcMain.handle('set-cookie-manual'", '// TikTok 登录态校验');
  assert.match(checkHandler, /requireCookiePlatform\s*\(/);
  assert.match(checkHandler, /getStoredCredentialStatus\s*\(/);
  assert.doesNotMatch(checkHandler, /douyinAPI\.checkCookieStatus/);
  assert.match(manualHandler, /getStoredCredentialStatus\s*\(/);
});

test('preload exposes login summary and sender-scoped window APIs with exact cleanup', () => {
  for (const name of [
    'getLoginStatusSummary', 'onLoginStatusChanged', 'minimizeWindow',
    'toggleMaximizeWindow', 'closeWindow', 'getWindowState', 'onWindowStateChanged',
  ]) {
    assert.match(preloadSource, new RegExp(`${name}\\s*:`), name);
  }
  assert.match(preloadSource, /invoke\('window-control',\s*'minimize'\)/);
  assert.match(preloadSource, /invoke\('window-control',\s*'toggle-maximize'\)/);
  assert.match(preloadSource, /invoke\('window-control',\s*'close'\)/);
  assert.match(preloadSource, /removeListener\('login-status-changed',\s*handler\)/);
  assert.match(preloadSource, /removeListener\('window-state-changed',\s*handler\)/);
});

test('renderer places the custom title bar above the application body in the requested order', () => {
  assert.notEqual(titleBarSource, '', 'TitleBar.jsx must exist');
  assert.notEqual(titleBarCss, '', 'TitleBar.css must exist');
  assert.match(appSource, /import TitleBar from ['"]\.\/components\/TitleBar['"]/);
  assert.match(appSource, /<TitleBar[\s\S]*className="app-body"/);
  assert.match(appSource, /createLoginStatusPoller/);

  let previous = -1;
  for (const label of ['小红书', '抖音', '快手', '哔哩哔哩']) {
    const current = titleBarSource.indexOf(label);
    assert.ok(current > previous, `${label} must follow the requested order`);
    previous = current;
  }
  assert.match(titleBarSource, /最小化/);
  assert.match(titleBarSource, /最大化|还原/);
  assert.match(titleBarSource, /关闭/);
});

test('title bar is 48px, statuses stay draggable, and window controls are no-drag', () => {
  assert.match(titleBarCss, /height\s*:\s*48px/);
  assert.match(titleBarCss, /-webkit-app-region\s*:\s*drag/);
  assert.match(titleBarCss, /\.window-controls[\s\S]*-webkit-app-region\s*:\s*no-drag/);
  assert.match(titleBarCss, /\.window-control\.close:hover/);
});

test('title bar exposes a one-click login status refresh action', () => {
  assert.match(titleBarSource, /检查登录状态/);
  assert.match(titleBarSource, /onCheckLoginStatus/);
  assert.match(titleBarSource, /login-status-refresh/);
  assert.match(titleBarCss, /\.login-status-refresh[\s\S]*-webkit-app-region\s*:\s*no-drag/);
  assert.match(appSource, /refreshLoginStatuses/);
  assert.match(appSource, /loginStatusPollerRef\.current\?\.run\(\)/);
  assert.match(appSource, /onCheckLoginStatus=\{refreshLoginStatuses\}/);
});

test('sidebar no longer duplicates the brand or the single-platform cookie status', () => {
  assert.doesNotMatch(sidebarSource, /cookieStatus/);
  assert.doesNotMatch(sidebarSource, /Cookie:/);
  assert.doesNotMatch(sidebarSource, /className="sidebar-header"/);
  assert.match(sidebarSource, /后端:/);
});
