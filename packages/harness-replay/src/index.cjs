'use strict';

// @industrial-agent-harness/harness-replay (#105): offline, read-only replay
// of recording bundles (#104). Internal-edition capability under PD-070.
// This package is deliberately dependency-free at runtime — only node
// builtins — so replay can never incidentally reach a live execution path
// (task services, agent runtimes, network). A closure test pins this.

module.exports = {
  ...require('./display-reducer.cjs'),
  buildTimeline: require('./timeline.cjs').buildTimeline,
  DEFAULT_COMPRESSION: require('./timeline.cjs').DEFAULT_COMPRESSION,
  createReplayEngine: require('./engine.cjs').createReplayEngine,
  SPEEDS: require('./engine.cjs').SPEEDS,
  createReplayClock: require('./clock.cjs').createReplayClock,
  describeBundle: require('./describe.cjs').describeBundle,
};
