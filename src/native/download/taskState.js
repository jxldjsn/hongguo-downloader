'use strict';

const TERMINAL = new Set([
  'completed',
  'partial',
  'failed',
  'stopped',
  'deleted',
]);

const NON_TERMINAL = new Set(['pending', 'downloading']);
const RETRYABLE = new Set(['failed', 'partial', 'stopped']);
const KNOWN_STATUSES = new Set([...NON_TERMINAL, ...TERMINAL]);

const TERMINAL_EVENTS = Object.freeze({
  completed: 'download-completed',
  partial: 'download-partial',
  failed: 'download-failed',
  stopped: 'download-stopped',
  deleted: 'download-deleted',
});

function canTransitionTask(task, nextStatus) {
  if (!task || typeof task !== 'object') return false;
  if (!NON_TERMINAL.has(task.status)) return false;
  if (!KNOWN_STATUSES.has(nextStatus)) return false;
  if (nextStatus === 'pending' || nextStatus === task.status) return false;
  return true;
}

function incrementRevision(task) {
  const revision = Number.isSafeInteger(task.revision) ? task.revision : 0;
  task.revision = revision + 1;
}

function transitionTask(task, nextStatus, patch = {}) {
  if (!canTransitionTask(task, nextStatus)) return false;

  const revision = Number.isSafeInteger(task.revision) ? task.revision : 0;
  const endTime = task.endTime;
  const now = Date.now();
  Object.assign(task, patch);
  task.status = nextStatus;
  task.revision = revision + 1;
  task.updatedTime = now;
  task.endTime = TERMINAL.has(nextStatus) && !endTime ? now : endTime;

  return true;
}

function createTaskFinalizer(options = {}) {
  const task = options.task;
  const cleanup = typeof options.cleanup === 'function' ? options.cleanup : () => {};
  const persist = typeof options.persist === 'function' ? options.persist : () => {};
  const emit = typeof options.emit === 'function' ? options.emit : () => {};
  let targetStatus = null;
  let targetPatch = null;
  let inFlight = null;
  let cleanupDone = false;
  let transitionDone = false;
  let persistDone = false;
  let emitDone = false;
  let completed = false;
  let eventPayload = null;

  async function runStages() {
    if (!cleanupDone) {
      await cleanup();
      cleanupDone = true;
    }

    if (!transitionDone) {
      if (!transitionTask(task, targetStatus, targetPatch)) {
        throw new Error(`Cannot transition task to terminal status: ${targetStatus}`);
      }
      transitionDone = true;
      eventPayload = { ...task };
    }

    if (!persistDone) {
      await persist(task);
      persistDone = true;
    }

    if (!emitDone) {
      await emit(TERMINAL_EVENTS[targetStatus], eventPayload);
      emitDone = true;
    }

    completed = true;
    return true;
  }

  return async function finalize(nextStatus, patch = {}) {
    if (completed || !TERMINAL.has(nextStatus)) return false;
    if (targetStatus !== null && nextStatus !== targetStatus) return false;

    if (targetStatus === null) {
      if (!canTransitionTask(task, nextStatus)) return false;
      targetStatus = nextStatus;
      targetPatch = patch && typeof patch === 'object' ? { ...patch } : {};
    }

    if (inFlight) return inFlight;

    const currentRun = runStages();
    inFlight = currentRun;
    try {
      return await currentRun;
    } finally {
      if (inFlight === currentRun) inFlight = null;
    }
  };
}

function resetTaskForRetry(task) {
  if (!task || typeof task !== 'object' || !RETRYABLE.has(task.status)) {
    return false;
  }

  const now = Date.now();
  task.status = 'pending';
  task.progress = 0;
  task.receivedBytes = 0;
  task.totalBytes = 0;
  task.error = null;
  task.endTime = 0;
  task.cancelled = false;
  incrementRevision(task);
  task.updatedTime = now;
  return true;
}

function restoreTaskSnapshot(task, snapshot) {
  for (const key of Object.keys(task)) delete task[key];
  Object.assign(task, snapshot);
}

function resetAndEnqueueTaskForRetry(task, enqueue) {
  if (typeof enqueue !== 'function') {
    throw new TypeError('Retry enqueue must be a function');
  }

  const snapshot = { ...task };
  if (!resetTaskForRetry(task)) {
    return { ok: false, reason: 'reset' };
  }

  let enqueued;
  try {
    enqueued = enqueue(task);
  } catch (error) {
    restoreTaskSnapshot(task, snapshot);
    throw error;
  }

  if (!enqueued) {
    restoreTaskSnapshot(task, snapshot);
    return { ok: false, reason: 'enqueue' };
  }

  return { ok: true };
}

module.exports = {
  TERMINAL,
  transitionTask,
  createTaskFinalizer,
  resetTaskForRetry,
  resetAndEnqueueTaskForRetry,
};
