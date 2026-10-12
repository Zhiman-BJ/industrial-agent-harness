#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { copyReleaseNotices } = require('./release-notices.cjs');
const {
  capabilities,
  listDomains,
  listSkills,
  domainPacks,
} = require('../packages/domain-skills/src/index.cjs');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
let output, domain;
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === '--domain') {
    if (domain || !argv[index + 1]) throw Error('Provide --domain once.');
    domain = argv[++index];
  } else if (!output && !argv[index].startsWith('--')) output = argv[index];
  else throw Error(`Unknown packaging argument: ${argv[index]}`);
}
if (domain && !listDomains(capabilities).some(item => item.id === domain))
  throw Error('Unknown package domain.');
const target = path.resolve(
  output || path.join(root, 'dist', domain ? `headless-${domain}` : 'headless'),
);
if (
  target === root ||
  target.startsWith(path.join(root, 'packages') + path.sep) ||
  target.startsWith(path.join(root, 'apps') + path.sep)
)
  throw Error('Invalid headless output directory.');
if (fs.existsSync(target)) throw Error(`Output already exists: ${target}`);
fs.mkdirSync(path.dirname(target), { recursive: true });
const deployArgs = [
  '--filter',
  '@industrial-agent-harness/cli',
  'deploy',
  '--legacy',
  '--prod',
  target,
];
// Windows cannot execute a pnpm.cmd shim through spawnSync without a shell.
// Reuse pnpm's JS entry point to preserve each argument verbatim (including paths with spaces).
const pnpmEntry = process.env.npm_execpath;
if (process.platform === 'win32' && !pnpmEntry) {
  throw Error('On Windows, package through pnpm run package:headless.');
}
const result = pnpmEntry
  ? spawnSync(process.execPath, [pnpmEntry, ...deployArgs], { cwd: root, stdio: 'inherit' })
  : spawnSync('pnpm', deployArgs, { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
copyReleaseNotices(target);
// pnpm legacy deploy can leave its root package linked to the source checkout.
// Resolve that package inside the portable bundle instead.
const selfLink = path.join(
  target,
  'node_modules',
  '.pnpm',
  'node_modules',
  '@industrial-agent-harness',
  'cli',
);
if (fs.lstatSync(selfLink, { throwIfNoEntry: false })?.isSymbolicLink()) {
  fs.unlinkSync(selfLink);
  fs.symlinkSync(path.relative(path.dirname(selfLink), target), selfLink, 'dir');
}
const entry = path.join(target, 'src', 'main.cjs');
const agent = path.join(
  target,
  'node_modules',
  '@industrial-agent-harness',
  'agent-kimi',
  'src',
  'index.cjs',
);
const deployedRequire = createRequire(fs.realpathSync(agent));
const skillsRoot = path.dirname(
  path.dirname(deployedRequire.resolve('@industrial-agent-harness/domain-skills')),
);
const mcp = deployedRequire.resolve('@industrial-agent-harness/domain-mcp');
const runtime = deployedRequire.resolve('@industrial-agent-harness/domain-runtime');
const contracts = createRequire(runtime).resolve('@industrial-agent-harness/contracts');
const kimiEntry = deployedRequire.resolve('@moonshot-ai/kimi-code/dist/main.mjs');
for (const file of [entry, mcp, runtime, contracts, kimiEntry])
  if (!fs.existsSync(file)) throw Error(`Incomplete headless package: ${file}`);

if (domain) {
  fs.writeFileSync(
    path.join(skillsRoot, 'distribution.json'),
    JSON.stringify({ schemaVersion: 1, domain }, null, 2) + '\n',
  );
}
for (const pack of domainPacks.filter(pack => !domain || pack.domain === domain)) {
  const source = require('../packages/domain-skills/src/installed.cjs').builtInPackDirectory(
    pack.provider,
  );
  fs.cpSync(source, path.join(target, 'domain-packs', pack.provider.packDirectory), {
    recursive: true,
    filter: file =>
      !['.venv', '.venv-kimi', '__pycache__', '.DS_Store', '.ruff_cache', '.pytest_cache'].includes(
        path.basename(file),
      ) && !file.endsWith('.pyc'),
  });
}
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
fs.writeFileSync(
  path.join(target, 'HARNESS-PACKAGE.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      domain: domain || null,
      agentRuntime: {
        package: '@moonshot-ai/kimi-code',
        version: '2.1.1',
        transport: 'server-api-v1',
      },
      builtAt: new Date().toISOString(),
      sourceCommit: revision.status === 0 ? revision.stdout.trim() : null,
      sourceDirty: dirty.status === 0 ? Boolean(dirty.stdout.trim()) : null,
      packRelease: require('../packages/domain-skills/src/index.cjs').packReleaseIdentity,
      providers: domainPacks
        .filter(pack => !domain || pack.domain === domain)
        .map(pack => ({ id: pack.provider.id, version: pack.version })),
    },
    null,
    2,
  ) + '\n',
);
fs.writeFileSync(
  path.join(target, 'industrial-harness.cjs'),
  '#!/usr/bin/env node\nvoid require("./src/main.cjs").main();\n',
  { mode: 0o755 },
);
const binding =
  (domain
    ? `Bound domain: ${domain}. --domain is optional; other domains are rejected.\n`
    : 'Multi-domain package: --domain is required.\n') +
  '\nExternal MCP services (stdio / Streamable HTTP / SSE):\n  node industrial-harness.cjs mcp add --file /absolute/path/mcp.json\n  node industrial-harness.cjs mcp list\n  node industrial-harness.cjs mcp refresh external.NAME\n  node industrial-harness.cjs mcp remove external.NAME\nRegistrations and enable/disable policy are shared with Desktop and other domain packages. Services must be installed separately. Host services may control apps outside project roots; all actual external calls use host Runtime approval and persist Action/response evidence. Screenshots require a vision model and run --image-input. Results are unverified observations.\n';
const setup =
  domainPacks
    .filter(pack => !domain || pack.domain === domain)
    .map(
      pack =>
        `\n${pack.provider.title} source resources and Skills are included. Follow domain-packs/${pack.provider.packDirectory}/README.md for its supported profile and engineering prerequisites. For managed execution, install the signed Domain release with \"node industrial-harness.cjs domains install ${pack.domain} --catalog HTTPS_URL --keys-file FILE --store DIR\"; installation prepares its pinned runtime assets from Harbor automatically. Use INDUSTRIAL_HARNESS_PACK_STORE=DIR for subsequent run commands, and \"domains repair ${pack.domain} --store DIR\" to recheck installed assets. Docker-backed tools require Docker to be running. Remote services and project-owned technology/PDK inputs require their declared administrator/project setup. Scope-only discovery does not establish native readiness or engineering acceptance.\n`,
    )
    .join('') ||
  '\nThis domain has no registered industrial MCP provider yet. Scope/Skill and general Kimi tests are supported; do not infer engineering execution readiness.\n';
fs.writeFileSync(
  path.join(target, 'HEADLESS-README.txt'),
  `Industrial Agent Harness CLI test package\n\n${binding}\nUse Node.js 24 or newer:\n  node industrial-harness.cjs run --project-dir DIR ${domain ? '' : '--domain DOMAIN '}--task TEXT --scope-only\n  node industrial-harness.cjs run --project-dir DIR ${domain ? '' : '--domain DOMAIN '}--task TEXT\n\nKimi Code 2.1.1 is included in this package. Agent execution needs model API credentials; no separate Python Kimi CLI is required. A KIMI_EXECUTABLE override must be version 2.1.1.\n\nSet KIMI_API_KEY for the default Kimi provider; other providers use their declared key environment. Do not place keys in task text or command-line arguments.\n\nProtected agent execution requires macOS Seatbelt or Linux x86-64 bubblewrap/seccomp with enabled unprivileged user namespaces. Windows agent execution and the separate host GUI plugin remain unavailable. Registered external MCP runs through the audited host Runtime. Every domain also has shared project initialization, guarded file edits and declared local/Docker tasks. The registered RTL runtime emits persisted action and verification facts; read result.engineering separately from the agent turn status.\n\nThis package includes the shared Broker, domain Skill and MCP declarations, Kimi Code Server API integration, chat persistence and observed-context SQLite store; no Electron or Viewer UI. HARNESS-PACKAGE.json records source identity and whether this is a local uncommitted test build.\n${setup}`,
);
process.stdout.write(`${target}\n`);
