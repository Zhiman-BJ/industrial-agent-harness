// Electron resolves the default userData directory from the package.json
// name bundled into app.asar - the same name every development checkout
// uses - so packaged installs silently shared one profile with development
// instances on the same machine. Packaged apps claim the distinct product
// identity instead. Keep in sync with productName in electron-builder.config.cjs.
function packagedAppName() {
  return 'Industrial Agent Harness';
}

module.exports = { packagedAppName };
