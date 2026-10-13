# Domain Pack Manager

Shared installation store for Desktop and CLI. It verifies Ed25519 signed HTTPS catalogs,
archive SHA-256, every file and required Skill/provider/runtime entry before atomically activating
a Domain version. A task lease prevents changing or removing a Domain while in use. Failed,
corrupt and unsupported updates preserve the previous active version.

New installs retain an integrity receipt; scanning checks the complete resource inventory,
content hashes and ordinary file boundaries, isolating damaged Domains. Older API 1 installs
without receipts remain readable and receive a receipt on reinstall. The local owner can edit
both the store and receipts; these checks detect damaged resources, not a malicious local owner.

`INDUSTRIAL_HARNESS_PACK_STORE` overrides `~/.industrial-agent-harness/packs`.
`scripts/build-pack-distribution.cjs` assembles unchanged resources from the pinned owner release into public distribution bundles, including license
materials. PCB's private source and complete Skill remain external; the public bridge records
fixed resource provenance and loads authorized local resources only when selected.
Production catalogs require `HARNESS_PACK_SIGNING_KEY_FILE` and `HARNESS_PACK_SIGNING_KEY_ID`.

Core-owned optional `.hpack` files may also ship inside the application resources; their catalog is protected by the Core application signature, and installation verifies the pinned archive hash. This source is supplied only by the desktop main process, never a renderer or project path. Signed HTTPS catalogs remain the update source.

`runtimeAssets` describe externally installed native dependencies and explicitly prepared container images. Harness downloads Domain Packs; native vendor applications and independent native runtimes are installed externally, then detected and associated. Docker itself is an external prerequisite. A qualified container profile can explicitly pull its pinned image after Docker CLI/daemon preflight; Pack installation never prepares dependencies implicitly.

Historical native receipts/cache under `<store>/.runtime-assets/` remain readable and integrity-checked. Low-level native archive installation/download helpers remain only for internal maintenance and regression fixtures; they are not Desktop/CLI product entry points. Removing a Pack preserves reusable cache and user software. Desktop and CLI use the same resolved dependency environment.

Installation does not execute archive installer scripts. Registered runtime modules execute later as
trusted code, through shared runtime execution and verification boundaries. Broker disclosure
and archive signatures do not provide a generic sandbox for arbitrary third-party code.

See [Pack format](../../doc/domain-pack.md) and the [independent authoring tutorial](../../doc/pack-authoring.md).
The owned `examples/review-pack` demonstrates dynamic Skill-only installation without changing Core.
Validation: `node scripts/check-pack-release.cjs`.

Historical managed macOS runtime recipes support `macos-app-dmg` and `macos-app-zip`. `app` is the installed bundle name;
optional `archiveApp` locates a nested bundle in the vendor archive. `environmentExecutables` maps additional
`INDUSTRIAL_HARNESS_*` variables to executable files inside that app. All mapped files are checked against
receipt hashes; one damaged file makes the runtime unavailable until repaired. Recipes remain owned by
Domain Packs. ZIP preparation validates central/local headers, paths, file types, expanded size and duplicates
before extraction; links in ZIP archives are rejected. DMG app links must resolve within the app. Both formats
retain upstream code-signature verification and a bounded isolated version probe before activation.

New recipes declare `installedSize` in bytes. `RuntimeAssetManager.estimate(assets)` and
`PackManager.estimate(entry)` return `downloadBytes`, `installedBytes`, `requiredBytes`, `availableBytes`,
`estimated` and `cacheReused`. The required space includes staging and a reserve; existing installations are
retained during replacement. Legacy recipes without installed sizes receive a conservative estimate marked
`estimated: true`. Display estimates conservatively include archives until their hashes have been verified;
internal maintenance reuses verified cache and checks the real destination filesystem with `statfs` before downloading
or copying. A failed check preserves existing active versions.

Container preparation and internal maintenance progress identify `checking-space`, `downloading`, `verifying`, `mounting`, `extracting`,
`copying`, `checking`, `activating` and `ready`. Download events include measured `bytesPerSecond` and
`etaSeconds` when computable; non-download phases do not claim a percentage. Cancellation or failed checks
leave incomplete staging unactivated and release the preparation lock. Completed archives are retained for
internal retry and repair. Historical runtime archive partials with a strong ETag are retained for safe retry; unsupported or changed validators restart from zero. These contracts are covered by Pack Manager tests, including
a real HTTPS transfer and, on macOS, native extraction of a small ZIP fixture. Synthetic vendor probes do not
establish engineering qualification or support for additional platforms.

