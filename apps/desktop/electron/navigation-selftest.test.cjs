const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForFittedView, measureStableLayout } = require('./navigation-selftest.cjs');

function clock() {
  let time = 0;
  return {
    now: () => time,
    pause: async () => {
      time += 100;
    },
  };
}

test('Fit baseline refits when canvas resizes without changing the previous zoom', async () => {
  let samples = 0,
    width = 337,
    scale = 6.08742774566474,
    refits = 0;
  const read = async () => {
    if (++samples === 4) width = 450; // Native resize preserves the old camera zoom.
    return { scale, ready: true, layoutKey: [width, 609] };
  };
  const result = await waitForFittedView(
    read,
    async () => {
      refits++;
      scale = (6.08742774566474 * width) / 337;
    },
    clock(),
  );
  assert.equal(refits, 1);
  assert.ok(Math.abs(result.scale - 8.128612716763007) < 1e-12);
  assert.equal(await measureStableLayout(read, result), result.scale);
  width = 500;
  await assert.rejects(measureStableLayout(read, result), /layout changed during navigation/);
  assert.equal(refits, 1, 'a post-baseline resize never silently resets tested navigation');
});

test('unstable layout times out within the same deadline instead of retrying indefinitely', async () => {
  let width = 100,
    refits = 0;
  await assert.rejects(
    waitForFittedView(
      async () => ({ scale: 1, layoutKey: ++width }),
      async () => {
        refits++;
      },
      clock(),
    ),
    /baseline did not settle/,
  );
  assert.ok(refits > 0 && refits <= 150, 'all refits share the original 15-second deadline');
});

test('a not-ready viewport is refitted before it can establish a stable baseline', async () => {
  let samples = 0,
    scale = 1,
    refits = 0;
  const result = await waitForFittedView(
    async () => ({ scale, ready: ++samples > 2, layoutKey: [400, 600] }),
    async () => {
      refits++;
      scale = 2;
    },
    clock(),
  );
  assert.equal(result.scale, 2);
  assert.equal(refits, 1);
});
