# Electron Windows x64 Reliability Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the active Electron/React/Node.js downloader so downloads have deterministic lifecycle semantics, survive restarts, produce verified files, expose safe IPC, and ship as a supported Windows x64 application.

**Architecture:** Preserve existing renderer APIs and IPC channel names while extracting small CommonJS download/security modules from `main.js` and pure ESM renderer helpers from large components. Introduce a versioned download payload in SQLite, a bounded scheduler, one-shot finalization, `.part` output publishing, and sender/path/URL validation. The legacy `抖音下载器源码/` Python directory is explicitly out of scope and must remain byte-for-byte untouched.

**Tech Stack:** Electron 28→supported patched Electron, Node.js 20 built-in test runner, React 18, Vite, sql.js, Axios, ffmpeg-static, yt-dlp, Electron safeStorage, electron-builder Windows x64.

---

## Scope and repository note

- Do not modify, move, delete, import, test, package, or format anything below `抖音下载器源码/`.
- The current workspace is not a Git repository. Do not initialize Git without user authorization. Every task therefore ends with a fresh verification checkpoint instead of a commit.
- Keep all existing `window.electronAPI` method names and IPC channel names. Additional fields such as `revision`, `code`, `partial`, and `canStop` are backward-compatible.
- Do not perform real account logins or real platform downloads in automated tests. Use local streams, temporary directories, fake child processes, and existing offline Electron mocks.

## Planned file structure

### New main-process modules

- `src/native/download/taskState.js` — legal state transitions and one-shot finalization.
- `src/native/download/scheduler.js` — bounded queue, pending cancellation, duplicate protection.
- `src/native/download/taskPayload.js` — versioned per-type execution payload serialization and validation.
- `src/native/download/fileOutput.js` — Windows filename/path validation, `.part` files, stream integrity, atomic publish.
- `src/native/download/processRunner.js` — cancellable ffmpeg/yt-dlp process execution and Windows process-tree termination.
- `src/native/security/ipcGuards.js` — trusted sender, external URL and authorized path validation.
- `src/native/security/secretStore.js` — safeStorage-backed cookie persistence and redaction.

### New renderer helper

- `src/utils/downloadUi.mjs` — selection, event merge, batch aggregation, and resource dispatch decisions.

### Tests

- `tests/all.test.js` — single deterministic Node test entry point.
- `tests/task-state.test.js`
- `tests/scheduler.test.js`
- `tests/task-payload.test.js`
- `tests/database-download-tasks.test.js`
- `tests/file-output.test.js`
- `tests/process-runner.test.js`
- `tests/ipc-guards.test.js`
- `tests/secret-store.test.js`
- `tests/download-ui.test.mjs`
- `tests/main-integration.test.js`

---

### Task 1: Establish the first-party test gate

**Files:**
- Create: `tests/all.test.js`
- Modify: `package.json`

- [ ] **Step 1: Add the deterministic test entry point**

Create `tests/all.test.js` with this initial content:

```js
'use strict';

require('../_test_login_window_navigation.js');
require('../_test_single_instance_lock.js');
```

The two existing files currently execute assertions at module load, so this preserves their behavior before new `node:test` suites are added.

- [ ] **Step 2: Add package scripts**

Add these scripts without changing the existing start/build commands:

```json
"test": "node --test --test-concurrency=1 tests/all.test.js",
"test:offline": "node --test --test-concurrency=1 tests/all.test.js",
"check": "node --check main.js && node --check preload.js && node --check preload-login.js && npm test && npm run build:react"
```

- [ ] **Step 3: Run the baseline gate**

Run: `npm test`

Expected: exit 0 with both existing PASS messages. If Node reports that a required file terminates the process, replace that file's final `process.exitCode` assignment with a thrown assertion while preserving its direct CLI behavior through `if (require.main === module)`.

- [ ] **Step 4: Verify production parsing remains unchanged**

Run: `node --check main.js`, `node --check preload.js`, and `npm run build:react`.

Expected: all exit 0. Record the existing bundle-size warning; it is not a failure in this task.

---

### Task 2: Add a one-shot task state machine

**Files:**
- Create: `src/native/download/taskState.js`
- Create: `tests/task-state.test.js`
- Modify: `tests/all.test.js`

- [ ] **Step 1: Write failing state-transition tests**

Append `require('./task-state.test.js')` to `tests/all.test.js`. Create the test:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { transitionTask, createTaskFinalizer } = require('../src/native/download/taskState');

test('terminal task cannot be overwritten by a late completion', () => {
  const task = { id: 'a', status: 'downloading', revision: 1 };
  assert.equal(transitionTask(task, 'stopped'), true);
  assert.equal(transitionTask(task, 'completed'), false);
  assert.equal(task.status, 'stopped');
});