Footprint-only metadata updates preserve existing runtime receipts. A changed execution recipe for the same
vendor archive receives a separate installation directory, so a cancelled Pack activation cannot invalidate
the runtime used by its active predecessor. Native cancellation waits for confirmed child exit before staging
cleanup; even a partially successful mount is detached, and a still-mounted source is never traversed for deletion.

Task leases and installation ownership are acquired under the same store lock. A task cannot start using a
domain being prepared or repaired by another process, and preparation cannot begin while that domain has a
live task lease. Unrelated installed domains remain usable. Failure to write a lock owner releases the file
and descriptor so installation can be retried after freeing disk space.

Managed runtime declarations also support `type: "docker-image"` on the qualified `darwin-arm64` host profile. Each declaration binds a registry `image` by manifest digest, its config `imageId`/`sha256`, `imagePlatform`, compressed/installed sizes and one `INDUSTRIAL_HARNESS_*` environment key. Installation checks the Docker daemon, pulls the immutable reference and verifies the repository digest, config and platform before atomically writing a receipt. Readiness rechecks Docker's local image metadata; missing or changed images yield an empty dependency environment value and require repair. Native and container assets can coexist in one Pack. Docker Desktop must be installed and running; the installer detects and reports this prerequisite. Removing a Pack retains reusable runtime images. Qualification currently covers macOS Apple Silicon only.

HTTPS assets can use public OCI blob endpoints. Anonymous Bearer challenges are resolved with a pull-scoped token and tokens are removed on cross-origin redirects; authenticated private registries remain outside this download path. Exact declared download hashes and sizes still apply.

## Runtime environments

Pack installation activates source and Skills without preparing software by default.
`install(..., { prepareRuntime: true })` is refused with `DEPENDENCY_INSTALLATION_EXTERNAL` before catalog access, transfer or storage mutation. Install the Pack separately; use explicit container profile preparation or externally install native dependencies.
Missing dependencies do not remove installed Packs or canonical project history.

`RuntimeEnvironmentManager({ manager, versionProbe? })` is the shared Desktop/CLI
API. It consumes signed `bundle.executionProfiles` and `runtimeAssets` declarations:

- `describe(domain, { projectDir? })` returns profiles, structured reasons, the
  effective binding, environment, `readyToolIds` and a configuration identity.
- `detect(domain, { profileId, paths?, signal?, onProgress? })` checks existing
  software and records the last result. It never downloads or associates it.
  `paths` maps declared asset IDs to absolute application directories, native runtime directories, or native executable files according to `selectionKind`. Discovery
  checks all declared candidates; multiple compatible installations require a
  selection. Version probes run in a temporary user profile, with applicable macOS application signature
  checks and bounded cancellation-aware process execution.
- `associate(domain, { profileId, projectDir?, paths?, signal? })` repeats detection
  and persists a binding only after success. Existing applications stay in place;
  the manager records their real executable paths/hashes and does not own them.
- `prepare(domain, { profileId, projectDir?, signal?, onProgress? })` explicitly
  accepts only a qualified container profile whose assets are all `docker-image`. It checks the existing Docker CLI/daemon before any installation lock or transfer, then pulls/verifies the image and selects the profile. Native/remote preparation returns `DEPENDENCY_INSTALLATION_EXTERNAL` without installing anything; a missing CLI/daemon returns `DOCKER_UNAVAILABLE`. Existing bindings remain intact on failure.
- `resolve(bundle, { projectDir? })` synchronously resolves readiness and the
  environment for a trusted installed bundle. `validate(bundle, options)` repeats
  external identity/version checks, with application signatures where applicable, before and after native actions.
- `clear(domain, { projectDir? })` removes only the selection; a project resumes
  inheriting the domain default. It deletes no user software, cache or history. A domain-wide clear records an
  explicit disabled selection, preventing legacy environment migration from reselecting it.

