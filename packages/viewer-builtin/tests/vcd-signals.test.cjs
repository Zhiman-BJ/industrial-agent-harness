const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {initialVcdSignals} = require('../src/waveform/signals.cjs');

test('VCD project files offer real top-level signals to the waveform Viewer', () => {
  const file = path.resolve(__dirname, '../../../examples/chip-sobel/outputs/sobel_wave.vcd');
  assert.deepEqual(initialVcdSignals(file), [
    'TOP.tb_sobel.clk',
    'TOP.tb_sobel.rst_n',
    'TOP.tb_sobel.in_valid',
    'TOP.tb_sobel.in_pixel',
    'TOP.tb_sobel.out_valid',
    'TOP.tb_sobel.out_pixel',
  ]);
});
