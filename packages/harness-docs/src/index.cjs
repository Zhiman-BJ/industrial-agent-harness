'use strict';

// @industrial-agent-harness/harness-docs (#103): the internal docs center's
// data core — versioned index over an explicitly allowed doc subset, a
// restricted provider that accepts manifest IDs only, CJK-friendly bounded
// search, and a pure navigation reducer. Internal-edition capability; the
// panel/IPC wiring belongs to the #102 internal extension surface.

module.exports = {
  LIMITS: require('./limits.cjs').LIMITS,
  ASSET_MEDIA_TYPES: require('./limits.cjs').ASSET_MEDIA_TYPES,
  extractReferences: require('./markdown-links.cjs').extractReferences,
  titleOf: require('./markdown-links.cjs').titleOf,
  buildDocsIndex: require('./index-builder.cjs').buildDocsIndex,
  writeDocsIndex: require('./index-builder.cjs').writeDocsIndex,
  resolveRelative: require('./index-builder.cjs').resolveRelative,
  SCHEMA_VERSION: require('./index-builder.cjs').SCHEMA_VERSION,
  MANIFEST_ID: require('./index-builder.cjs').MANIFEST_ID,
  createDocsProvider: require('./provider.cjs').createDocsProvider,
  DocsError: require('./provider.cjs').DocsError,
  createDocsNavigation: require('./navigation.cjs').createDocsNavigation,
};
