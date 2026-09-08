'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const homeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'HomePage.jsx'), 'utf8');
const managerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'DownloadManager.jsx'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
const universalSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'UniversalDownload.jsx'), 'utf8');
const liveSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'LiveDownload.jsx'), 'utf8');
const profileSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'ProfileDownload.jsx'), 'utf8');
const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Settings.jsx'), 'utf8');
const csvSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'csvExport.js'), 'utf8');
const douyinWorkSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'douyinWork.js'), 'utf8');
const accountManagerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AccountManager.jsx'), 'utf8');
const monitorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Monitor.jsx'), 'utf8');
const operationHubSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'OperationHub.jsx'), 'utf8');
const xhsProfileDownloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'XhsProfileDownload.jsx'), 'utf8');
const cookieManagerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'CookieManager.jsx'), 'utf8');

test('HomePage uses stable successful indices and awaits task acceptance results', () => {
  assert.match(homeSource, /import\s*\{[^}]*successfulIndices[^}]*\}\s*from\s*['"]\.\.\/utils\/downloadUi\.mjs['"]/s);
  assert.ok((homeSource.match(/successfulIndices\s*\(/g) || []).length >= 2);
  assert.match(homeSource, /await\s+Promise\.allSettled\s*\(\s*downloadPromises\s*\)/);
  assert.match(homeSource, /result\.status\s*===\s*['"]fulfilled['"]/);
  assert.match(homeSource, /result\.value\?\.success\s*!==\s*false/);
  assert.match(homeSource, /acceptedCount\s*>\s*0/);
});

test('DownloadManager subscribes before snapshot, merges revisions, and cleans exact listeners', () => {
  assert.match(managerSource, /import\s*\{[^}]*aggregateBatch[^}]*mergeTaskEvent[^}]*\}\s*from\s*['"]\.\.\/utils\/downloadUi\.mjs['"]/s);
  const subscribeIndex = managerSource.indexOf('onDownloadTaskAdded(');
  const snapshotIndex = managerSource.indexOf('getDownloadTasks(');
  assert.ok(subscribeIndex !== -1 && snapshotIndex !== -1 && subscribeIndex < snapshotIndex);
  assert.match(managerSource, /const\s+unsubscribers\s*=\s*\[/);
  assert.match(managerSource, /unsubscribers\.forEach\s*\(/);
  assert.doesNotMatch(managerSource, /removeAllListeners\s*\(/);
  assert.match(managerSource, /onDownloadPartial\s*\(/);
  assert.match(managerSource, /mergeTaskEvent\s*\(/);
  assert.match(managerSource, /aggregateBatch\s*\(/);
});

test('partial and stopped downloads stay in attention/retry semantics', () => {
  assert.match(managerSource, /case\s+['"]partial['"]/);
  assert.match(managerSource, /task\.status\s*===\s*['"]partial['"]/);
  assert.match(managerSource, /task\.status\s*===\s*['"]stopped['"]/);
  assert.doesNotMatch(managerSource, /activeTab\s*===\s*['"]completed['"][^\n]*stopped/);
  assert.match(preloadSource, /onDownloadPartial\s*:/);
});

test('universal and live downloads share protocol-aware dispatch', () => {
  assert.match(universalSource, /upsertResource\s*\(/);
  assert.ok((universalSource.match(/dispatchResource\s*\(/g) || []).length >= 2);
  assert.doesNotMatch(universalSource, /seenUrlsRef/);
  assert.match(liveSource, /resourceType\s*===\s*['"]m3u8['"]/);
  assert.match(liveSource, /\?\s*['"]rtmp['"]/);
  assert.match(liveSource, /dispatchResource\s*\(/);
  assert.match(preloadSource, /recordLiveStream\s*:/);
});

test('profile reload uses explicit state and waits for accepted batch tasks', () => {
  assert.match(profileSource, /handleFetchProfile\s*=\s*async\s*\(\s*\{[^}]*platform[^}]*downloadType[^}]*input[^}]*\}\s*=\s*\{\}\s*\)/s);
  assert.match(profileSource, /handleFetchProfile\s*\(\s*\{\s*platform\s*:/);
  assert.match(profileSource, /acceptedCount\s*>\s*0/);
  const navigateIndex = profileSource.indexOf("onNavigate('download', 'downloading')");
  const acceptedIndex = profileSource.indexOf('acceptedCount > 0');
  assert.ok(acceptedIndex !== -1 && navigateIndex > acceptedIndex);
});

test('settings expose only implemented fields and validate numeric editors', () => {
  for (const stale of ['max_size', 'chunk', 'music', 'dynamic_cover', 'static_cover']) {
    assert.doesNotMatch(settingsSource, new RegExp(`settings\\?\\.${stale}|settings\\?\\[.*${stale}`));
  }
  assert.match(settingsSource, /concurrency/);
  assert.match(settingsSource, /Number\.isFinite\s*\(/);
  assert.match(settingsSource, /result\?\.success|result\s*&&\s*result\.success/);
});


test('CSV text is formula-safe and auto quality sorts bit-rate candidates first', () => {
  assert.match(csvSource, /export\s+function\s+sanitizeSpreadsheetCell\s*\(/);
  assert.match(csvSource, /escapeCSVValue\s*\(\s*sanitizeSpreadsheetCell\s*\(/);
  assert.match(douyinWorkSource, /sortedBitRates/);
  const autoStart = douyinWorkSource.indexOf('export function pickQualityUrl');
  const candidateIndex = douyinWorkSource.indexOf('sortedBitRates', autoStart);
  const playAddrIndex = douyinWorkSource.indexOf('v.play_addr', autoStart);
  assert.ok(candidateIndex !== -1 && playAddrIndex !== -1 && candidateIndex < playAddrIndex);
});

test('renderer subscriptions clean up only their own exact listeners', () => {
  for (const source of [accountManagerSource, monitorSource, operationHubSource, xhsProfileDownloadSource, preloadSource]) {
    assert.doesNotMatch(source, /removeAllListeners\s*\(/);
  }
  assert.match(accountManagerSource, /unsubscribeAccountUpdated\s*\(\s*\)/);
  assert.match(monitorSource, /unsubscribeUpdated\s*\(\s*\)/);
  assert.match(monitorSource, /unsubscribeEvent\s*\(\s*\)/);
  assert.match(operationHubSource, /unsubscribeUpdated\?\.\(\s*\)/);
  assert.match(operationHubSource, /unsubscribeEvent\?\.\(\s*\)/);
  assert.match(xhsProfileDownloadSource, /unsubscribeProgress\s*\(\s*\)/);
});

test('legacy account backup is removed only after complete acknowledged migration', () => {
  const migrationStart = accountManagerSource.indexOf("localStorage.getItem('saved_accounts')");
  const migrationEnd = accountManagerSource.indexOf('const res = await window.electronAPI.accountList()', migrationStart);
  assert.ok(migrationStart !== -1 && migrationEnd > migrationStart);
  const migration = accountManagerSource.slice(migrationStart, migrationEnd);
  assert.match(migration, /migrationResult\?\.success/);
  assert.match(migration, /migratedIds/);
  assert.match(migration, /sourceIds\.every\s*\(/);
  const removeIndex = migration.indexOf("localStorage.removeItem('saved_accounts')");
  const successIndex = migration.indexOf('migrationComplete');
  assert.ok(successIndex !== -1 && removeIndex > successIndex);
  assert.match(migration, /setError\s*\(/);
});

test('monitor refreshes deleted-group members and marks events read on entry', () => {
  assert.match(monitorSource, /setUsers\s*\(\s*res\.users\s*\|\|\s*\[\]\s*\)/);
  assert.match(monitorSource, /setVideos\s*\(\s*res\.videos\s*\|\|\s*\[\]\s*\)/);
  assert.match(monitorSource, /monitorMarkEventsRead\s*\(\s*\)/);
  assert.match(monitorSource, /setEvents\s*\([\s\S]{0,180}read:\s*true/);
  assert.match(monitorSource, /onClick=\{\(\)\s*=>\s*handleTabChange\s*\(\s*t\.id\s*\)\}/);
});

test('Xiaohongshu login is owned only by the profile extraction page', () => {
  assert.doesNotMatch(cookieManagerSource, /^\s*xiaohongshu\s*:/m);
  assert.match(
    xhsProfileDownloadSource,
    /openLoginWindow\(\s*['"]xiaohongshu['"]\s*\)/,
  );
});
