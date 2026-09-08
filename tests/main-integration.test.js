'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const taskStateSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'native', 'download', 'taskState.js'),
  'utf8',
);
const xhsProfileSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'xhsProfile.js'), 'utf8');
const kuaishouProfileSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'kuaishouProfile.js'), 'utf8');
const universalSnifferSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'universalSniffer.js'), 'utf8');
const youtubeShortsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'youtubeShorts.js'), 'utf8');
const apiServiceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'native', 'apiService.js'), 'utf8');
const rendererApiSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'api.js'), 'utf8');
const { normalizePageLimit } = require('../src/native/youtubeShorts');

function isRegexStart(source, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  if ('([{:;,=!?&|+-*%^~<>'.includes(source[cursor])) return true;

  const prefix = source.slice(0, cursor + 1);
  const keyword = prefix.match(/([A-Za-z_$][\w$]*)$/);
  return !!keyword && new Set([
    'await', 'case', 'delete', 'in', 'instanceof', 'of', 'return',
    'throw', 'typeof', 'void', 'yield',
  ]).has(keyword[1]);
}

function findBalancedEnd(source, start, opening, closing) {
  assert.equal(source[start], opening, `expected ${opening} at ${start}`);
  let depth = 0;
  let mode = 'code';
  let inRegexClass = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (mode === 'line-comment') {
      if (char === '\n') mode = 'code';
      continue;
    }
    if (mode === 'block-comment') {
      if (char === '*' && next === '/') {
        mode = 'code';
        index += 1;
      }
      continue;
    }
    if (mode === 'single-quote' || mode === 'double-quote' || mode === 'template') {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if ((mode === 'single-quote' && char === "'")
        || (mode === 'double-quote' && char === '"')
        || (mode === 'template' && char === '`')) {
        mode = 'code';
      }
      continue;
    }
    if (mode === 'regex') {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '[') inRegexClass = true;
      if (char === ']') inRegexClass = false;
      if (char === '/' && !inRegexClass) mode = 'code';
      continue;
    }

    if (char === '/' && next === '/') {
      mode = 'line-comment';
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      mode = 'block-comment';
      index += 1;
      continue;
    }
    if (char === '/' && isRegexStart(source, index)) {
      mode = 'regex';
      inRegexClass = false;
      continue;
    }
    if (char === "'") {
      mode = 'single-quote';
      continue;
    }
    if (char === '"') {
      mode = 'double-quote';
      continue;
    }
    if (char === '`') {
      mode = 'template';
      continue;
    }

    if (char === opening) depth += 1;
    if (char === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new Error(`unbalanced ${opening}${closing} starting at ${start}`);
}

function extractIpcHandler(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const markerIndex = mainSource.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing IPC handler: ${channel}`);

  const callStart = mainSource.indexOf('(', markerIndex);
  const callEnd = findBalancedEnd(mainSource, callStart, '(', ')');
  const arrow = mainSource.indexOf('=>', callStart);
  assert.ok(arrow > callStart && arrow < callEnd, `missing callback for IPC handler: ${channel}`);

  const bodyStart = mainSource.indexOf('{', arrow + 2);
  assert.ok(bodyStart > arrow && bodyStart < callEnd, `missing callback body for IPC handler: ${channel}`);
  const bodyEnd = findBalancedEnd(mainSource, bodyStart, '{', '}');
  return mainSource.slice(bodyStart + 1, bodyEnd);
}

function extractFunctionBodyFrom(source, name) {
  const marker = `function ${name}`;
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing function: ${name}`);

  const parametersStart = source.indexOf('(', markerIndex + marker.length);
  const parametersEnd = findBalancedEnd(source, parametersStart, '(', ')');
  const bodyStart = source.indexOf('{', parametersEnd + 1);
  const bodyEnd = findBalancedEnd(source, bodyStart, '{', '}');
  return source.slice(bodyStart + 1, bodyEnd);
}

function extractFunctionBody(name) {
  return extractFunctionBodyFrom(mainSource, name);
}

