'use strict';

// @industrial-agent-harness/harness-recording (#104): versioned, portable,
// desensitizable recording bundles for real chat tasks. Internal-edition
// capability under PD-070; nothing in the public composition roots may
// import this package until #102 wires the internal extension surface.

module.exports = {
  ...require('./manifest.cjs'),
  createRecorder: require('./recorder.cjs').createRecorder,
  ...require('./validate.cjs'),
  loadBundle: require('./loader.cjs').loadBundle,
  streamEvents: require('./loader.cjs').streamEvents,
  RecordingError: require('./loader.cjs').RecordingError,
  ...require('./redact.cjs'),
  exportDemoBundle: require('./demo-export.cjs').exportDemoBundle,
  markDemoReview: require('./demo-export.cjs').markDemoReview,
};
