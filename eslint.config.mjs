// Static-analysis baseline. Errors gate CI (`pnpm lint` in structure.yml);
// warnings are visible but do not gate. Prettier owns formatting, so this
// config carries code-quality rules only, plus two type-aware async-safety
// rules for the TS sources covered by apps/desktop/tsconfig.json and
// packages/viewer-builtin/tsconfig.json.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/.venv*/',
      'releases/',
      'examples/',
      'apps/desktop/public/',
      'apps/desktop/branding/',
      'packages/viewer-builtin/fixtures/',
      // Frozen compatibility snapshots, vendored runtime resources and
      // third-party sources: never lint code we must not modify.
      'packages/domain-skills/packs/',
      'packages/domain-skills/skills/',
      'packages/viewer-builtin/src/cad/occt/',
      'packages/viewer-builtin/src/kicad/vendor/',
      'packages/viewer-builtin/src/waveform/surfer/',
    ],
  },
  js.configs.recommended,
  {
    // Baseline policy: flood-class findings stay visible without gating
    // merge; burn them down opportunistically. Correctness rules (duplicate
    // keys, control-flow traps, unsafe finally) remain errors.
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
    },
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': 'warn',
    },
  },
  // Viewer-builtin CommonJS modules execute inside the Electron renderer:
  // they legitimately see both Node and browser globals.
  {
    files: ['packages/viewer-builtin/src/**/*.{js,cjs}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  // Scope the TS rule sets to TS sources only: this workspace's application
  // code is CommonJS (.cjs) by design, and no-require-imports would fire on
  // every file.
  ...tseslint.configs.recommended.map(config => ({ ...config, files: ['**/*.{ts,tsx}'] })),
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: { ...globals.browser },
    },
    rules: {
      // TypeScript itself reports undefined names; the JS rule misfires on
      // types and browser/DOM ambient declarations.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
  {
    // Type-aware rules for the sources included by apps/desktop/tsconfig.json
    // and packages/viewer-builtin/tsconfig.json.
    files: [
      'apps/desktop/src/**/*.{ts,tsx}',
      'apps/desktop/vite.config.ts',
      'packages/viewer-builtin/src/**/*.{ts,tsx}',
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
    },
  },
  {
    // The nested detach/recovery finally chain predates the lint baseline;
    // reshaping it changes mount-recovery behavior and needs its own tested
    // change, not a drive-by lint fix.
    files: ['packages/pack-manager/src/runtime-assets.cjs'],
    rules: {
      'no-unsafe-finally': 'off',
    },
  },
  {
    // Governance-hash-protected file; the control-character class is a
    // deliberate unsafe-path rejection.
    files: ['scripts/fetch-architecture-candidate.cjs'],
    rules: {
      'no-control-regex': 'off',
    },
  },
);
