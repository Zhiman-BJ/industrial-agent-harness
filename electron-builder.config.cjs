const path = require('node:path');
const root = __dirname;
// Windows workspace discovery can return a Git Bash path that the collector
// cannot read. Keep its environment fallback aligned with the pnpm deployment.
process.env.npm_config_user_agent = require('./package.json').packageManager.replace('@', '/');
const updateUrl =
  process.env.HARNESS_CORE_UPDATE_URL || 'https://updates.invalid/industrial-agent-harness/beta';
const release = process.env.HARNESS_RELEASE_BUILD === '1';

module.exports = {
  appId: 'com.zhiman.industrial-agent-harness',
  productName: 'Industrial Agent Harness',
  directories: { output: path.join(root, 'dist', 'desktop-release') },
  files: [
    'dist/**/*',
    'electron/**/*.cjs',
    'node_modules/**/*',
    '!node_modules/@zhiman-bj/industrial-domain-packs/**/*',
    {
      from: 'domain-pack-release',
      to: 'node_modules/@zhiman-bj/industrial-domain-packs',
      filter: ['**/*'],
    },
    'package.json',
    'i18n.config.json',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'licenses/**/*',
  ],
  extraResources: [
    { from: 'pack-feed.json', to: 'pack-feed.json' },
    { from: 'bootstrap-packs', to: 'bootstrap-packs' },
  ],
  asar: true,
  asarUnpack: [
    'node_modules/@industrial-agent-harness/viewer-builtin/src/layout/*.py',
    'node_modules/@industrial-agent-harness/domain-mcp/src/gateway.py',
  ],
  forceCodeSigning: release,
  mac: {
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    category: 'public.app-category.developer-tools',
    icon: path.join(root, 'apps/desktop/public/app-icon.png'),
    hardenedRuntime: true,
    notarize: release,
  },
  win: { target: ['nsis'], icon: path.join(root, 'apps/desktop/public/app-icon.png') },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: path.join(root, 'apps/desktop/public/app-icon.ico'),
    uninstallerIcon: path.join(root, 'apps/desktop/public/app-icon.ico'),
    installerHeaderIcon: path.join(root, 'apps/desktop/public/app-icon.ico'),
  },
  publish: [{ provider: 'generic', url: updateUrl }],
};