function extractMethodBody(name) {
  const marker = `async ${name}`;
  const markerIndex = mainSource.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing async method: ${name}`);
  const parametersStart = mainSource.indexOf('(', markerIndex + marker.length);
  const parametersEnd = findBalancedEnd(mainSource, parametersStart, '(', ')');
  const bodyStart = mainSource.indexOf('{', parametersEnd + 1);
  const bodyEnd = findBalancedEnd(mainSource, bodyStart, '{', '}');
  return mainSource.slice(bodyStart + 1, bodyEnd);
}

function callPositions(source, functionName) {
  const positions = [];
  const pattern = new RegExp(`\\b${functionName}\\s*\\(`, 'g');
  let match;
  while ((match = pattern.exec(source)) !== null) positions.push(match.index);
  return positions;
}

test('main uses the bounded scheduler and contains no legacy queue identifiers', () => {
  assert.doesNotMatch(mainSource, /\bdownloadQueue\b/);
  assert.doesNotMatch(mainSource, /\bactiveDownloads\b/);
  assert.doesNotMatch(mainSource, /\bprocessDownloadQueue\b/);
  assert.doesNotMatch(mainSource, /downloadQueue\s*\.\s*push\s*\(/);

  assert.match(mainSource, /require\(['"]\.\/src\/native\/download\/scheduler['"]\)/);
  assert.match(mainSource, /\bcreateScheduler\s*\(/);
  assert.match(mainSource, /\bdownloadScheduler\s*=\s*createScheduler\s*\(/);
  assert.match(mainSource, /function\s+enqueueDownload\s*\(/);
  assert.match(mainSource, /\bresetTaskForRetry\b/);
});

test('every direct pending-task IPC handler delegates to enqueueDownload', () => {
  const channels = [
    'download-file',
    'download-album',
    'download-dash',
    'download-m3u8',
    'download-mpd',
    'record-live-stream',
    'download-ytdl',
    'download-comments',
    'hongguo-download-batch',
  ];

  for (const channel of channels) {
    const body = extractIpcHandler(channel);
    assert.match(body, /\benqueueDownload\s*\(\s*task\s*\)/, `${channel} must enqueue each pending task`);
  }
});

test('XHS profile batch: videos enqueue as yt-dlp tasks, placeholders wait for feed parsing', () => {
  const profileHandler = extractIpcHandler('xhs-profile-download-batch');
  // 视频笔记：直接创建 yt-dlp 任务（pending）并入调度器
  assert.match(profileHandler, /type\s*:\s*['"]ytdl['"]/);
  assert.match(profileHandler, /status\s*:\s*['"]pending['"]/);
  assert.match(profileHandler, /\bbuildXhsExploreUrl\s*\(/);
  assert.match(profileHandler, /\benqueueDownload\s*\(\s*task\s*\)/);
  // 图集/未知类型：仍是 parsing 占位，由后台 feed 解析转 pending 后才入队
  assert.match(profileHandler, /status\s*:\s*['"]parsing['"]/);
  assert.match(profileHandler, /\bresolveXhsNotesBatch\s*\(/);

  const batchResolver = extractFunctionBody('resolveXhsNotesBatch');
  const pendingPositions = [];
  const pendingPattern = /task\.status\s*=\s*['"]pending['"]/g;
  let pendingMatch;
  while ((pendingMatch = pendingPattern.exec(batchResolver)) !== null) {
    pendingPositions.push(pendingMatch.index);
  }
  const enqueuePositions = callPositions(batchResolver, 'enqueueXhsTask');
  assert.ok(enqueuePositions.length > 0, 'resolved XHS profile tasks must be enqueued');
  assert.ok(pendingPositions.length >= enqueuePositions.length, 'each resolved XHS branch must set pending');
  for (const enqueuePosition of enqueuePositions) {
    assert.ok(pendingPositions.some(position => position < enqueuePosition), 'XHS task must become pending before enqueue');
  }

  const singleResolver = extractFunctionBody('resolveXhsTask');
  assert.match(singleResolver, /task\.status\s*=\s*['"]pending['"]/);
  const enqueueHelper = extractFunctionBody('enqueueXhsTask');
  assert.match(enqueueHelper, /\benqueueDownload\s*\(\s*task\s*\)/);
  const reparseHelper = extractFunctionBody('reparseXhsTask');
  assert.ok(reparseHelper.indexOf('resolveXhsTask') < reparseHelper.indexOf('enqueueXhsTask'));
});

test('XHS yt-dlp failures fall back to feed parsing exactly once, retries rewrite to yt-dlp first', () => {
  // yt-dlp 下载失败（非用户停止）时回退 feed 解析，而不是直接标记失败
  const ytdlBody = extractFunctionBody('executeYtdlDownload');
  const fallbackGateIndex = ytdlBody.indexOf('canFallbackToXhsFeed(');
  const fallbackStartIndex = ytdlBody.indexOf('startXhsFeedFallback(');
  const finalizeIndex = ytdlBody.lastIndexOf('finalizeDownloadTask(');
  assert.notEqual(fallbackGateIndex, -1, 'executeYtdlDownload must gate the XHS feed fallback');
  assert.notEqual(fallbackStartIndex, -1, 'executeYtdlDownload must start the XHS feed fallback');
  assert.ok(fallbackStartIndex < finalizeIndex, 'fallback must run before the failure finalize');

  // 回退只发生一次（防止 yt-dlp <-> feed 循环），且先解析成功再入队
  const fallbackGuard = extractFunctionBody('canFallbackToXhsFeed');
  assert.match(fallbackGuard, /xhsFeedFallbackUsed/);
  const fallbackHelper = extractFunctionBody('startXhsFeedFallback');
  assert.match(fallbackHelper, /xhsFeedFallbackUsed\s*=\s*true/);
  const resolveIndex = fallbackHelper.indexOf('resolveXhsTask(');
  const enqueueIndex = fallbackHelper.indexOf('enqueueXhsTask(');
  assert.notEqual(resolveIndex, -1);
  assert.notEqual(enqueueIndex, -1);
  assert.ok(resolveIndex < enqueueIndex, 'fallback must resolve via feed before enqueueing');
  assert.match(fallbackHelper, /downloadScheduler\.has\s*\(/);

  // 重试与首次下载顺序一致：先重写为 yt-dlp 优先形态（占位判定在重写之后）
  for (const channel of ['retry-task', 'retry-tasks']) {
    const body = extractIpcHandler(channel);
    const rewriteIndex = body.indexOf('rewriteXhsTaskToYtdlFirst(');
    const placeholderIndex = body.indexOf('isXhsPlaceholderTask(');
    const validateIndex = body.indexOf('validateTaskForRetry(');
    assert.notEqual(rewriteIndex, -1, `${channel} must rewrite XHS retries to yt-dlp first`);
    assert.ok(validateIndex < rewriteIndex, `${channel} must validate payload before rewriting`);
    assert.ok(rewriteIndex < placeholderIndex, `${channel} must rewrite before the placeholder check`);
  }

  // 图集任务不走 yt-dlp（无法下载图集），重写辅助会清除回退标记供下一轮使用
  const retryGuard = extractFunctionBody('shouldRetryXhsViaYtdl');
  assert.match(retryGuard, /['"]album['"]/);
  const rewriteHelper = extractFunctionBody('rewriteXhsTaskToYtdlFirst');
  assert.match(rewriteHelper, /delete\s+task\.xhsFeedFallbackUsed/);
  assert.match(rewriteHelper, /type\s*=\s*['"]ytdl['"]/);
});

test('stop and delete handlers remove pending work before touching running resources', () => {
  const stop = extractIpcHandler('stop-download');
  assert.notEqual(stop.indexOf('downloadScheduler.remove('), -1);

  const deletion = extractFunctionBody('deleteDownloadTaskById');
  const removeIndex = deletion.indexOf('downloadScheduler.remove(');
  assert.notEqual(removeIndex, -1, 'shared deletion must remove pending scheduler work');
  const resourceIndexes = ['requestTaskCancellation(', 'cleanupTaskTemporaryOutput(']
    .map(resource => deletion.indexOf(resource))
    .filter(index => index !== -1);
  if (resourceIndexes.length > 0) {
    assert.ok(removeIndex < Math.min(...resourceIndexes));
  }
});

test('single and batch retry paths use legal reset before enqueueing', () => {
  for (const channel of ['retry-task', 'retry-tasks']) {
    const body = extractIpcHandler(channel);
    const hasIndex = body.indexOf('downloadScheduler.has(');
    const resetIndex = body.indexOf('resetTaskForRetry(');
    const atomicRetryIndex = body.indexOf('resetAndEnqueueTaskForRetry(');
    const unlinkIndex = body.indexOf('fs.unlinkSync(');
    const runtimeCleanupIndexes = ['delete task.cancelSource', 'delete task.writer', 'delete task.ytdlProcess']
      .map(statement => body.indexOf(statement))
      .filter(index => index !== -1);

    assert.notEqual(hasIndex, -1, `${channel} must check scheduler membership before reset`);
    assert.notEqual(resetIndex, -1, `${channel} must directly reset XHS retry state`);
    assert.notEqual(atomicRetryIndex, -1, `${channel} must atomically reset and enqueue ordinary retries`);
    assert.ok(hasIndex < resetIndex, `${channel} must check scheduler membership before XHS reset`);
    assert.ok(hasIndex < atomicRetryIndex, `${channel} must check scheduler membership before ordinary reset`);
    assert.ok(atomicRetryIndex < unlinkIndex, `${channel} must confirm enqueue before deleting the partial file`);
    assert.ok(
      runtimeCleanupIndexes.every(index => atomicRetryIndex < index),
      `${channel} must confirm enqueue before deleting runtime fields`,
    );
    assert.match(body, /\benqueueDownload\s*\(/, `${channel} must use the scheduler for ordinary retries`);
  }

  const atomicRetryHelper = extractFunctionBodyFrom(taskStateSource, 'resetAndEnqueueTaskForRetry');
  assert.match(atomicRetryHelper, /\bresetTaskForRetry\s*\(/);
  assert.match(atomicRetryHelper, /\benqueue\s*\(\s*task\s*\)/);
  assert.match(atomicRetryHelper, /\brestoreTaskSnapshot\s*\(/);

  const enqueueXhsHelper = extractFunctionBody('enqueueXhsTask');
  assert.match(enqueueXhsHelper, /task\.status\s*=\s*['"]failed['"]/);
  assert.match(enqueueXhsHelper, /task\.error\s*=/);
  assert.match(enqueueXhsHelper, /\bsaveDownloadTasks\s*\(/);

  const retryTask = extractIpcHandler('retry-task');
  assert.match(retryTask, /\bfailed\b/);
  assert.match(retryTask, /\bpartial\b/);
  assert.match(retryTask, /\bstopped\b/);

  const retryTasks = extractIpcHandler('retry-tasks');
  assert.match(retryTasks, /\bfailed\b/);
  assert.match(retryTasks, /\bpartial\b/);
  assert.match(retryTasks, /\bstopped\b/);
});

test('special payload validation precedes every retry reset, unlink, and enqueue path', () => {
  assert.match(mainSource, /require\(['"]\.\/src\/native\/download\/taskPayload['"]\)/);
  const validationHelper = extractFunctionBody('validateTaskForRetry');
  assert.match(validationHelper, /\bbuildTaskPayload\s*\(/);
  assert.match(validationHelper, /\bvalidateTaskPayload\s*\(/);
  assert.match(validationHelper, /TASK_PAYLOAD_INVALID/);
  assert.match(validationHelper, /requiresReAdd\s*:\s*true/);

  for (const channel of ['retry-task', 'retry-tasks']) {
    const body = extractIpcHandler(channel);
    const validateIndex = body.indexOf('validateTaskForRetry(');
    assert.notEqual(validateIndex, -1, `${channel} must validate persisted payloads`);

    const mutationIndexes = [
      ...callPositions(body, 'resetTaskForRetry'),
      ...callPositions(body, 'resetAndEnqueueTaskForRetry'),
      ...callPositions(body, 'enqueueDownload'),
      ...callPositions(body, 'unlinkSync'),
    ];
    assert.ok(mutationIndexes.length > 0, `${channel} must contain retry mutations`);
    assert.ok(
      mutationIndexes.every(index => validateIndex < index),
      `${channel} must validate before reset, enqueue, or unlink`,
    );
    assert.match(body, /TASK_PAYLOAD_INVALID|payloadValidation/);
  }
});

test('delete handlers explicitly remove only existing task ids from the database', () => {
  const shared = extractFunctionBody('deleteDownloadTaskById');
  const findIndex = shared.indexOf('downloadTasks.findIndex(');
  const spliceIndex = shared.indexOf('downloadTasks.splice(');
  const deleteIndex = shared.indexOf('db.deleteDownloadTask(');
  assert.notEqual(findIndex, -1);
  assert.notEqual(deleteIndex, -1, 'shared deletion must explicitly delete the persisted row');
  assert.ok(findIndex < spliceIndex);
  assert.ok(spliceIndex < deleteIndex);

  for (const channel of ['delete-task', 'delete-tasks']) {
    assert.match(extractIpcHandler(channel), /deleteDownloadTaskById\s*\(/);
  }
});

test('critical credential paths map persistence errors and never write fallback plaintext stores', () => {
  const persistenceHelper = extractFunctionBody('persistenceFailureResult');
  assert.match(persistenceHelper, /PERSIST_FAILED/);
  assert.match(persistenceHelper, /数据保存失败，请检查磁盘空间或目录权限/);

  const credentialChannels = new Set([
    'import-browser-cookies',
    'set-cookie-manual',
    'open-login-window',
  ]);
  for (const channel of [
    'save-settings',
    'save-theme',
    'set-control-panel-url',
    ...credentialChannels,
  ]) {
    const body = extractIpcHandler(channel);
    assert.match(body, /persistenceFailureResult\s*\(\s*error\s*\)/, `${channel} must map persistence errors`);
    if (credentialChannels.has(channel)) {
      assert.doesNotMatch(body, /store\.set\s*\(/, `${channel} must not retain a plaintext fallback`);
    } else {
      const flushIndex = body.indexOf('db.flushNow(');
      const storeIndex = body.indexOf('store.set(');
      if (flushIndex !== -1 && storeIndex !== -1) {
        assert.ok(flushIndex < storeIndex, `${channel} must flush before writing its non-secret fallback`);
      }
    }
  }

  const saveCookies = extractMethodBody('saveCookies');
  assert.match(saveCookies, /persistenceFailureResult\s*\(\s*error\s*\)/);
  assert.match(saveCookies, /secretFailureResult\s*\(\s*error\s*\)/);
  assert.doesNotMatch(saveCookies, /store\.set\s*\(/);
});

test('download-file confines renderer paths and only accepts selected absolute directories', () => {
  assert.match(mainSource, /require\(['"]\.\/src\/native\/download\/fileOutput['"]\)/);
  assert.match(mainSource, /\bcreateDirectoryTokenRegistry\s*\(/);

  const folderPicker = extractIpcHandler('select-folder');
  assert.match(folderPicker, /downloadDirectoryTokens\.grant\s*\(\s*event\.sender\.id\s*,/);

  const resolveDirectory = extractFunctionBody('resolveRendererDownloadDir');
  assert.match(resolveDirectory, /downloadDirectoryTokens\.resolve\s*\(\s*event\.sender\.id\s*,/);
  assert.match(resolveDirectory, /INVALID_DOWNLOAD_PATH/);
  assert.match(resolveDirectory, /path\.isAbsolute\s*\(/);

  const downloadFile = extractIpcHandler('download-file');
  const sanitizeIndex = downloadFile.indexOf('sanitizeWindowsFilename(');
  const resolveIndex = downloadFile.indexOf('resolveInsideRoot(');
  const reserveIndex = downloadFile.indexOf('reserveDownloadPath(');
  const appendIndex = downloadFile.indexOf('downloadTasks.push(');
  assert.notEqual(sanitizeIndex, -1, 'filename must be sanitized in the main process');
  assert.notEqual(resolveIndex, -1, 'final path must be resolved inside its authorized directory');
  assert.notEqual(reserveIndex, -1, 'new tasks must reserve a collision-free final path');
  assert.ok(sanitizeIndex < appendIndex);
  assert.ok(resolveIndex < appendIndex);
  assert.ok(reserveIndex < appendIndex);
  assert.match(downloadFile, /filename\s*:\s*path\.basename\s*\(\s*savePath\s*\)/);
  assert.match(downloadFile, /resolveRendererDownloadDir\s*\(\s*event\s*,/);
  assert.match(downloadFile, /error\.code\s*===\s*['"]INVALID_DOWNLOAD_PATH['"]/);
  assert.match(downloadFile, /code\s*:\s*['"]INVALID_DOWNLOAD_PATH['"]/);
  assert.doesNotMatch(downloadFile, /path\.join\s*\(\s*resolvedDir\s*,\s*finalFilename\s*\)/);
});

test('direct downloads use AbortController, part publishing, and one-shot finalization', () => {
  assert.match(mainSource, /\bcreateTaskFinalizer\b/);
  assert.match(mainSource, /\bdownloadHttpResponse\b/);

  const execute = extractFunctionBody('executeDirectDownload');
  assert.match(execute, /new\s+AbortController\s*\(/);
  assert.match(execute, /downloadHttpResponse\s*\(/);
  assert.match(execute, /controller\.signal/);
  assert.match(execute, /finalizeDownloadTask\s*\(\s*task\s*,\s*outcome\.status/);
  assert.match(execute, /['"]completed['"]/);
  assert.match(execute, /['"]failed['"]/);
  assert.match(execute, /['"]stopped['"]/);
  assert.doesNotMatch(execute, /CancelToken|createWriteStream|\.pipe\s*\(|writer\.on\s*\(\s*['"]finish['"]/);

  const dispatcher = extractFunctionBody('executeDownload');
  assert.match(dispatcher, /executeDirectDownload\s*\(\s*task\s*\)/);
  assert.match(dispatcher, /releaseDownloadPath\s*\(\s*task\.savePath\s*\)/);
  assert.match(dispatcher, /reserveDownloadPath\s*\(\s*task\.savePath\s*\)/);
  assert.doesNotMatch(dispatcher, /CancelToken|writer\.on\s*\(\s*['"]finish['"]/);
  assert.doesNotMatch(dispatcher, /unlinkSync\s*\(\s*savePath\s*\)/);
});

test('stop and delete await execution and never end a writer into a false completion', () => {
  const stop = extractIpcHandler('stop-download');
  assert.match(stop, /requestTaskCancellation\s*\(\s*task\s*,\s*['"]stopped['"]\s*\)/);
  assert.match(stop, /await\s+waitForTaskExecution\s*\(/);
  assert.doesNotMatch(stop, /writer\.end\s*\(/);

  const deleteHelper = extractFunctionBody('deleteDownloadTaskById');
  assert.match(deleteHelper, /downloadScheduler\.remove\s*\(/);
  assert.match(deleteHelper, /finalizeDownloadTask\s*\(\s*task\s*,\s*['"]deleted['"]/);
  assert.match(deleteHelper, /requestTaskCancellation\s*\(\s*task\s*,\s*['"]deleted['"]\s*\)/);
  assert.match(deleteHelper, /await\s+waitForTaskExecution\s*\(/);
  assert.match(deleteHelper, /cleanupTaskTemporaryOutput\s*\(/);
  assert.match(deleteHelper, /db\.deleteDownloadTask\s*\(/);
  assert.doesNotMatch(deleteHelper, /writer\.end\s*\(/);

  const waitIndex = deleteHelper.indexOf('await waitForTaskExecution(');
  const cleanupIndex = deleteHelper.indexOf('cleanupTaskTemporaryOutput(');
  const spliceIndex = deleteHelper.indexOf('downloadTasks.splice(');
  const databaseIndex = deleteHelper.indexOf('db.deleteDownloadTask(');
  assert.ok(waitIndex < cleanupIndex);
  assert.ok(cleanupIndex < spliceIndex);
  assert.ok(spliceIndex < databaseIndex);

  const single = extractIpcHandler('delete-task');
  assert.match(single, /await\s+deleteDownloadTaskById\s*\(/);
  const batch = extractIpcHandler('delete-tasks');
  assert.match(batch, /await\s+deleteDownloadTaskById\s*\(/);
  assert.doesNotMatch(batch, /cancelSource|writer\.end|ytdlProcess\.kill/);
});

test('album outcomes count successful files, persist failed items, and publish through task parts', () => {
  const album = extractFunctionBody('executeAlbumDownload');
  assert.match(album, /summarizeItems\s*\(/);
  assert.match(album, /task\.failedAlbumItems\s*=/);
  assert.match(album, /downloadHttpResponse\s*\(/);
  assert.match(album, /receivedBytes\s*:\s*summary\.succeeded|task\.receivedBytes\s*=\s*summary\.succeeded/);
  assert.match(album, /finalizeDownloadTask\s*\(\s*task\s*,\s*summary\.status/);
  assert.doesNotMatch(album, /responseType\s*:\s*['"]arraybuffer['"]|writeFileSync\s*\(/);
});

test('Hongguo never infers completion from an unrelated existing file', () => {
  const hongguo = extractFunctionBody('executeHongguoDownload');
  assert.match(hongguo, /runHongguoDecryptWorker\s*\(/);
  assert.match(hongguo, /createPartPath\s*\(/);
  assert.match(hongguo, /verifyNonEmptyFile\s*\(/);
  assert.match(hongguo, /finalizeDownloadTask\s*\(/);
  assert.doesNotMatch(hongguo, /1024\s*\*\s*100|decryptMp4File\s*\(/);
});

test('yt-dlp requires its exact after-move output and never logs cookie-bearing arguments', () => {
  const ytdl = extractFunctionBody('executeYtdlDownload');
  assert.match(ytdl, /['"]--print['"]/);
  assert.match(ytdl, /after_move:/);
  assert.match(ytdl, /parseYtdlpOutputLine\s*\(/);
  assert.match(ytdl, /verifyNonEmptyFile\s*\(/);
  assert.match(ytdl, /OUTPUT_MISSING/);
  assert.match(ytdl, /finalizeDownloadTask\s*\(/);
  assert.doesNotMatch(ytdl, /args\.join\s*\(/);
  assert.doesNotMatch(ytdl, /readdirSync\s*\(/);
});

test('comment cancellation is checked before export and CSV output is formula-safe', () => {
  const comments = extractFunctionBody('executeCommentDownload');
  const exportIndex = comments.indexOf('convertCommentsToCSV(');
  assert.notEqual(exportIndex, -1);
  assert.match(comments.slice(0, exportIndex), /throwIfTaskAborted\s*\(/);
  assert.match(comments, /writeStreamToPart\s*\(/);
  assert.match(comments, /finalizeDownloadTask\s*\(/);
  assert.doesNotMatch(comments, /writeFileSync\s*\(/);

  const csvEscape = extractFunctionBody('escapeCSV');
  assert.match(csvEscape, /escapeSpreadsheetCSVCell\s*\(/);
});

test('HLS and MPD delegate manifests directly to cancellable ffmpeg parts', () => {
  assert.doesNotMatch(mainSource, /function\s+parseMpd\s*\(/);
  assert.doesNotMatch(mainSource, /resolveSubM3u8|SegmentURL|concatListPath/);

  for (const [name, field] of [
    ['executeM3u8Download', 'm3u8Url'],
    ['executeMpdDownload', 'mpdUrl'],
  ]) {
    const body = extractFunctionBody(name);
    assert.match(body, new RegExp(`executeManifestDownload\\s*\\(\\s*task\\s*,\\s*${field}`));
  }

  const manifest = extractFunctionBody('executeManifestDownload');
  assert.match(manifest, /buildManifestFfmpegArgs\s*\(/);
  assert.match(manifest, /createPartPath\s*\(/);
  assert.match(manifest, /runCancellableProcess\s*\(/);
  assert.match(manifest, /runtime\.childProcess\s*=/);
  assert.match(manifest, /verifyNonEmptyFile\s*\(/);
  assert.match(manifest, /fs\.promises\.rename\s*\(/);
  assert.match(manifest, /finalizeDownloadTask\s*\(/);
  assert.doesNotMatch(manifest, /axios|CancelToken|writeFileSync|spawn\s*\(/);
});

test('DASH and yt-dlp use the shared process runner and cancellation kills process trees', () => {
  const dash = extractFunctionBody('executeDashDownload');
  assert.match(dash, /runCancellableProcess\s*\(/);
  assert.match(dash, /createPartPath\s*\(/);
  assert.match(dash, /runtime\.childProcess\s*=/);
  assert.match(dash, /tmpDir[\s\S]*task\.id|task\.id[\s\S]*tmpDir/);
  assert.doesNotMatch(dash, /spawn\s*\(/);

  const ytdl = extractFunctionBody('executeYtdlDownload');
  assert.match(ytdl, /runCancellableProcess\s*\(/);
  assert.match(ytdl, /runtime\.childProcess\s*=/);
  assert.doesNotMatch(ytdl, /spawn\s*\(/);

  const cancel = extractFunctionBody('requestTaskCancellation');
  assert.match(cancel, /terminateProcessTree\s*\(\s*runtime\.childProcess\s*\)/);
});

test('hidden platform windows have one creation promise, a serial operation queue, and exact listener cleanup', () => {
  assert.match(xhsProfileSource, /windowReadyPromise\s*=\s*createWindowPromise[\s\S]*\.finally\s*\(/);
  assert.match(xhsProfileSource, /operationQueue/);
  assert.doesNotMatch(xhsProfileSource, /removeAllListeners\s*\(/);
  assert.match(xhsProfileSource, /removeListener\s*\(\s*['"]did-finish-load['"]/);
  assert.match(xhsProfileSource, /removeListener\s*\(\s*['"]did-fail-load['"]/);

  assert.match(kuaishouProfileSource, /windowReadyPromise/);
  assert.match(kuaishouProfileSource, /operationQueue/);
  assert.match(kuaishouProfileSource, /removeListener\s*\(\s*['"]message['"]/);
  assert.doesNotMatch(kuaishouProfileSource, /removeAllListeners\s*\(/);
});

test('universal sniffer enforces caps before inserting pending resources and upgrades in place', () => {
  assert.match(universalSnifferSource, /function\s+canInsertResource\s*\(/);
  const pendingIndex = universalSnifferSource.indexOf('if (pending && !seenUrls.has(url))');
  const pendingInsert = universalSnifferSource.indexOf('seenUrls.add(url)', pendingIndex);
  const capCheck = universalSnifferSource.indexOf('canInsertResource(', pendingIndex);
  assert.ok(pendingIndex !== -1 && capCheck > pendingIndex && capCheck < pendingInsert);
  assert.match(universalSnifferSource, /collected\[idx\]\.type\s*=\s*type/);
});

test('remaining data helpers preserve caller limits, owner names, bounded requests, and method binding', () => {
  assert.match(youtubeShortsSource, /function\s+normalizePageLimit\s*\(/);
  assert.doesNotMatch(youtubeShortsSource, /Math\.min\(\s*Number\(maxPages\)\s*,\s*DEFAULT_MAX_PAGES\s*\)/);
  assert.match(apiServiceSource, /uname\s*=\s*owner/);
  assert.doesNotMatch(rendererApiSource, /export\s+const\s*\{/);
  assert.match(rendererApiSource, /export\s+const\s+resolveShareLink\s*=\s*\(\.\.\.args\)\s*=>\s*api\.resolveShareLink\s*\(\.\.\.args\)/);
});

test('YouTube page-limit normalization preserves large caller limits', () => {
  assert.equal(normalizePageLimit(undefined), 20);
  assert.equal(normalizePageLimit(1), 1);
  assert.equal(normalizePageLimit(50), 50);
  assert.equal(normalizePageLimit(100), 100);
  assert.equal(normalizePageLimit(999), 999);
  assert.equal(normalizePageLimit(0), 999);
});
