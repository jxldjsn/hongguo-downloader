export const LOGIN_STATUS_REFRESH_MS = 10 * 60 * 1000;

export function createLoginStatusPoller(options = {}) {
  const refresh = options.refresh;
  const subscribe = options.subscribe;
  const setIntervalFn = options.setIntervalFn || globalThis.setInterval;
  const clearIntervalFn = options.clearIntervalFn || globalThis.clearInterval;
  if (typeof refresh !== 'function') throw new TypeError('refresh must be a function');
  if (typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function') {
    throw new TypeError('timer functions are required');
  }

  let inFlight = null;
  let intervalId = null;
  let unsubscribe = null;
  let started = false;
  let stopped = false;

  function run() {
    if (stopped) return Promise.resolve(undefined);
    if (inFlight) return inFlight;

    let result;
    try {
      result = refresh();
    } catch (error) {
      result = Promise.reject(error);
    }
    const base = Promise.resolve(result);
    const flight = base.finally(() => {
      if (inFlight === flight) inFlight = null;
    });
    inFlight = flight;
    return flight;
  }

  function runSilently() {
    void run().catch(() => {});
  }

  function stop() {
    if (!started || stopped) return;
    stopped = true;
    if (intervalId !== null) {
      clearIntervalFn(intervalId);
      intervalId = null;
    }
    if (typeof unsubscribe === 'function') {
      const cleanup = unsubscribe;
      unsubscribe = null;
      cleanup();
    }
  }

  function start() {
    if (started) return stop;
    started = true;
    runSilently();
    intervalId = setIntervalFn(runSilently, LOGIN_STATUS_REFRESH_MS);
    if (typeof subscribe === 'function') unsubscribe = subscribe(runSilently);
    return stop;
  }

  return { run, start, stop };
}
