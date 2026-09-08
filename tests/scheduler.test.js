'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler } = require('../src/native/download/scheduler');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

test('scheduler fills all available slots without exceeding the limit', async () => {
  const gates = Array.from({ length: 5 }, () => deferred());
  const started = [];
  let running = 0;
  let peak = 0;

  const scheduler = createScheduler({
    limit: 3,
    run: async task => {
      running += 1;
      peak = Math.max(peak, running);
      started.push(task.id);
      await gates[task.index].promise;
      running -= 1;
    },
  });

  for (let index = 0; index < gates.length; index += 1) {
    assert.equal(scheduler.enqueue({ id: `task-${index}`, index, status: 'pending' }), true);
  }

  await Promise.resolve();
  assert.deepEqual(started, ['task-0', 'task-1', 'task-2']);
  assert.deepEqual(scheduler.stats(), { active: 3, queued: 2, limit: 3 });
  assert.equal(peak, 3);

  gates[0].resolve();
  gates[1].resolve();
  gates[2].resolve();
  await nextTurn();

  assert.deepEqual(started, ['task-0', 'task-1', 'task-2', 'task-3', 'task-4']);
  assert.equal(peak, 3);

  gates[3].resolve();
  gates[4].resolve();
  await scheduler.whenIdle();

  assert.equal(peak, 3);
  assert.deepEqual(scheduler.stats(), { active: 0, queued: 0, limit: 3 });
});

test('scheduler removes a pending task before its scheduling microtask runs', async () => {
  let runCount = 0;
  const scheduler = createScheduler({
    limit: 1,
    run: async () => {
      runCount += 1;
    },
  });

  assert.equal(scheduler.enqueue({ id: 'cancel-me', status: 'pending' }), true);
  const idle = scheduler.whenIdle();
  assert.equal(scheduler.remove('cancel-me'), true);
  await idle;
  await nextTurn();

  assert.equal(runCount, 0);
  assert.equal(scheduler.has('cancel-me'), false);
});

test('scheduler rejects duplicate pending and active ids, then permits reuse after completion', async () => {
  const firstGate = deferred();
  const scheduler = createScheduler({
    limit: 1,
    run: task => task.gate ? task.gate.promise : Promise.resolve(),
  });

  assert.equal(scheduler.enqueue({ id: 'same-id', status: 'pending', gate: firstGate }), true);
  assert.equal(scheduler.enqueue({ id: 'same-id', status: 'pending' }), false);
  assert.equal(scheduler.has('same-id'), true);

  await Promise.resolve();
  assert.equal(scheduler.has('same-id'), true);
  assert.equal(scheduler.enqueue({ id: 'same-id', status: 'pending' }), false);

  firstGate.resolve();
  await scheduler.whenIdle();
  assert.equal(scheduler.has('same-id'), false);
  assert.equal(scheduler.enqueue({ id: 'same-id', status: 'pending' }), true);
  await scheduler.whenIdle();
});

test('scheduler discards non-pending tasks and still becomes idle', async () => {
  let runCount = 0;
  const scheduler = createScheduler({
    limit: 2,
    run: async () => {
      runCount += 1;
    },
  });

  assert.equal(scheduler.enqueue({ id: 'already-failed', status: 'failed' }), true);
  assert.equal(scheduler.enqueue({ id: 'already-stopped', status: 'stopped' }), true);
  await scheduler.whenIdle();

  assert.equal(runCount, 0);
  assert.deepEqual(scheduler.stats(), { active: 0, queued: 0, limit: 2 });
});

