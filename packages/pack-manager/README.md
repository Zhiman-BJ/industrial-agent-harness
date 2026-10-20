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
materials. PCB actor sources and Skills come from the pinned owner Pack; its host gateway
Python environment remains a separately prepared prerequisite.
Production catalogs require `HARNESS_PACK_SIGNING_KEY_FILE` and `HARNESS_PACK_SIGNING_KEY_ID`.

Desktop release publication keeps Pack signing independent of application code signing.
Both beta and stable feeds publish the authenticated `catalog.json` and its `.hpack` files
even for unsigned Core builds. `scripts/publish-desktop-feed.cjs` verifies the catalog,
channel and all archive sizes/hashes before publication, then uploads archives before
the catalog. Core binaries and OTA manifests are published only when both platform
installers report signed; unsigned releases preserve any previous signed Core feed.
Unsigned clients keep Core OTA disabled while consuming signed Pack updates normally.
This publication policy does not add platform qualifications or bypass Pack compatibility,
signature, integrity, runtime preparation or task lease checks. Regression coverage:
`node --test tests/ci/release-desktop.test.cjs` (GitHub uploads and HTTPS responses are
simulated; actual installer signing and public-feed recovery require release acceptance).

Core-owned optional `.hpack` files may also ship inside the application resources; their catalog is protected by the Core application signature, and installation verifies the pinned archive hash. This source is supplied only by the desktop main process, never a renderer or project path. Signed HTTPS catalogs remain the update source.

Optional `runtimeAssets` declarations prepare pinned macOS arm64 vendor applications in `<store>/.runtime-assets/`: streaming HTTPS download, exact size/SHA-256, read-only DMG mount or validated ZIP extraction, full app copy with upstream licenses, signature verification, bounded version probe, atomic activation and repair. Large applications remain separate from bounded `.hpack` archives. Interrupted staging is not ready; versions and the verified download cache are retained. Removing a Pack preserves this reusable runtime cache. Desktop and CLI use the same resolved dependency environment.

Optional `containerImages` declarations select released image IDs from the owner's unchanged
`provenance/runtime-distribution.json`, included in the authenticated `.hpack`. Desktop and CLI
install/update/repair call the same `PackManager.prepareRuntime` path before Pack activation.
The primary image channel is an anonymous HTTPS release tarball; a running Linux Docker engine
is an external prerequisite. Entries with no published release are not automatically selected.
When a Pack also declares native applications, Docker availability is checked before either
native or image downloads. Missing Docker and an unreachable engine produce distinct setup
messages in both adapters and leave the Pack inactive. The docker CLI is discovered through the
shared ladder in `@industrial-agent-harness/domain-runtime`: the PATH first, then well-known
installs (`~/.docker/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, the Docker.app bundle) and a
timeout-bounded login-shell PATH capture for GUI launches whose environment lacks them; the miss
message lists every searched location.
Installing images does not configure a project's execution profile or qualify an engineering task.

Qualification hosts that cannot run Docker (GitHub-hosted macOS runners) build their bundles with
`HARNESS_PACK_OMIT_CONTAINER_IMAGES=1` and `HARNESS_PACK_SIGNING_KEY_ID=qualification`: the bundle
keeps the owner lock verbatim but advertises no container images, so `prepareRuntime` prepares the
native applications only. The switch is refused for every other signing identity and therefore
never reaches production catalogs; container image preparation is qualified on Linux hosts.

Container preparation streams bytes to disk while checking the exact size and SHA-256. It reads
bounded OCI metadata without extracting layers, verifies the locked config digest and platform,
and derives the archived manifest digest. These identities differ from a registry index digest.
After `docker load`, it verifies the immutable manifest ID (containerd store) or config ID
(classic store), then creates and checks the locked repository tag. Untagged OCI exports work;
human-readable Docker output is not an identity source. Explicit registry, namespace, tag or
digest constraints must match the lock.

Container receipts in `<store>/.container-images/` record the verified identities. Readiness and
reuse also inspect the current Docker tag; a removed or replaced image needs preparation again.
Repair reads the integrity-checked installed lock, ignoring standalone discovery overrides.
Failure/cancellation removes temporary tar files and preserves the active Pack; successful
managed preparation also removes the tar. Pack removal keeps Docker images and receipts for
reuse. Download space is checked on the store filesystem; Docker manages its own storage and
may fail independently. Catalog estimates include container download bytes and a conservative
expanded-size estimate, not a measurement of Docker's available storage.

The standalone developer command is
`node scripts/acquire-container-image.cjs <owner-directory> <image> [--keep-archive]`.
Only this discovery API honors `INDUSTRIAL_HARNESS_RUNTIME_DISTRIBUTION`; explicit retention applies
only after success. Real release acceptance is separate from portable fixtures:
`node scripts/verify-release-image-installation.cjs <fresh-output> [domain]`, after building
the Desktop renderer. It exercises CLI cold installation, repair and removal, then the real
Desktop renderer/preload/IPC installation and repair with verified Docker images reused.
Reports distinguish installation/container startup from engineering acceptance.

Installation does not execute archive installer scripts. Registered runtime modules execute later as
trusted code, through shared runtime execution and verification boundaries. Broker disclosure
and archive signatures do not provide a generic sandbox for arbitrary third-party code.

See [Pack format](../../doc/domain-pack.md) and the [independent authoring tutorial](../../doc/pack-authoring.md).
The owned `examples/review-pack` demonstrates dynamic Skill-only installation without changing Core.
Validation: `node scripts/check-pack-release.cjs`.

Managed macOS runtime recipes support `macos-app-dmg` and `macos-app-zip`. `app` is the installed bundle name;
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
preparation reuses verified cache and checks the real destination filesystem with `statfs` before downloading
or copying. A failed check preserves existing active versions.

Preparation progress identifies `checking-space`, `downloading`, `verifying`, `mounting`, `extracting`,
`copying`, `checking`, `activating` and `ready`. Download events include measured `bytesPerSecond` and
`etaSeconds` when computable; non-download phases do not claim a percentage. Cancellation or failed checks
leave incomplete staging unactivated and release the preparation lock. Completed archives are retained for
retry and repair; partial downloads are removed. These contracts are covered by Pack Manager tests, including
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
