'use strict';

function isValidId(id) {
  if (typeof id === 'string') return id.trim().length > 0;
  return typeof id === 'number' && Number.isFinite(id);
}

function createScheduler(options = {}) {
  const { limit, run, onError } = options;

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError('Scheduler limit must be a positive integer');
  }
  if (typeof run !== 'function') {
    throw new TypeError('Scheduler run must be a function');
  }

  const pending = [];
  const pendingIds = new Set();
  const active = new Map();
  const idleWaiters = new Set();
  let currentLimit = limit;
  let pumpScheduled = false;

  function notifyIdle() {
    if (pending.length > 0 || active.size > 0) return;

    const waiters = Array.from(idleWaiters);
    idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  function has(id) {
    return active.has(id) || pendingIds.has(id);
  }

  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      if (!pumpScheduled) return;
      pumpScheduled = false;
      pump();
    });
  }

  function pump() {
    pumpScheduled = false;
    while (active.size < currentLimit && pending.length > 0) {
      const task = pending.shift();
      if (task) pendingIds.delete(task.id);
      if (!task || task.status !== 'pending') continue;

      const id = task.id;
      active.set(id, task);

      let result;
      try {
        result = run(task);
      } catch (error) {
        result = Promise.reject(error);
      }

      Promise.resolve(result)
        .catch(error => {
          if (typeof onError !== 'function') return undefined;
          return Promise.resolve()
            .then(() => onError(task, error))
            .catch(() => undefined);
        })
        .finally(() => {
          active.delete(id);
          pump();
          notifyIdle();
        });
    }

    notifyIdle();
  }

  function enqueue(task) {
    if (!task || typeof task !== 'object' || !isValidId(task.id) || has(task.id)) {
      return false;
    }

    pending.push(task);
    pendingIds.add(task.id);
    schedulePump();
    return true;
  }

  function remove(id) {
    if (!pendingIds.has(id)) return false;
    const index = pending.findIndex(task => task.id === id);
    if (index === -1) {
      pendingIds.delete(id);
      return false;
    }

    pending.splice(index, 1);
    pendingIds.delete(id);
    notifyIdle();
    return true;
  }

  function whenIdle() {
    if (pending.length === 0 && active.size === 0) return Promise.resolve();
    return new Promise(resolve => idleWaiters.add(resolve));
  }

  function setLimit(nextLimit) {
    if (!Number.isInteger(nextLimit) || nextLimit <= 0) {
      throw new TypeError('Scheduler limit must be a positive integer');
    }
    currentLimit = nextLimit;
    schedulePump();
    return currentLimit;
  }

  function stats() {
    return {
      active: active.size,
      queued: pending.length,
      limit: currentLimit,
    };
  }

  return {
    enqueue,
    remove,
    has,
    pump,
    setLimit,
    whenIdle,
    stats,
  };
}

module.exports = { createScheduler };