A profile must be qualified on the current platform. Owner-declared runtime-managed
remote connections expose executable tools after configuration; readiness remains unchecked
until the existing Runtime handshake verifies service identities and project binding.
`connectionView` returns safe fields; `configureConnection` requires an injected secure
connectionStore (read/write/available). Secrets never enter Pack state or public identities.
Other remote profiles retain the existing RemoteSettings coordinator path. No detection or association uploads project files or falls
back to another backend. Unsupported declarations never create ready tools.

Project execution leases exclude binding changes, installation and preparation.
Abandoned preparation leases are reclaimed after their process exits. Managed
variables override ordinary process environment values. The shared project Runtime
filters tools and capabilities, includes the environment identity in its source
state, and invalidates configuration when the binding or executable changes.
Development registries and older bundles retain their compatibility behavior.

Tests: `node --test packages/pack-manager/src/*.test.cjs`. The real existing-app
Godot path is exercised separately on macOS Apple Silicon with
`node --test tests/integration/godot-native.test.cjs`.

Secure store read errors isolate only the affected remote profile with
`CONNECTION_STORAGE_UNAVAILABLE`; they never fall back to process credentials.
`resetConnection(domain, { profileId })` explicitly removes ciphertext through
the adapter `remove(key)` without decrypting it. `configureConnection` supports
`replace: true` for complete replacement of a damaged record. Saving connection
settings does not select a profile; association is separate. Only legacy process
environment configuration is eligible for implicit migration.

## Native tools and isolated runtimes

`native-executable` declares an existing CLI dependency: an absolute file is selected or discovered only at owner-declared locations. No project-directory or automatic PATH search occurs. A symlink selection binds both the selected path and resolved ordinary executable/hash; retargeting invalidates readiness. This asset has no managed download and returns actionable external installation guidance.

`native-runtime-zip` describes an externally prepared isolated root `directory`, relative `executable`, exact archive `url`/`sha256`/`size`/`installedSize`, and optional `environmentExecutables`. The currently accepted platform is `darwin-arm64`. Both native types require fixed `probeId: "version" | "version-short"` (`--version`/`-V`) and `versionText`; arbitrary probe arguments are rejected. App recipes retain their existing signature checks. External native runtime associations bind a receipt covering the entire immutable tree, including libraries/data and modes. Links/special files and escaping paths are rejected; retained internal ZIP inspection also validates archive boundaries. Temporary probe homes/caches remain outside that root. No artificial `.app` wrapper or Docker daemon is required.

`describe` exposes asset `type`, `selectionKind: "file" | "directory" | "application"` and `manageable`, which is true only for container images. Mixed native profiles associate each externally prepared directory/file. Failed preparation requests preserve the previous binding and never create a ready selection. Detection recognizes valid historical managed receipts while explicit user paths take precedence. Existing Docker images can also be associated without an installation receipt or pull, after matching repository manifest digest, config identity and platform; changed identities clear readiness and dependency environment values.

Retained internal runtime archive downloads keep a 60-second inactivity limit and use a size-derived total budget at 64 KiB/s plus five minutes, with a 30-minute floor and 24-hour cap. The generic transfer default is six hours. Retry uses a persistent partial only with a strong ETag, exact declared identity and matching final HTTPS URL; Range/If-Range responses must have exact bounds and the same ETag. A server returning 200 restarts safely. Complete size/SHA-256 verification precedes atomic publication and extraction. Cancelled partials remain reusable; malformed ranges, replaced identities and hash failures cannot activate software. Preparation space checks subtract validated retained bytes. Rate/ETA measure newly transferred bytes.

The shared package suite passed 71 tests under the final policy, including native preparation refusal, early legacy-flag refusal, externally prepared directory/CLI association, existing-image identity checks and Docker-unavailable preflight. Installed canonical DXF passed external association, create/inspect, incorrect verification, native failure, cancellation/reopen, full-tree tamper rejection and external repair (about 43 seconds). Installed physical PCB passed ERC, DRC with zero errors, truthful overall UNKNOWN, cancellation and reopen recovery (about 25 seconds); all 88 design tools also passed fixture dispatch. Those are separate evidence classes. Final Desktop assertion totals belong in the current QA report. Historical KiCad cold-download/resume checks cover a retired product path and do not block acceptance of external native installation.
