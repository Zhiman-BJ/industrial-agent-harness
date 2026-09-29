const fs = require('node:fs');
const path = require('node:path');

// App-level (global) settings, separate from per-project bindings and the model profile.
function settingsFile(directory) {return path.join(directory, 'harness-settings.json');}

function readSettings(directory) {
  try {
    const value = JSON.parse(fs.readFileSync(settingsFile(directory), 'utf8'));
    return {guiPluginEnabled: Boolean(value.guiPluginEnabled)};
  } catch {
    return {guiPluginEnabled: false};
  }
}

function saveSettings(directory, settings) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  const file = settingsFile(directory);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2), {mode: 0o600});
  fs.chmodSync(file, 0o600);
  return settings;
}

module.exports = {readSettings, saveSettings};
