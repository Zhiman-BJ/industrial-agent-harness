'use strict';

// Host clock adapter for the replay engine (#105). The engine itself is
// timer-free; this adapter owns the interval and guarantees cleanup — a
// double start replaces the timer, dispose stops everything, and callbacks
// never fire after dispose (the "后台计时器正确清理" acceptance).

function createReplayClock({
  onTick,
  intervalMs = 100,
  setTimer = setInterval,
  clearTimer = clearInterval,
  now = Date.now,
} = {}) {
  if (typeof onTick !== 'function') throw Error('replay clock requires an onTick callback');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw Error('intervalMs must be positive');

  let timer = null;
  let disposed = false;

  function stop() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  return {
    start() {
      if (disposed) throw Error('replay clock was disposed');
      stop();
      timer = setTimer(() => {
        if (disposed || timer === null) return;
        onTick(intervalMs, now());
      }, intervalMs);
    },
    stop,
    dispose() {
      disposed = true;
      stop();
    },
    isRunning() {
      return timer !== null && !disposed;
    },
  };
}

module.exports = { createReplayClock };
