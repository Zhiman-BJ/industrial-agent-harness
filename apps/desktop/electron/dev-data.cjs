const path = require('node:path');

// Development instances default to an Electron profile keyed only by the
// package name, so every checkout - and any stray non-selftest test run -
// shares one userData with its projects, model configuration and chat
// history. Scope development profiles to the checkout instead;
// INDUSTRIAL_DEV_USER_DATA points a checkout back at an explicit shared
// profile, and selftest launches keep their own temporary profiles.
function devUserDataDirectory(root, argv = process.argv, environment = process.env) {
  if (argv.some(flag => flag.endsWith('-selftest') || flag === '--packaged-smoke')) return null;
  if (environment.INDUSTRIAL_DEV_USER_DATA) return environment.INDUSTRIAL_DEV_USER_DATA;
  return path.join(root, '.user-data');
}

module.exports = { devUserDataDirectory };
