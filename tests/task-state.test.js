'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TERMINAL,
  transitionTask,
  createTaskFinalizer,
  resetTaskForRetry,
  resetAndEnqueueTaskForRetry,
} = require('../src/native/download/taskState.js');

function createTask(status, overrides = {}) {
  return {
    status,
    progress: 50,
    receivedBytes: 500,
    totalBytes: 1000,
    error: 'previous error',
    endTime: 0,
    cancelled: true,
    revision: 3,
    updatedTime: 1,
    ...overrides,
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('TERMINAL contains exactly the supported terminal statuses', () => {
  assert.deepEqual(
    [...TERMINAL].sort(),
    ['completed', 'deleted', 'failed', 'partial', 'stopped'].sort(),
  );
});

test('a stopped task cannot be overwritten by a late completed transition', () => {
  const task = createTask('downloading');

  assert.equal(transitionTask(task, 'stopped'), true);
  assert.equal(task.status, 'stopped');
  assert.equal(task.revision, 4);
  assert.ok(task.updatedTime > 1);
  assert.ok(task.endTime > 0);

  const stoppedSnapshot = { ...task };
  assert.equal(transitionTask(task, 'completed'), false);
  assert.deepEqual(task, stoppedSnapshot);
});

test('transitionTask merges patch fields but protects state metadata', () => {
  const task = createTask('downloading');

  assert.equal(transitionTask(task, 'partial', {
    progress: 75,
    error: 'one segment failed',
    status: 'failed',
    revision: 99,
    updatedTime: -1,
    endTime: -1,
  }), true);

  assert.equal(task.progress, 75);
  assert.equal(task.error, 'one segment failed');
  assert.equal(task.status, 'partial');
  assert.equal(task.revision, 4);
  assert.ok(task.updatedTime > 1);
  assert.ok(task.endTime > 0);
});

test('transitionTask preserves an existing endTime', () => {
  const task = createTask('downloading', { endTime: 123 });

  assert.equal(transitionTask(task, 'stopped', { endTime: 999 }), true);
  assert.equal(task.endTime, 123);
});

test('createTaskFinalizer completes once in cleanup, persist, emit order', async () => {
  const task = createTask('downloading');
  const calls = [];
  const finalize = createTaskFinalizer({
    task,
    cleanup() {
      calls.push(['cleanup']);
    },
    persist(currentTask) {
      calls.push(['persist', currentTask.status]);
    },
    emit(eventName, currentTask) {
      calls.push(['emit', eventName, currentTask.status]);
    },
  });

  assert.equal(await finalize('stopped'), true);
  assert.deepEqual(calls, [
    ['cleanup'],
    ['persist', 'stopped'],
    ['emit', 'download-stopped', 'stopped'],
  ]);

  assert.equal(await finalize('stopped'), false);
  assert.equal(await finalize('completed'), false);
  assert.deepEqual(calls, [
    ['cleanup'],
    ['persist', 'stopped'],
    ['emit', 'download-stopped', 'stopped'],
  ]);
});

test('createTaskFinalizer applies patch and emits a shallow task copy', async () => {
  const task = createTask('downloading');
  const metadata = { segmentCount: 2 };
  let persistedTask;
  let emittedChannel;
  let emittedTask;
  const finalize = createTaskFinalizer({
    task,
    cleanup() {},
    persist(currentTask) {
      persistedTask = currentTask;
    },
    emit(channel, payload) {
      emittedChannel = channel;
      emittedTask = payload;
    },
  });

  assert.equal(await finalize('partial', {
    progress: 80,
    error: 'missing segment',
    metadata,
  }), true);

  assert.strictEqual(persistedTask, task);
  assert.equal(task.progress, 80);
  assert.equal(task.error, 'missing segment');
  assert.equal(emittedChannel, 'download-partial');
  assert.notStrictEqual(emittedTask, task);
  assert.deepEqual(emittedTask, task);
  assert.strictEqual(emittedTask.metadata, metadata);
});

test('createTaskFinalizer awaits cleanup and persist before later steps', async () => {
  const task = createTask('downloading');
  const cleanupGate = createDeferred();
  const persistGate = createDeferred();
  const persistStarted = createDeferred();
  const calls = [];
  const finalize = createTaskFinalizer({
    task,
    async cleanup() {
      calls.push('cleanup:start');
      await cleanupGate.promise;
      calls.push('cleanup:end');
    },
    async persist(currentTask) {
      calls.push(`persist:${currentTask.status}:start`);
      persistStarted.resolve();
      await persistGate.promise;
      calls.push('persist:end');
    },
    emit(channel) {
      calls.push(`emit:${channel}`);
    },
  });

  const resultPromise = finalize('stopped', { progress: 60 });
  assert.equal(task.status, 'downloading');
  assert.deepEqual(calls, ['cleanup:start']);

  cleanupGate.resolve();
  await persistStarted.promise;
  assert.equal(task.status, 'stopped');
  assert.equal(task.progress, 60);
  assert.deepEqual(calls, [
    'cleanup:start',
    'cleanup:end',
    'persist:stopped:start',
  ]);

  persistGate.resolve();
  assert.equal(await resultPromise, true);
  assert.deepEqual(calls, [
    'cleanup:start',
    'cleanup:end',
    'persist:stopped:start',
    'persist:end',
    'emit:download-stopped',
  ]);
});

test('same-target concurrent finalizer calls share one in-flight run', async () => {
  const task = createTask('downloading');
  const cleanupGate = createDeferred();
  const calls = [];
  const finalize = createTaskFinalizer({
    task,
    async cleanup() {
      calls.push('cleanup');
      await cleanupGate.promise;
    },
    async persist() {
      calls.push('persist');
    },
    async emit() {
      calls.push('emit');
    },
  });
  const firstPatch = { progress: 60 };

  const firstResult = finalize('stopped', firstPatch);
  firstPatch.progress = 10;
  const secondResult = finalize('stopped', { progress: 99 });
  assert.deepEqual(calls, ['cleanup']);

  cleanupGate.resolve();
  assert.deepEqual(await Promise.all([firstResult, secondResult]), [true, true]);
  assert.equal(task.progress, 60);
  assert.deepEqual(calls, ['cleanup', 'persist', 'emit']);

  assert.equal(await finalize('stopped'), false);
  assert.deepEqual(calls, ['cleanup', 'persist', 'emit']);
});

test('finalizer retries cleanup after cleanup rejects', async () => {
  const task = createTask('downloading');
  let cleanupCalls = 0;
  let persistCalls = 0;
  let emitCalls = 0;
  const finalize = createTaskFinalizer({
    task,
    async cleanup() {
      cleanupCalls += 1;
      if (cleanupCalls === 1) throw new Error('cleanup failed');
    },
    async persist() {
      persistCalls += 1;
    },
    async emit() {
      emitCalls += 1;
    },
  });

  await assert.rejects(finalize('failed', { progress: 40 }), /cleanup failed/);
  assert.equal(task.status, 'downloading');
  assert.equal(task.revision, 3);
  assert.deepEqual([cleanupCalls, persistCalls, emitCalls], [1, 0, 0]);

  assert.equal(await finalize('failed', { progress: 99 }), true);
  assert.equal(task.status, 'failed');
  assert.equal(task.progress, 40);
  assert.equal(task.revision, 4);
  assert.deepEqual([cleanupCalls, persistCalls, emitCalls], [2, 1, 1]);
});

test('finalizer resumes at persist without repeating cleanup or transition', async () => {
  const task = createTask('downloading');
  let cleanupCalls = 0;
  let persistCalls = 0;
  let emitCalls = 0;
  const finalize = createTaskFinalizer({
    task,
    async cleanup() {
      cleanupCalls += 1;
    },
    async persist() {
      persistCalls += 1;
      if (persistCalls === 1) throw new Error('persist failed');
    },
    async emit() {
      emitCalls += 1;
    },
  });

  await assert.rejects(finalize('partial', { progress: 70 }), /persist failed/);
  const firstEndTime = task.endTime;
  assert.equal(task.status, 'partial');
  assert.equal(task.revision, 4);
  assert.deepEqual([cleanupCalls, persistCalls, emitCalls], [1, 1, 0]);

  assert.equal(await finalize('partial', { progress: 99 }), true);
  assert.equal(task.progress, 70);
  assert.equal(task.revision, 4);
  assert.equal(task.endTime, firstEndTime);
  assert.deepEqual([cleanupCalls, persistCalls, emitCalls], [1, 2, 1]);
});

test('finalizer retries only async emit with one stable payload', async () => {
  const task = createTask('downloading');
  let cleanupCalls = 0;
  let persistCalls = 0;
  const emittedPayloads = [];
  const finalize = createTaskFinalizer({
    task,
    async cleanup() {
      cleanupCalls += 1;
    },
    async persist(currentTask) {
      persistCalls += 1;
      currentTask.persistedAfterSnapshot = true;
    },
    emit(channel, payload) {
      assert.equal(channel, 'download-partial');
      emittedPayloads.push(payload);
      if (emittedPayloads.length === 1) {
        const rejection = Promise.reject(new Error('emit failed'));
        rejection.catch(() => {});
        return rejection;
      }
      return Promise.resolve();
    },
  });

  await assert.rejects(finalize('partial', { progress: 80 }), /emit failed/);
  assert.equal(task.status, 'partial');
  assert.equal(task.revision, 4);
  assert.deepEqual([cleanupCalls, persistCalls, emittedPayloads.length], [1, 1, 1]);
  assert.notStrictEqual(emittedPayloads[0], task);
  assert.equal(emittedPayloads[0].progress, 80);
  assert.equal(emittedPayloads[0].persistedAfterSnapshot, undefined);

  task.progress = 5;
  assert.equal(await finalize('partial', { progress: 99 }), true);
  assert.equal(task.revision, 4);
  assert.deepEqual([cleanupCalls, persistCalls, emittedPayloads.length], [1, 1, 2]);
  assert.strictEqual(emittedPayloads[1], emittedPayloads[0]);
  assert.equal(emittedPayloads[1].progress, 80);
});

test('finalizer rejects a different terminal target after choosing one', async () => {
  const task = createTask('downloading');
  const cleanupGate = createDeferred();
  const calls = [];
  const finalize = createTaskFinalizer({
    task,
    async cleanup() {
      calls.push('cleanup');
      await cleanupGate.promise;
    },
    async persist() {
      calls.push('persist');
    },
    async emit() {
      calls.push('emit');
    },
  });

  const stoppedResult = finalize('stopped');
  assert.equal(await finalize('failed'), false);
  assert.deepEqual(calls, ['cleanup']);

  cleanupGate.resolve();
  assert.equal(await stoppedResult, true);
  assert.equal(task.status, 'stopped');
  assert.deepEqual(calls, ['cleanup', 'persist', 'emit']);
});

test('transitionTask cannot reset a failed task to pending', () => {
  const task = createTask('failed', { endTime: 123 });
  const failedSnapshot = { ...task };

  assert.equal(transitionTask(task, 'pending'), false);
  assert.deepEqual(task, failedSnapshot);
});

test('resetTaskForRetry resets failed, partial, and stopped tasks', () => {
  for (const status of ['failed', 'partial', 'stopped']) {
    const task = createTask(status, { endTime: 123 });

    assert.equal(resetTaskForRetry(task), true, status);
    assert.deepEqual(
      {
        status: task.status,
        progress: task.progress,
        receivedBytes: task.receivedBytes,
        totalBytes: task.totalBytes,
        error: task.error,
        endTime: task.endTime,
        cancelled: task.cancelled,
        revision: task.revision,
      },
      {
        status: 'pending',
        progress: 0,
        receivedBytes: 0,
        totalBytes: 0,
        error: null,
        endTime: 0,
        cancelled: false,
        revision: 4,
      },
      status,
    );
    assert.ok(task.updatedTime > 1, status);
  }
});

test('resetTaskForRetry rejects completed, deleted, and downloading tasks', () => {
  for (const status of ['completed', 'deleted', 'downloading']) {
    const task = createTask(status, { endTime: 123 });
    const snapshot = { ...task };

    assert.equal(resetTaskForRetry(task), false, status);
    assert.deepEqual(task, snapshot, status);
  }
});

test('resetAndEnqueueTaskForRetry restores the exact terminal snapshot when enqueue fails', () => {
  const cancelSource = { cancel() {} };
  const task = createTask('failed', {
    id: 'still-active',
    endTime: 123,
    skipped: true,
    cancelSource,
    optionalField: undefined,
  });
  delete task.revision;
  delete task.updatedTime;
  const snapshot = { ...task };
  const originalKeys = Object.keys(task);
  let statusSeenByEnqueue;

  const result = resetAndEnqueueTaskForRetry(task, candidate => {
    statusSeenByEnqueue = candidate.status;
    return false;
  });

  assert.equal(statusSeenByEnqueue, 'pending');
  assert.deepEqual(result, { ok: false, reason: 'enqueue' });
  assert.deepEqual(task, snapshot);
  assert.deepEqual(Object.keys(task), originalKeys);
  assert.equal(task.cancelSource, cancelSource);
  assert.equal(Object.hasOwn(task, 'optionalField'), true);
  assert.equal(Object.hasOwn(task, 'revision'), false);
  assert.equal(Object.hasOwn(task, 'updatedTime'), false);
});

test('a non-terminal finalizer status has no side effects and does not lock it', async () => {
  const task = createTask('downloading');
  const calls = [];
  const finalize = createTaskFinalizer({
    task,
    cleanup() {
      calls.push('cleanup');
    },
    persist() {
      calls.push('persist');
    },
    emit() {
      calls.push('emit');
    },
  });

  assert.equal(await finalize('downloading'), false);
  assert.equal(task.status, 'downloading');
  assert.deepEqual(calls, []);

  assert.equal(await finalize('failed'), true);
  assert.equal(task.status, 'failed');
  assert.deepEqual(calls, ['cleanup', 'persist', 'emit']);
});