test('finalizer persists and emits exactly once', async () => {
  const task = { id: 'b', status: 'downloading', revision: 0 };
  const calls = [];
  const finalize = createTaskFinalizer({
    task,
    persist: async (value) => calls.push(['persist', value.status]),
    emit: (channel, value) => calls.push([channel, value.status]),
    cleanup: async () => calls.push(['cleanup']),
  });
  assert.equal(await finalize('stopped'), true);
  assert.equal(await finalize('completed'), false);
  assert.deepEqual(calls, [
    ['cleanup'],
    ['persist', 'stopped'],
    ['download-stopped', 'stopped'],
  ]);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test`

Expected: FAIL with `Cannot find module '../src/native/download/taskState'`.

- [ ] **Step 3: Implement the minimal state module**

Create `src/native/download/taskState.js`:

```js
'use strict';

const TERMINAL = new Set(['completed', 'partial', 'failed', 'stopped', 'deleted']);
const EVENT_BY_STATUS = {
  completed: 'download-completed',
  partial: 'download-partial',
  failed: 'download-failed',
  stopped: 'download-stopped',
  deleted: 'download-deleted',
};

function transitionTask(task, nextStatus, patch = {}) {
  if (!task || !nextStatus) return false;
  if (TERMINAL.has(task.status) && task.status !== nextStatus) return false;
  Object.assign(task, patch, {
    status: nextStatus,
    revision: Number(task.revision || 0) + 1,
    updatedTime: Date.now(),
  });
  if (TERMINAL.has(nextStatus) && !task.endTime) task.endTime = Date.now();
  return true;
}

function createTaskFinalizer({ task, persist, emit, cleanup }) {
  let settled = false;
  return async function finalize(status, patch = {}) {
    if (settled || !TERMINAL.has(status)) return false;
    settled = true;
    await cleanup();
    if (!transitionTask(task, status, patch)) return false;
    await persist(task);
    const channel = EVENT_BY_STATUS[status];
    if (channel) emit(channel, { ...task });
    return true;
  };
}

module.exports = { TERMINAL, transitionTask, createTaskFinalizer };
```

- [ ] **Step 4: Verify GREEN and edge cases**

Run: `npm test`

Expected: exit 0. Add assertions proving same-status idempotence does not emit twice and `failed → pending` is rejected until an explicit retry reset function is used.

- [ ] **Step 5: Add explicit retry reset**

Add and export:

```js
function resetTaskForRetry(task) {
  if (!task || !['failed', 'partial', 'stopped'].includes(task.status)) return false;
  Object.assign(task, {
    status: 'pending', progress: 0, receivedBytes: 0, totalBytes: 0,
    error: null, endTime: 0, cancelled: false,
    revision: Number(task.revision || 0) + 1, updatedTime: Date.now(),
  });
  return true;
}
```

Run: `npm test`. Expected: exit 0.

---

### Task 3: Replace the one-at-a-time queue with a bounded scheduler

**Files:**
- Create: `src/native/download/scheduler.js`
- Create: `tests/scheduler.test.js`
- Modify: `tests/all.test.js`
- Modify: `main.js:1764-1820, 4262-4740`

- [ ] **Step 1: Write failing scheduler tests**

Register `scheduler.test.js`, then create tests using deferred promises:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler } = require('../src/native/download/scheduler');

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('scheduler fills but never exceeds its concurrency limit', async () => {
  const gates = Array.from({ length: 5 }, deferred);
  let active = 0;
  let peak = 0;
  const scheduler = createScheduler({ limit: 3, run: async (task) => {
    active += 1;
    peak = Math.max(peak, active);
    await gates[task.n].promise;
    active -= 1;
  }});
  for (let n = 0; n < 5; n += 1) scheduler.enqueue({ id: String(n), n, status: 'pending' });
  await new Promise(setImmediate);
  assert.equal(peak, 3);
  assert.equal(scheduler.stats().active, 3);
  gates.forEach((gate) => gate.resolve());
  await scheduler.whenIdle();
  assert.equal(scheduler.stats().active, 0);
});

test('removing a pending task guarantees it never runs', async () => {
  const ran = [];
  const scheduler = createScheduler({ limit: 1, run: async (task) => ran.push(task.id) });
  scheduler.enqueue({ id: 'cancel-me', status: 'pending' });
  assert.equal(scheduler.remove('cancel-me'), true);
  await scheduler.whenIdle();
  assert.deepEqual(ran, []);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test`

Expected: missing scheduler module.

- [ ] **Step 3: Implement `createScheduler`**

The module must expose `enqueue`, `remove`, `has`, `pump`, `whenIdle`, and `stats`. `enqueue()` must reject duplicate IDs, schedule `pump()` with `queueMicrotask`, and `pump()` must start tasks without awaiting them inside the fill loop. A task is runnable only when `task.status === 'pending'`.

Use this completion pattern:

```js
Promise.resolve(run(task))
  .catch((error) => onError(task, error))
  .finally(() => {
    active.delete(task.id);
    pump();
    notifyIdle();
  });
```

- [ ] **Step 4: Verify GREEN**

Run: `npm test`

Expected: all scheduler tests pass and peak concurrency is exactly 3.

- [ ] **Step 5: Integrate the scheduler in `main.js`**

Replace `downloadQueue`, `activeDownloads`, and `processDownloadQueue()` with one scheduler created after executor declarations:

```js
const { createScheduler } = require('./src/native/download/scheduler');
const downloadScheduler = createScheduler({
  limit: MAX_CONCURRENT_DOWNLOADS,
  run: executeDownload,
  onError: (task, error) => console.error('[Download Queue]', task.id, error),
});
const enqueueDownload = (task) => downloadScheduler.enqueue(task);
```

Update all queue insertion sites to call `enqueueDownload(task)`. Stop/delete handlers must call `downloadScheduler.remove(taskId)` before touching runtime resources. Retry handlers must call `resetTaskForRetry()` and reject invalid status.

- [ ] **Step 6: Add main integration assertions**

Extend `tests/main-integration.test.js` with source-level contract assertions that `processDownloadQueue` and `downloadQueue.push` no longer exist. Extract the bodies of `download-file`, `download-album`, `download-dash`, `download-m3u8`, `download-mpd`, `download-ytdl`, `download-comments`, `channels-download`, and `hongguo-download-batch`, then assert each body that creates a `pending` task calls `enqueueDownload`. The XHS parsing handlers are allowed to enqueue only after their placeholder changes from `parsing` to `pending`.

Run: `npm test`. Expected: exit 0.

---

### Task 4: Persist complete, versioned task payloads

**Files:**
- Create: `src/native/download/taskPayload.js`
- Create: `tests/task-payload.test.js`
- Create: `tests/database-download-tasks.test.js`
- Modify: `tests/all.test.js`
- Modify: `src/native/database.js:111-133, 286-291, 1191-1242, 1325-1392`
- Modify: `main.js:1771-1796, 4630-4740`

- [ ] **Step 1: Write failing payload round-trip tests**

Create fixtures for `album`, `dash`, `m3u8`, `mpd`, `ytdl`, `channels`, and `hongguo`. The expected payload fields are:

```js
const EXPECTED = {
  album: ['albumItems', 'albumFolderName', 'headers'],
  dash: ['dashVideoUrl', 'dashAudioUrl', 'headers'],
  m3u8: ['m3u8Url', 'headers'],
  mpd: ['mpdUrl', 'headers'],
  ytdl: ['ytdlUrl', 'ytdlMaxHeight'],
  channels: ['decodeKey', 'encLimit', 'headers'],
  hongguo: ['hongguoInfo', 'headers'],
};
```

For each type, assert `buildTaskPayload(task)` returns `{ version: 1, type, data }`, JSON stringify/parse preserves all expected fields, and `applyTaskPayload(base, payload)` restores them.

- [ ] **Step 2: Verify RED**

Run: `npm test`

Expected: missing `taskPayload` module.

- [ ] **Step 3: Implement allowlisted payload serialization**

Create `taskPayload.js` with an immutable `FIELDS_BY_TYPE`, `buildTaskPayload`, `applyTaskPayload`, and `validateTaskPayload`. Validation must return `{ valid: false, error }` for a missing required field and must never copy `cancelSource`, `writer`, `responseStream`, `childProcess`, or functions.

- [ ] **Step 4: Verify payload tests pass**

Run: `npm test`

Expected: all seven task-type round trips pass.

- [ ] **Step 5: Add database migration and single-task UPSERT**

Add idempotent columns:

```sql
payload_json TEXT,
payload_version INTEGER DEFAULT 1,
revision INTEGER DEFAULT 0,
updated_time INTEGER DEFAULT 0
```

Change `upsertDownloadTaskRaw()` to write these columns. Add exported functions:

```js
function saveDownloadTask(task) {
  upsertDownloadTaskRaw(task);
  scheduleFlush();
}

function saveDownloadTasks(tasks) {
  if (!Array.isArray(tasks)) return;
  db.run('BEGIN');
  try {
    for (const task of tasks) upsertDownloadTaskRaw(task);
    db.run('COMMIT');
    scheduleFlush();
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}
```

Do not delete the table before writing.

- [ ] **Step 6: Write and run a real sql.js round-trip test**

Initialize `database.js` with a temporary `app.getPath()` and a `{ get() {}, set() {} }` store stub. Save one fixture of every task type, call `flushNow()`, reload through `listDownloadTasks()`, and assert payload equality plus `revision` and `updatedTime`.

Run: `npm test`.

Expected: all rows reload with their type-specific fields restored.

- [ ] **Step 7: Propagate flush failure**

Change `flushNow()` to return `true` on success and throw after logging on failure. `scheduleFlush()` must retain `dirty = true` when a flush fails and log one redacted error. Update settings/Cookie callers to return `{ success:false, code:'PERSIST_FAILED', error }` when a required flush fails.

Run: `npm test`. Expected: a test using an unwritable fake path observes the thrown error and dirty state remains true.

---

### Task 5: Add safe Windows paths and `.part` publishing

**Files:**
- Create: `src/native/download/fileOutput.js`
- Create: `tests/file-output.test.js`
- Modify: `tests/all.test.js`
- Modify: `main.js:3810-3868`

- [ ] **Step 1: Write failing path and stream tests**

Cover these cases with `node:test` and a temporary directory:

```js
assert.equal(sanitizeWindowsFilename('CON .mp4'), '_CON .mp4');
assert.equal(sanitizeWindowsFilename('../a:b?.mp4'), 'a_b_.mp4');
assert.throws(() => resolveInsideRoot(root, '../escape.mp4'), /outside/i);
assert.match(createPartPath(root + '/video.mp4', 'task-1'), /task-1\.part$/);
```

Use `Readable.from([Buffer.from('abc')])` to prove a 3-byte expected stream publishes successfully. Use expected length 4 to prove the final file is absent and the `.part` file is removed after an integrity failure.

- [ ] **Step 2: Verify RED**

Run: `npm test`

Expected: missing `fileOutput` module.

- [ ] **Step 3: Implement filename/path helpers**

Export:

```js
sanitizeWindowsFilename(input, fallback = 'download')
resolveInsideRoot(root, relativeName)
createPartPath(finalPath, taskId)
reserveUniquePath(desiredPath, exists = fs.existsSync)
writeStreamToPart({ readable, finalPath, taskId, expectedLength, signal })
verifyNonEmptyFile(filePath)
```

`writeStreamToPart` must use `stream/promises.pipeline`, count bytes with a `Transform`, listen to the AbortSignal, fsync the file, verify length, and rename on the same volume. Any failure must destroy streams and remove only the exact task `.part` file.

- [ ] **Step 4: Verify GREEN including cancellation**

Add a never-ending `PassThrough`, abort it, and assert rejection code `DOWNLOAD_ABORTED`, no final file, and no remaining part file.

Run: `npm test`. Expected: exit 0.

- [ ] **Step 5: Validate `download-file` IPC inputs**

In `main.js`, sanitize renderer filename with `sanitizeWindowsFilename`, resolve it inside the configured root, and allow `customDir` only when it matches a directory token returned by the existing folder picker. Do not accept an arbitrary absolute directory from untrusted renderer input.

Run: `npm test`. Expected: traversal and absolute-path fixtures are rejected with `INVALID_DOWNLOAD_PATH`.

---

### Task 6: Migrate direct downloads to unified cancellation and finalization

**Files:**
- Create: `tests/main-integration.test.js`
- Modify: `tests/all.test.js`
- Modify: `main.js:3544-3803, 4262-4443`

- [ ] **Step 1: Write a failing local HTTP regression test**

Start a local `http.createServer()` with routes:

- `/ok` — declares and sends four bytes.
- `/short` — declares four bytes and sends two before destroying the socket.
- `/slow` — sends one chunk and waits for AbortSignal-driven cancellation.

Exercise an exported `downloadHttpResponse()` adapter built around `writeStreamToPart`. Assert `/ok` completes, `/short` fails integrity, and `/slow` ends stopped without a final file.

- [ ] **Step 2: Verify RED**

Run: `npm test`

Expected: adapter export missing.

- [ ] **Step 3: Replace CancelToken/writer.end flow**

For a direct task:

```js
task.runtime = { controller: new AbortController(), writer: null, childProcess: null };
const response = await axios.get(url, {
  responseType: 'stream',
  headers,
  timeout,
  signal: task.runtime.controller.signal,
});
await writeStreamToPart({
  readable: response.data,
  finalPath: task.savePath,
  taskId: task.id,
  expectedLength: Number(response.headers['content-length'] || 0),
  signal: task.runtime.controller.signal,
});
await task.finalize('completed', { progress: 100 });
```

Remove finish handlers that mutate task status. Stop calls `controller.abort()` and awaits the task completion promise; it must never call `writer.end()`.

- [ ] **Step 4: Unify delete semantics**

Deleting a pending task removes it from the scheduler and finalizes `deleted`. Deleting a running task aborts, waits for execution to settle, removes only its `.part`/temporary directory, then removes the database row. Batch delete reuses the same function and returns the number of IDs actually found.

- [ ] **Step 5: Verify regressions**

Run: `npm test`.

Expected: stopped and deleted tasks never emit completed; scheduler active count returns to zero; no local HTTP connection remains open.

---

### Task 7: Correct album, channels, Hongguo, comment, and yt-dlp outcomes

**Files:**
- Modify: `main.js:1822-1958, 2613-2852, 2860-3137, 3140-3505`
- Modify: `src/native/hongguo.js:494-619`
- Modify: `tests/main-integration.test.js`

- [ ] **Step 1: Write failing album partial-result tests**

Extract and test a pure `summarizeItems(results)` helper where:

```js
summarizeItems([{ ok: true }, { ok: false, error: '403' }])
```

returns `{ status:'partial', succeeded:1, failed:1, failures:[...] }`. Progress numerator must equal succeeded items, not attempted items.

- [ ] **Step 2: Implement per-item album results**

Each item writes a unique `.part`, records `{ index, url, path, ok, error }`, and continues on a non-cancel failure. Finalize `completed` only when all required items succeeded, otherwise `partial`. Persist `failedAlbumItems` in payload for targeted retry.

- [ ] **Step 3: Replace existing-file heuristics**

Remove video-channel “any file exists” and Hongguo “greater than 100 KB” completion checks. A file is reusable only when the persisted task was completed and the final file passes `verifyNonEmptyFile`; otherwise remove the task-specific part and redownload.

- [ ] **Step 4: Require yt-dlp output**

After yt-dlp exits 0, locate the exact output via `--print after_move:filepath` rather than a prefix directory scan. If the reported path does not exist or is empty, throw `OUTPUT_MISSING`. Remove command-line Cookie logging.

- [ ] **Step 5: Make comments cancellable and CSV-safe**

Check the task AbortSignal at every pagination boundary. Cancellation must exit before export and finalize stopped. Prefix untrusted CSV cells beginning with `=`, `+`, `-`, or `@` with a single quote before normal CSV quoting.

- [ ] **Step 6: Move Hongguo CPU/file work off the main loop**

Wrap the existing decrypt/remux function in a Node Worker with message-based progress and AbortSignal termination. The worker receives exact input/output paths and cannot choose directories. Do not change the cryptographic algorithm in this task.

- [ ] **Step 7: Verify all special outcomes**

Run: `npm test`.

Expected: partial albums remain retryable, cancelled comments produce no CSV, existing partial media is not skipped, missing yt-dlp output fails, and Hongguo worker cancellation removes its part file.

---

### Task 8: Delegate HLS/MPD and manage child processes

**Files:**
- Create: `src/native/download/processRunner.js`
- Create: `tests/process-runner.test.js`
- Modify: `tests/all.test.js`
- Modify: `main.js:1960-2596`

- [ ] **Step 1: Write failing process-runner tests**

Use `process.execPath -e` child fixtures to assert:

- exit 0 resolves;
- exit 7 rejects with `PROCESS_EXIT_NONZERO` and captured stderr;
- AbortSignal terminates the process and rejects with `DOWNLOAD_ABORTED`;
- a nonexistent executable rejects with `PROCESS_SPAWN_FAILED` rather than hanging.

- [ ] **Step 2: Verify RED**

Run: `npm test`

Expected: missing `processRunner` module.

- [ ] **Step 3: Implement `runCancellableProcess`**

Export:

```js
runCancellableProcess({ command, args, cwd, signal, onStdout, onStderr, windowsHide = true })
terminateProcessTree(child)
```

Listen for `error` and `close`, cap buffered stderr at 64 KiB, remove AbortSignal listeners in `finally`, and use `taskkill /PID <pid> /T /F` only for the exact spawned PID on Windows.

- [ ] **Step 4: Replace manual HLS/MPD parsing**

Call ffmpeg with the manifest URL and a task-specific part output:

```js
const args = [
  '-nostdin', '-y',
  '-headers', serializeFfmpegHeaders(downloadHeaders),
  '-i', manifestUrl,
  '-c', 'copy',
  '-movflags', '+faststart',
  partPath,
];
```

Use an allowlist of `file,http,https,tcp,tls,crypto` protocols and reject manifest schemes other than HTTPS/HTTP before spawning. On success verify and atomically publish. Keep the existing task type and IPC channels.

- [ ] **Step 5: Migrate DASH merge and yt-dlp**

Store the child in `task.runtime.childProcess` through `runCancellableProcess`. Stop/delete must terminate the process tree. Ensure every temporary directory is task-ID-specific and removed in `finally` only after child exit.

- [ ] **Step 6: Verify process lifecycle**

Run: `npm test`.

Expected: all child tests exit without orphaned processes; HLS/MPD code no longer contains the manual `parseMpd` or segment URL concatenation paths.

---

### Task 9: Extract and test renderer download semantics

**Files:**
- Create: `src/utils/downloadUi.mjs`
- Create: `tests/download-ui.test.mjs`
- Modify: `tests/all.test.js`
- Modify: `src/components/HomePage.jsx`
- Modify: `src/components/DownloadManager.jsx`

- [ ] **Step 1: Write failing pure-helper tests**

Test these exact exports:

```js
successfulIndices([{ success:false }, { success:true }]) // Set {1}
aggregateBatch([{ status:'completed' }, { status:'failed' }]) // partial
aggregateBatch([{ status:'stopped' }]) // stopped
mergeTaskEvent([{ id:'a', revision:2, progress:50 }], { id:'a', revision:1, progress:10 }) // keeps 50
upsertResource([{ url:'u', type:'m3u8_seg' }], { url:'u', type:'video_dash' }) // replaces type
```

- [ ] **Step 2: Verify RED**

Run: `npm test`

Expected: missing `downloadUi.mjs`.

- [ ] **Step 3: Implement the pure helpers**

Use explicit status precedence: parsing/downloading while active; then failed+success=`partial`; all failed=`failed`; all stopped=`stopped`; all completed=`completed`. Resource specificity precedence is `m3u8_seg < video/audio/image < video_dash/audio_dash < m3u8/dash`.

- [ ] **Step 4: Fix HomePage batch submission**

Use `successfulIndices(results)`. Await `Promise.allSettled(downloadPromises)`, count fulfilled values whose `value.success !== false`, and display/report partial failures. Navigate only when at least one task was accepted.

- [ ] **Step 5: Fix DownloadManager subscriptions and merge**

Save each unsubscribe returned by preload and invoke those functions in cleanup. Subscribe before requesting the snapshot, then merge snapshot/events by ID and revision. All `downloading` tasks show a stop button. Add `partial` status label and retry eligibility.

- [ ] **Step 6: Fix batch tabs/counts**

Use `aggregateBatch()` everywhere instead of duplicated `done > 0 ? completed : failed` logic. Stopped tasks belong to a stopped/attention state and remain retryable; they are not counted as completed.

- [ ] **Step 7: Verify UI behavior and build**

Run: `npm test` and `npm run build:react`.

Expected: helper tests pass and Vite exits 0.

---

### Task 10: Fix universal, live, profile, settings, and export flows

**Files:**
- Modify: `src/components/UniversalDownload.jsx`
- Modify: `src/components/LiveDownload.jsx`
- Modify: `src/components/ProfileDownload.jsx`
- Modify: `src/components/Settings.jsx`
- Modify: `src/components/ChannelsDownload.jsx`
- Modify: `src/utils/csvExport.js`
- Modify: `src/utils/douyinWork.js`
- Modify: `tests/download-ui.test.mjs`

- [ ] **Step 1: Test a shared resource dispatcher**

Add `resourceAction(resource)` to `downloadUi.mjs` and assert mappings:

```js
m3u8 -> downloadM3u8
dash -> downloadMpd
video_dash/audio_dash/m3u8_seg -> downloadFile
video/image/audio -> downloadFile
rtmp -> recordWithFfmpeg
```

- [ ] **Step 2: Reuse the dispatcher for single and bulk universal downloads**

Replace URL-only dedupe with `upsertResource`. Both download buttons call the same `dispatchResource(resource, electronAPI)` function and inspect `{ success:false }` as failure.

- [ ] **Step 3: Route live streams by protocol**

HTTP FLV uses the streaming file path, HLS uses `downloadM3u8`, and RTMP uses a new backward-compatible `record-live-stream` IPC that invokes ffmpeg through `processRunner`. Filename extensions follow the selected stream.

- [ ] **Step 4: Remove stale React state reads in profile reload**

Change `handleFetchProfile()` to receive an explicit object `{ platform, downloadType, input }`. History reload passes the stored values directly instead of calling setters and immediately reading the old closure. Batch task submission completes or returns partial results before navigating.

- [ ] **Step 5: Make settings truthful**

Keep root, folder mode/name, name format, concurrency, proxy, timeout, and retry. Remove max size, chunk size, music, dynamic cover, and static cover controls until implemented. Treat empty numeric inputs as editor strings and validate finite ranges before save. Check `result.success` before showing success.

- [ ] **Step 6: Fix Channels URL/Cookie UI**

Always extract the first URL with a URL regex and `new URL()`. Never render Cookie prefixes or full Cookie in DOM attributes. Use `open-folder`/`shell.openPath` for local paths, not `openExternalUrl`.

- [ ] **Step 7: Sanitize spreadsheet-facing text and quality choice**

Apply a shared `sanitizeSpreadsheetCell()` to CSV/XLSX exports. In `douyinWork.js`, sort bit-rate candidates by height then bit rate for `auto`; do not prefer ordinary `play_addr` before the best candidate.

- [ ] **Step 8: Verify renderer phase**

Run: `npm test` and `npm run build:react`.

Expected: exit 0 and no unhandled promise warnings in the test output.

---

### Task 11: Enforce navigation, IPC, URL, and webview boundaries

**Files:**
- Create: `src/native/security/ipcGuards.js`
- Create: `tests/ipc-guards.test.js`
- Modify: `tests/all.test.js`
- Modify: `main.js:193-279, 322-365, 1559-1567`
- Modify: `src/components/AdDisplay.jsx`

- [ ] **Step 1: Write failing security validation tests**

Assert:

```js
isTrustedRendererUrl('file:///.../dist-react/index.html', { packaged:true }) === true
isTrustedRendererUrl('https://evil.example/', { packaged:true }) === false
validateExternalUrl('https://allowed.example/path', ['allowed.example']) succeeds
validateExternalUrl('file:///C:/secret') throws
validateExternalUrl('custom://run') throws
validateExternalUrl('https://user:pass@allowed.example/') throws
```

- [ ] **Step 2: Verify RED**

Run: `npm test`

Expected: missing guard module.

- [ ] **Step 3: Implement guard helpers**

Export `isTrustedRendererUrl`, `assertTrustedSender(event, policy)`, `validateExternalUrl`, `validateHttpUrl`, and `validateString`. Normalize hostname with `URL`, forbid credentials/control characters, and compare exact hosts or explicit subdomain rules.

- [ ] **Step 4: Restrict main-window navigation**

In production allow only the loaded `file:` application. In development allow only `http://localhost:3000`. Prevent every other navigation and open allowlisted HTTPS links externally. Keep `setWindowOpenHandler` returning `{ action:'deny' }`.

- [ ] **Step 5: Harden webviews**

Register `app.on('web-contents-created')`. In `will-attach-webview`, delete `preload`, set `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true`, and reject URLs outside the explicit platform host list. Deny permission requests by default and allow only specifically required media permission after host validation.

- [ ] **Step 6: Restore control-panel TLS**

Delete the IP-direct agent with `rejectUnauthorized:false`. Use normal domain HTTPS with certificate validation. If a cached IP is retained, set `servername` to the domain and keep verification enabled. Do not fall back to insecure transport.

- [ ] **Step 7: Replace the ad HTML sanitizer**

Install DOMPurify or implement an explicit allowlist that excludes `form`, `input`, `button`, `action`, `formaction`, `iframe`, event attributes, and navigation attributes. Promo URLs must pass the same HTTPS host validation before iframe use.

- [ ] **Step 8: Apply trusted-sender validation to high-privilege IPC**

Cover every handler in these channel groups: `download-*`, `stop-download`, `delete-task`, `delete-tasks`, `retry-task`, `retry-tasks`, `save-settings`, `set-cookie-manual`, `clear-cookies`, `import-browser-cookies`, `get-cookies`, `my-account-*`, `open-external-url`, `open-folder`, `close-browser`, `set-control-panel-url`, `get-yuanbao-cookie`, and `set-yuanbao-cookie-manual`. Return `{ success:false, code:'UNTRUSTED_RENDERER', error:'请求来源不受信任' }` without performing the operation.

- [ ] **Step 9: Verify security phase**

Run: `npm test`, `_test_login_window_navigation.js`, and `npm run build:react`.

Expected: all pass; source search finds no `rejectUnauthorized: false` and no unvalidated `shell.openExternal(url)`.

---

### Task 12: Encrypt, redact, and truly clear credentials

**Files:**
- Create: `src/native/security/secretStore.js`
- Create: `tests/secret-store.test.js`
- Modify: `tests/all.test.js`
- Modify: `main.js:91-125, 843-1052, 2663-2694, 5356-5445, 7104-7107`
- Modify: `src/native/database.js:207-221, 742-775`
- Modify: `src/native/ytCookieFile.js`
- Modify: `src/components/CookieManager.jsx`
- Modify: `src/components/ChannelsDownload.jsx`

- [ ] **Step 1: Write failing secret-store tests with an injected crypto adapter**

Use a fake safeStorage adapter whose ciphertext begins with `enc:`. Assert plaintext saves encrypted, loads decrypted, legacy plaintext migrates on first read, and `redactSecret('abcdef')` never contains `abc`.

- [ ] **Step 2: Verify RED**

Run: `npm test`

Expected: missing secretStore module.

- [ ] **Step 3: Implement the adapter**

Create `createSecretStore({ safeStorage, getRaw, setRaw, deleteRaw })` with `get`, `set`, and `delete`. Store `{ v:1, encrypted:true, data:<base64> }`. If encryption is unavailable, return a visible `SECURE_STORAGE_UNAVAILABLE` error instead of silently writing new plaintext.

- [ ] **Step 4: Migrate platform Cookie reads/writes**

All `cookie_*` reads and writes go through the secret store. Existing SQLite/electron-store plaintext is migrated on successful decrypt-capable startup, then removed from the redundant store. `listMyAccounts()` returns a DTO without `cookie`; add a main-process-only `getMyAccountSecret(uid)` for requests that require it.

- [ ] **Step 5: Implement complete clear semantics**

Create one `clearPlatformCredentials(platform)` function that clears the partition, secret store, legacy store key, matching temporary Cookie files, and platform-specific cached API/hidden window. UI checks `success` before reporting completion.

- [ ] **Step 6: Remove secret-bearing logs and argv**

Delete Cookie-prefix logging. Pass Bilibili/YouTube cookies through task-specific Netscape files and never print their paths alongside values. Add `cleanupStaleCookieFiles({ maxAgeMs: 24*60*60*1000 })` at startup.

- [ ] **Step 7: Verify no renderer secret exposure**

Tests assert `get-cookies`, `my-account-list`, bind, and refresh results do not contain a `cookie` or `cookieString` property. Run a source search for `substring(0, 50)`, `--add-header.*Cookie`, and `args.join(' ')`; expected no secret-bearing occurrences.

Run: `npm test`. Expected: exit 0.

---

### Task 13: Fix remaining listener, monitor, and persistence UI defects

**Files:**
- Modify: `src/components/AccountManager.jsx`
- Modify: `src/components/Monitor.jsx`
- Modify: `src/components/OperationHub.jsx`
- Modify: `src/components/XhsProfileDownload.jsx`
- Modify: `src/native/xhsProfile.js`
- Modify: `src/native/kuaishouProfile.js`
- Modify: `src/native/universalSniffer.js`
- Modify: `src/native/youtubeShorts.js`
- Modify: `src/native/apiService.js`
- Modify: `src/utils/api.js`
- Modify: `tests/main-integration.test.js`

- [ ] **Step 1: Replace renderer-wide listener removal**

Every subscription stores the returned unsubscribe function and invokes only that function in cleanup. Remove component calls to `removeAllListeners(channel)`.

- [ ] **Step 2: Make account migration lossless**

Delete `saved_accounts` from localStorage only when the migration IPC returns success and the returned migrated count/IDs cover every source account. Otherwise preserve backup and show a visible error.

- [ ] **Step 3: Refresh monitor group and read state**

After group deletion, reload or clear affected `groupId` values for users/videos. Entering the events view calls `monitorMarkEventsRead` and updates local event objects to `read:true`.

- [ ] **Step 4: Fix hidden-window ownership**

Each platform has one creation promise and one serial operation queue. Creation promise resets in `finally`. Register named event handlers and remove only those handlers in `finally`; never call `removeAllListeners` on shared webContents/debugger objects.

- [ ] **Step 5: Enforce sniffer limits before insertion**

Check URL/body/list limits before adding pending resources. Resource upgrades update an existing entry without incrementing the cap.

- [ ] **Step 6: Fix confirmed small data bugs**

- Honor the caller's YouTube page limit instead of coercing 50/100/999 to 20.
- Assign Bilibili `uname` from the parsed owner response before returning.
- Add timeout, AbortSignal, and a bounded 8 MiB response body to channels API requests.
- Preserve method `this` binding in `src/utils/api.js` exports by wrapping calls in arrow functions.

- [ ] **Step 7: Verify remaining-source contracts**

Extend `main-integration.test.js` with assertions for the page limit, `uname` assignment, absence of shared `removeAllListeners`, and channels request timeout/body cap.

Run: `npm test` and `npm run build:react`. Expected: exit 0.

---

### Task 14: Make Windows x64 packaging reproducible

**Files:**
- Modify: `package.json`
- Modify: `build/afterPack.js`
- Create: `build/verify-win64-tools.js`
- Create: `tests/package-config.test.js`
- Modify: `tests/all.test.js`
- Modify: `README.md`
- Modify: `QUICK_START.md`
- Modify: `启动说明.md`

- [ ] **Step 1: Write failing package-config tests**

Parse `package.json` and assert:

```js
build.win.target[0].arch deep-equals ['x64']
build.directories.output is relative
build.mac is undefined
scripts['build:mac'] is undefined
```

Read PE headers for Electron, `assets/yt-dlp.exe`, and ffmpeg-static and assert machine `0x8664`.

- [ ] **Step 2: Verify RED**

Run: `npm test`

Expected: ia32/mac/absolute-output assertions fail.

- [ ] **Step 3: Update build configuration**

Set output to `release`, target only x64 NSIS, remove mac config and script, and add:

```json
"prepack:win64": "node build/verify-win64-tools.js",
"build:win": "npm run check && npm run prepack:win64 && electron-builder --win --x64"
```

- [ ] **Step 4: Make afterPack locate resources by platform API**

Use electron-builder context/packager resource-directory helpers instead of assuming `<appOutDir>/resources/app`. Because only Windows x64 remains, fail with a clear error on any non-Windows platform rather than advertising unsupported output.

- [ ] **Step 5: Correct documentation**

Remove Python-backend startup/packaging instructions. State that the active app is Electron+Node, supported platform is Windows 10/11 x64, output is `release/`, and `抖音下载器源码/` is unrelated legacy source not used by the client.

- [ ] **Step 6: Verify package configuration**

Run: `npm test`, `npm run check`, and `npm run prepack:win64`.

Expected: all exit 0 and all external tools report x64.

---

### Task 15: Upgrade vulnerable dependencies deliberately

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/utils/xlsxExport.js`
- Modify: `src/components/AccountManager.jsx`
- Modify: `src/components/MyAccounts.jsx`
- Modify: `src/components/ProfileDownload.jsx`
- Create: `tests/dependency-contract.test.js`
- Modify: `tests/all.test.js`

- [ ] **Step 1: Capture the pre-upgrade audit**

Run:

```powershell
npm audit --omit=dev --registry=https://registry.npmjs.org --json
npm audit --registry=https://registry.npmjs.org --json
```

Expected baseline from the audit on 2026-08-11: production total 7 and full total 32. Save only counts and package names in the task log; do not create a generated audit artifact in the source tree.

- [ ] **Step 2: Upgrade one dependency group at a time**

Apply groups in this order, running `npm test` and `npm run build:react` after each:

1. Install `axios@1.18.0`.
2. Install `sm-crypto@0.5.5` and verify a fixed known SM3 fixture output.
3. Remove `xlsx@0.18.5`, install `exceljs@4.4.0`, keep the current `exportVideosToXlsx` signature, and write only sanitized string/number/date cells.
4. Install `vite@6.4.3` and `@vitejs/plugin-react@5.0.4` together.
5. Install `electron-builder@26.15.3`.
6. Install `electron@41.7.1`, then run all Electron mock tests and a packaged startup smoke test.

Do not run `npm audit fix --force`.

- [ ] **Step 3: Add dependency contract tests**

Assert removed dependencies are absent, required replacements are present, SM3 fixture output is unchanged, and an exported workbook begins with the ZIP magic bytes `PK` while dangerous formula prefixes are stored as text.

- [ ] **Step 4: Verify the final audit**

Run both official-registry audit commands again.

Expected: zero production critical vulnerabilities. Any remaining high/moderate advisory must be listed with package, reachable code path, and reason it cannot be fixed without breaking the application; do not hide audit failures.

---

### Task 16: Full delivery verification

**Files:**
- Modify only files required to fix failures exposed by this task.

- [ ] **Step 1: Verify the Python exclusion boundary**

Before implementation begins, calculate a recursive SHA-256 manifest for `抖音下载器源码/` into the OS temporary directory. At final verification calculate it again and compare. Do not write the manifest into the Python directory or project.

Expected: zero changed/missing/added Python files.

- [ ] **Step 2: Run the full offline test gate**

Run: `npm test`

Expected: all tests pass, zero failures, zero unhandled rejections, no orphan child process.

- [ ] **Step 3: Run syntax and renderer build checks**

Run:

```powershell
node --check main.js
node --check preload.js
node --check preload-login.js
npm run build:react
```

Expected: all exit 0.

- [ ] **Step 4: Run IPC inventory verification**

Re-run the preload-to-main channel comparison. Expected: every exposed invoke/send channel has a main-process handler/listener, and every event subscription returns a precise unsubscribe.

- [ ] **Step 5: Build an unpacked Windows x64 application**

Run `npm run pack -- --win --x64` or the equivalent electron-builder directory command with output directed to a validated temporary/release directory.

Expected: afterPack completes, app launches to the local React page, and yt-dlp/ffmpeg `--version` smoke tests succeed from packaged resource paths.

- [ ] **Step 6: Run dependency audit**

Run official-registry production and full audits. Expected: no production critical vulnerability and an explicit report for any remaining advisory.

- [ ] **Step 7: Perform bounded manual smoke tests**

Without using a real platform account, verify:

- application starts once and a second launch focuses it;
- settings validation rejects invalid values;
- external non-HTTPS URL is rejected;
- local fake HTTP download completes;
- local slow download stops and leaves no final/part file;
- restarting the app reloads a synthetic special task payload;
- clearing a synthetic Cookie removes every persistence layer;
- batch UI displays completed, partial, failed, and stopped distinctly.

- [ ] **Step 8: Produce the handoff report**

Report changed files, tests and exact outputs, audit counts, unsupported/unverified real-platform paths, and the unchanged Python manifest result. Do not claim real Douyin/TikTok/Bilibili downloads work unless they were separately authorized and exercised.

---

## Plan self-review mapping

- Task lifecycle and concurrency: Tasks 2, 3, 6.
- Restart recovery and persistence: Task 4.
- File integrity and special download correctness: Tasks 5, 7, 8.
- Renderer batch/download-management behavior: Tasks 9, 10.
- Navigation, IPC, path, TLS, and webview safety: Task 11.
- Cookie secrecy and complete logout: Task 12.
- Remaining listener/data defects: Task 13.
- Windows x64-only packaging and stale docs: Task 14.
- Dependency vulnerabilities and Excel replacement: Task 15.
- Full evidence-based delivery and Python exclusion: Task 16.

All design requirements have a corresponding task. Function names used across tasks are consistent: `transitionTask`, `createTaskFinalizer`, `resetTaskForRetry`, `createScheduler`, `buildTaskPayload`, `applyTaskPayload`, `writeStreamToPart`, `runCancellableProcess`, `aggregateBatch`, `mergeTaskEvent`, `upsertResource`, `assertTrustedSender`, and `createSecretStore`.
