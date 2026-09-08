'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const adSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AdDisplay.jsx'), 'utf8');
const databaseSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'database.js'), 'utf8');
const cookieManagerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'CookieManager.jsx'), 'utf8');
const youtubeParserSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'native', 'multi-parser', 'parsers', 'youtube.js'),
  'utf8',
);

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, endMarker);
  return source.slice(start, end);
}

test('every invoke IPC registration is wrapped by the trusted-renderer guard', () => {
  const guardInstall = mainSource.indexOf('ipcMain.handle =');
  const firstHandler = mainSource.indexOf("ipcMain.handle('");
  assert.ok(guardInstall !== -1 && firstHandler !== -1 && guardInstall < firstHandler);
  assert.match(mainSource, /createTrustedIpcHandler\s*\(\s*handler\s*,\s*TRUSTED_RENDERER_POLICY\s*\)/);
});

test('main navigation and webviews use explicit trusted URL boundaries', () => {
  assert.match(mainSource, /function\s+guardMainWindowNavigation\s*\(/);
  assert.match(mainSource, /isTrustedRendererUrl\s*\(\s*url\s*,\s*TRUSTED_RENDERER_POLICY\s*\)/);
  assert.match(mainSource, /guardMainWindowNavigation\s*\(\s*mainWindow\.webContents\s*\)/);
  assert.match(mainSource, /app\.on\(\s*['"]web-contents-created['"]/);
  assert.match(mainSource, /will-attach-webview/);
  assert.match(mainSource, /delete\s+webPreferences\.preload/);
  assert.match(mainSource, /webPreferences\.nodeIntegration\s*=\s*false/);
  assert.match(mainSource, /webPreferences\.contextIsolation\s*=\s*true/);
  assert.match(mainSource, /webPreferences\.sandbox\s*=\s*true/);
  assert.match(mainSource, /setPermissionRequestHandler/);
});

test('control-panel requests retain certificate verification and shell URLs are validated', () => {
  assert.doesNotMatch(mainSource, /rejectUnauthorized\s*:\s*false/);
  assert.doesNotMatch(mainSource, /httpsAgent\s*:/);
  assert.doesNotMatch(mainSource, /makeDirectAgent|lookupPromise/);
  const shellCalls = mainSource.match(/shell\.openExternal\s*\([^)]*\)/g) || [];
  assert.deepEqual(shellCalls, ['shell.openExternal(safeUrl)']);
  assert.match(mainSource, /validateExternalUrl\s*\(\s*response\.data\.url/);
});

test('ad HTML uses a narrow allowlist without forms or navigation attributes', () => {
  assert.match(adSource, /const\s+ALLOWED_TAGS\s*=\s*new\s+Set/);
  assert.match(adSource, /BLOCKED_TAGS/);
  assert.match(adSource, /['"]form['"].*['"]input['"].*['"]button['"]/s);
  assert.doesNotMatch(adSource, /getAttribute\(\s*['"]href['"]\s*\)/);
  assert.doesNotMatch(adSource, /allow-forms|allow-popups|allow-same-origin/);
  assert.match(adSource, /parsed\.protocol\s*!==\s*['"]https:['"]/);
});

test('credentials use OS encryption without plaintext fallback stores or renderer disclosure', () => {
  assert.match(mainSource, /safeStorage/);
  assert.match(mainSource, /createSecretStore\s*\(/);
  assert.match(mainSource, /db\.configureSecretStore\s*\(/);
  assert.doesNotMatch(mainSource, /store\.(?:get|set)\(\s*['"]cookie_/);

  const getCookies = sourceBetween(mainSource, "ipcMain.handle('get-cookies'", "ipcMain.handle('clear-cookies'");
  assert.match(getCookies, /configured:/);
  assert.match(getCookies, /entries:/);
  assert.doesNotMatch(getCookies, /entry\.value|cookieString\s*:/);

  const listMyAccounts = sourceBetween(databaseSource, 'function listMyAccounts()', 'function addMyAccount');
  assert.doesNotMatch(listMyAccounts, /cookie\s*:/);
  assert.doesNotMatch(cookieManagerSource, /cookieString|\.value\.substring/);
});

test('credential clearing removes storage, sessions, cached clients, and temporary files', () => {
  const clearCredentials = sourceBetween(
    mainSource,
    'async function clearPlatformCredentials',
    '// ===== IPC处理程序 =====',
  );
  assert.match(clearCredentials, /clearStorageData\s*\(/);
  assert.match(clearCredentials, /db\.deleteKV\s*\(/);
  assert.match(clearCredentials, /db\.clearMyAccountSecrets\s*\(/);
  assert.match(clearCredentials, /store\.delete\s*\(/);
  assert.match(clearCredentials, /cleanupCookieFiles\s*\(/);
  assert.match(clearCredentials, /refreshPlatformCredentialConsumers\s*\(/);
});

test('yt-dlp receives login state through temporary Netscape files without secret-bearing argv logs', () => {
  assert.doesNotMatch(mainSource, /--add-header[\s\S]{0,80}Cookie:/);
  assert.doesNotMatch(mainSource, /substring\(0,\s*50\)[\s\S]{0,80}Cookie/);
  assert.doesNotMatch(youtubeParserSource, /args\.join\s*\(/);
  assert.match(mainSource, /buildCookieArgs\s*\(/);
  assert.match(mainSource, /buildYoutubeCookieArgs\s*\(/);
});
