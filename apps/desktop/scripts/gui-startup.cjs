const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const services = Object.freeze([
  'com.apple.coreservices.launchservicesd',
  'com.apple.windowserver.active',
]);

function interpretProbe(value) {
  if (
    !Array.isArray(value?.services) ||
    value.services.length !== services.length ||
    !services.every(
      (name, index) =>
        value.services[index]?.name === name && Number.isInteger(value.services[index]?.code),
    )
  )
    return { status: 'unknown', reason: 'invalid-probe-result' };
  const denied = value.services.filter(item => item.code === 1100);
  return {
    status: denied.length
      ? 'denied'
      : value.services.every(item => item.code === 0)
        ? 'available'
        : 'unknown',
    services: value.services,
    // A successful lookup does not guarantee AppKit/Electron startup.
    ...(denied.length ? { reason: 'bootstrap-not-privileged' } : {}),
  };
}

function probeGuiStartup({ platform = process.platform, run = execFileSync } = {}) {
  if (platform !== 'darwin') return { status: 'not-applicable' };
  let directory;
  let phase = 'prepare';
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'industrial-gui-probe-'));
    fs.chmodSync(directory, 0o700);
    const binary = path.join(directory, 'probe');
    phase = 'compile';
    run(
      '/usr/bin/xcrun',
      ['clang', path.join(__dirname, 'native/macos-gui-probe.c'), '-o', binary],
      { encoding: 'utf8', timeout: 15000, stdio: 'pipe', maxBuffer: 128 * 1024 },
    );
    phase = 'lookup';
    const text = run(binary, [], {
      encoding: 'utf8',
      timeout: 2500,
      stdio: 'pipe',
      maxBuffer: 16384,
    });
    phase = 'decode';
    return interpretProbe(JSON.parse(String(text)));
  } catch (error) {
    return {
      status: 'unknown',
      reason: error.code === 'ETIMEDOUT' ? 'probe-timeout' : 'probe-unavailable',
      phase,
      ...(error.code ? { code: String(error.code).slice(0, 80) } : {}),
      ...(Number.isInteger(error.status) ? { exitCode: error.status } : {}),
      ...(error.signal ? { signal: String(error.signal).slice(0, 32) } : {}),
    };
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}

function requireGuiStartup(options) {
  const result = probeGuiStartup(options);
  if (result.status === 'denied' || result.status === 'unknown') {
    const names = (result.services || [])
      .filter(item => item.code === 1100)
      .map(item => item.name)
      .join(', ');
    const diagnosis =
      result.status === 'denied'
        ? `This process cannot access macOS GUI services (${names}; bootstrap code 1100). `
        : `macOS GUI service access could not be verified (${[
            result.reason || 'unknown service result',
            result.phase,
            result.code,
            Number.isInteger(result.exitCode) ? `exit ${result.exitCode}` : null,
          ]
            .filter(Boolean)
            .join('; ')}). `;
    const error = Error(
      diagnosis +
        'Electron was not started, so this attempt did not cause a native startup crash.\n' +
        'Prepare the desktop entry with:\n' +
        '  pnpm --filter @industrial-agent-harness/desktop gui:prepare\n' +
        'For UI validation append: -- --ui-selftest\n' +
        'Open the generated .app from Finder or an authorized desktop application launcher. ' +
        'The launcher prints its log and result paths. System permissions are unchanged.',
    );
    error.code =
      result.status === 'denied' ? 'MACOS_GUI_SERVICE_DENIED' : 'MACOS_GUI_DIAGNOSTIC_UNKNOWN';
    error.diagnostic = result;
    throw error;
  }
  return result;
}

module.exports = { services, interpretProbe, probeGuiStartup, requireGuiStartup };
