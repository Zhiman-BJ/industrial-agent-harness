const MAX_TIMER_MS = 2147483647n;
const NS_PER_MS = 1000000n;

function parseTimeoutMs(value) {
  const text = String(value);
  if (
    !/^[0-9]+$/.test(text) ||
    BigInt(text) === 0n ||
    (typeof value === 'number' && !Number.isSafeInteger(value))
  )
    throw Error(
      '--timeout-ms must be a positive integer in milliseconds; omit it for no time limit.',
    );
  return BigInt(text);
}

function scheduleTimeout(
  value,
  onTimeout,
  { now = process.hrtime.bigint, setTimer = setTimeout, clearTimer = clearTimeout } = {},
) {
  if (value === undefined) return;
  const milliseconds = parseTimeoutMs(value);
  const deadline = now() + milliseconds * NS_PER_MS;
  let timer;
  let active = true;
  const tick = () => {
    if (!active) return;
    const remaining = deadline - now();
    if (remaining <= 0n) {
      active = false;
      timer = undefined;
      onTimeout(
        milliseconds <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(milliseconds)
          : milliseconds.toString(),
      );
      return;
    }
    // Node clamps an overflowing timer to 1 ms. Keep long deadlines exact and
    // wait in supported chunks, using a monotonic clock across every chunk.
    const delay = (remaining + NS_PER_MS - 1n) / NS_PER_MS;
    timer = setTimer(tick, Number(delay > MAX_TIMER_MS ? MAX_TIMER_MS : delay));
  };
  tick();
  return () => {
    active = false;
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
}

module.exports = { parseTimeoutMs, scheduleTimeout };