test('run rejection calls onError, frees the slot, and isolates onError failures', async () => {
  const started = [];
  const errors = [];
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const scheduler = createScheduler({
      limit: 1,
      run: async task => {
        started.push(task.id);
        if (task.id === 'fails') throw new Error('run failed');
      },
      onError: (task, error) => {
        errors.push([error.message, task.id]);
        throw new Error('onError failed');
      },
    });

    scheduler.enqueue({ id: 'fails', status: 'pending' });
    scheduler.enqueue({ id: 'continues', status: 'pending' });
    await scheduler.whenIdle();
    await nextTurn();

    assert.deepEqual(started, ['fails', 'continues']);
    assert.deepEqual(errors, [['run failed', 'fails']]);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(scheduler.stats(), { active: 0, queued: 0, limit: 1 });
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('whenIdle resolves immediately while idle and stats and has cover pending and active tasks', async () => {
  const gate = deferred();
  const scheduler = createScheduler({ limit: 1, run: task => task.gate.promise });

  await scheduler.whenIdle();
  assert.deepEqual(scheduler.stats(), { active: 0, queued: 0, limit: 1 });

  scheduler.enqueue({ id: 'active', status: 'pending', gate });
  scheduler.enqueue({ id: 'queued', status: 'pending', gate: deferred() });
  assert.equal(scheduler.has('active'), true);
  assert.equal(scheduler.has('queued'), true);
  assert.deepEqual(scheduler.stats(), { active: 0, queued: 2, limit: 1 });

  await Promise.resolve();
  assert.equal(scheduler.has('active'), true);
  assert.equal(scheduler.has('queued'), true);
  assert.deepEqual(scheduler.stats(), { active: 1, queued: 1, limit: 1 });

  const firstIdleWaiter = scheduler.whenIdle();
  const secondIdleWaiter = scheduler.whenIdle();
  assert.equal(scheduler.remove('queued'), true);
  gate.resolve();
  await Promise.all([firstIdleWaiter, secondIdleWaiter]);
});

test('scheduler validates its configuration and task ids', () => {
  assert.throws(() => createScheduler({ limit: 0, run: async () => {} }), /limit/i);
  assert.throws(() => createScheduler({ limit: 1.5, run: async () => {} }), /limit/i);
  assert.throws(() => createScheduler({ limit: 1 }), /run/i);

  const scheduler = createScheduler({ limit: 1, run: async () => {} });
  assert.equal(scheduler.enqueue({ status: 'pending' }), false);
  assert.equal(scheduler.enqueue({ id: '', status: 'pending' }), false);
  assert.equal(scheduler.enqueue(null), false);
});

test('scheduler applies a validated runtime concurrency limit', async () => {
  const gates = [deferred(), deferred()];
  const started = [];
  const scheduler = createScheduler({
    limit: 1,
    run: task => {
      started.push(task.id);
      return gates[task.id - 1].promise;
    },
  });

  scheduler.enqueue({ id: 1, status: 'pending' });
  scheduler.enqueue({ id: 2, status: 'pending' });
  await Promise.resolve();
  assert.deepEqual(started, [1]);
  assert.equal(scheduler.setLimit(2), 2);
  await Promise.resolve();
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(scheduler.stats(), { active: 2, queued: 0, limit: 2 });
  assert.throws(() => scheduler.setLimit(0), /limit/i);
  gates.forEach(gate => gate.resolve());
  await scheduler.whenIdle();
});

test('scheduler coalesces pump microtasks and releases pending ids on every exit path', async () => {
  const scheduled = [];
  const originalQueueMicrotask = global.queueMicrotask;
  let runCount = 0;
  const scheduler = createScheduler({
    limit: 2,
    run: async () => {
      runCount += 1;
    },
  });

  try {
    global.queueMicrotask = callback => scheduled.push(callback);
    assert.equal(scheduler.enqueue({ id: 'removed', status: 'pending' }), true);
    assert.equal(scheduler.enqueue({ id: 'discarded', status: 'failed' }), true);
    assert.equal(scheduler.enqueue({ id: 'completed', status: 'pending' }), true);
  } finally {
    global.queueMicrotask = originalQueueMicrotask;
  }

  assert.equal(scheduled.length, 1);
  assert.equal(scheduler.has('removed'), true);
  assert.equal(scheduler.remove('removed'), true);
  assert.equal(scheduler.has('removed'), false);

  scheduled[0]();
  await scheduler.whenIdle();
  assert.equal(runCount, 1);
  assert.equal(scheduler.has('discarded'), false);
  assert.equal(scheduler.has('completed'), false);

  assert.equal(scheduler.enqueue({ id: 'discarded', status: 'pending' }), true);
  assert.equal(scheduler.enqueue({ id: 'completed', status: 'pending' }), true);
  await scheduler.whenIdle();
  assert.equal(runCount, 3);
});
