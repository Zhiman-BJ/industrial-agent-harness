# Runtime distribution v2

Status: implemented and locally exercised on macOS ARM64, authorized 2026-10-12. [PD-072](product-decisions.md#pd-072pack-与软件分离及能力-profile-选择)
supersedes PD-071's mandatory dependency preparation. Actual evidence and open
checks are recorded in [v2 QA](qa-runtime-distribution-v2-20261012.md). IH-ARCH-001,
Kimi, canonical engineering records, existing tool semantics and Verifiers remain
unchanged. This is not a new signed public release or a new Mac CI runner.

## Installed product behavior

Installing a Domain Pack installs trusted capabilities, Skills and adapters.
It does not implicitly install vendor applications, pull containers or deploy
remote services. Missing software does not prevent Pack installation, project
browsing or historical-result reading. The capability center manages environments;
project details may override the global profile. Detection, association, explicit
container preparation and clearing a binding are separate operations. Clearing a
binding does not delete user applications. No automatic remote fallback or upload
is introduced.

| Domain/profile                    | Execution dependency and scope                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Godot structural native           | Compatible Godot 4.7.2 application on macOS ARM64; externally install and associate an existing app                                                                     |
| CAD native FreeCAD                | Externally installed compatible FreeCAD 1.1.4 application on macOS ARM64; Docker is unnecessary for this profile                                                        |
| CAD DXF native runtime            | Externally prepared isolated macOS ARM64 DXF runtime; no Docker, FreeCAD or AutoCAD required for its declared bounded operations                                        |
| CAD DXF container                 | Explicitly prepared pinned ezdxf runtime and running Docker; bounded DXF operations                                                                                     |
| PCB bounded native                | Externally installed compatible KiCad 10.0.6 on macOS ARM64; only the existing `pcb.kicad.*` operations                                                                 |
| PCB design container              | Explicitly prepared pinned design gateway and Docker; existing design-tool subset                                                                                       |
| Chip managed container            | Qualified managed RTL/assertions/VCD and synthesis on macOS ARM64/Linux x64 with Docker; physical flows retain separate technology-input and qualification requirements |
| Chip native detection declaration | Unqualified, with no executable tool IDs; installed software does not enable it                                                                                         |

The current product offers Chip, PCB, Godot and CAD. Owner metadata declares
`withdrawnDomains: ["cuda"]`; fresh and legacy installed CUDA entries are suppressed
without excluding third-party domains. Standalone CUDA sources and historical
service contracts remain outside this product catalog.

Cards have clear borders, a one-line purpose and collapsed requirements. Status
names actual missing dependencies: green ready, yellow missing, red failed check,
neutral unchecked. A latest failed check overrides saved Ready in the display;
the saved association remains available for recovery. Docker is required only for
Chip, PCB design and CAD DXF container execution, not Pack installation or native
Godot, FreeCAD and bounded KiCad checks.

## Maintained declarations and generated artifacts

Owner commit `1eae41d583bc526c36ae8a8f6c08343504949928` (Domain Packs 0.7.0)
maintains `executionProfiles`: `id`, `label`, `kind`, client `platforms`, `qualified`,
canonical `toolIds`, `assetIds` and optional `description`. Asset IDs bind existing
`runtimeAssets`. Native assets add bounded application/directory/file `discoveryPaths` and official
manual `installUrl`; existing executable/version/archive identities remain intact.
The existing manifests and content lock remain the authoritative source. Owner
component packaging reads committed Git objects and emits source, Skill and bridge
archives plus release indexes. Complete vendor applications and image layers are
external runtime assets; image recipes remain source. Upstream PCB actor bytes,
provenance and legacy entry compatibility remain intact. The shared source catalog
requires its declared source closure; independently distributable components do
not imply independently executable domains.

The separate Go platform index binds exact source hashes and platform binary
hashes/sizes. Host publication consumes a trusted committed owner build, copies the
matching binary into the signed hpack and declares
`platformProbe: {schemaVersion:1, platform, file, sha256, sizeBytes}`. The installed
backend validates the bounded path, platform, regular-file identity and digest
before calling `owner.createVersionProbe({binary, sha256})`. Pack users do not need
Go or a build toolchain. Source-only development fallback must be explicit;
production components must not silently fall back when their declared probe fails.

## Shared APIs and execution boundary

`RuntimeEnvironmentManager({manager: PackManager})` is shared by CLI and Desktop:

- `describe(domain, {projectDir?})`: selected binding, profiles and actionable reasons.
- `detect(domain, {profileId, paths?, signal, onProgress?})`: inspect without installing or associating.
- `associate(domain, {profileId, projectDir?, paths?, signal})`: validate and persist a selection.
- `prepare(domain, {profileId, projectDir?, signal, onProgress?})`: explicitly prepare only a qualified container profile with all assets `docker-image`, after existing Docker CLI/daemon preflight. Native/independent runtime preparation is refused with `DEPENDENCY_INSTALLATION_EXTERNAL`; Pack install's legacy `prepareRuntime: true` flag is refused before transfer.
- `clear(domain, {projectDir?})`: remove the selection without deleting user software.
- `resolve` / `validate`: supply the integrating Runtime's effective environment, tool subset and configuration identity.

Dependencies must pass executable mapping, identity, version and applicable
application signature checks. Changed executable targets or native runtime trees invalidate association. The Go component
executes fixed owner-declared application probes and generic `version`/`version-short` probes, with
bounded output, timeout and cancellation; it is not an MCP server or a migration
of all domain tools. Existing Python/GDScript/native implementations remain.

The task path passes the real project directory into registry/profile resolution.
Capability disclosure and Runtime tools use the selected profile's eligible tool
subset; Broker scope, approval and canonical facts remain enforced. Runtime
instances bind environment identity, which enters input hashes. Leases prevent
changing an environment during active actions. Cancellation and post-execution
validation must preserve returned native artifacts and cleanup diagnostics while
preventing stale evidence from becoming accepted. Existing managed receipts remain
compatible where their verified software identity is unchanged.

## Acceptance status

Owner source, component round-trip/identity, fixed probe cancellation/timeout and
real installed Godot version tests passed. The shared Host canonical Runtime also
passed the existing-app Godot association and explicit 12-frame structural check.
These are bounded native results, not general gameplay or all-domain qualification.

The earlier v2 QA record covers GUI IPC tests, the then-current five-domain bootstrap catalog and packaged app installation,
remote secure configuration/controlled authenticated HTTP execution, and Host regression
gates. Those results are historical evidence for their recorded source, not the
current four-domain catalog and card/status changes. The QA record distinguishes fixture services from native software and
historical domain qualification. The follow-up [REA plan review](dependency-plan-review-20261012.md)
describes automatic inspection, immutable plans and capability Doctor work not yet implemented. No new cold-download, signed/notarized DMG,
public Gatekeeper, Core OTA or new CI runner result is claimed.

Current four-domain installation UI and withdrawal follow-up: [2026-10-12 UI QA](qa-domain-install-ui-20261012.md).

## Final dependency boundary (2026-10-12)

[PD-075](product-decisions.md#pd-075原生软件外部安装与显式容器准备) supersedes the native managed preparation part of PD-074. Harness downloads Domain Packs and explicitly prepares selected container images when the user has installed and started Docker. Native vendor apps, CLI dependencies and independent native runtimes are externally prepared, then detected/associated. Desktop and CLI offer no native download/install action. Pack installation never implicitly prepares native or container dependencies. Missing Docker CLI/daemon is reported before locks, storage mutation or image transfer.

The shared native layer distinguishes application, directory and executable-file selection. App signature checks remain applicable to apps; external native directory receipts bind the entire immutable tree, including libraries/data/modes, and CLI receipts bind selected/resolved file paths and hashes. Fixed probes use temporary homes outside the immutable root. No project cwd/arbitrary PATH search or artificial `.app` wrapper is introduced. Mixed native profiles associate externally prepared directory/file dependencies. Historical valid runtime receipts/cache remain discoverable; internal native archive helpers remain for maintenance/tests, not product preparation. Existing Docker images can also be detected/associated without a managed receipt or pull, with exact manifest/config/platform checks. Chip native and full PCB design native remain unimplemented/unqualified.

Native DXF runtime 1.0.1 remains published as an external installation artifact: 30,141,461 bytes, SHA-256 `10ff2481aea0661f6315c803bd14407634f240f77fdcadf80bf1cc709cf07318`. The actual Host installed canonical path passed external association, create/inspect, incorrect verification, native failure, cancellation/reopen, full-tree tamper rejection and external repair in about 43 seconds, with Docker calls forbidden. Actual installed PCB design passed physical board creation, ERC, DRC with zero errors, truthful overall UNKNOWN, cancellation and reopen in about 25 seconds. The separate 88-tool fixture dispatch and PCB/Godot installed-layout regressions test packaging/dispatch, not engineering acceptance. Project-owned backend session scopes now await live/in-flight session cleanup before reopening, preventing stale workspace locks; process failures retain bounded exit/stderr diagnostics.

The retained internal downloader fixes the historical fixed 1,200-second timeout and partial deletion with bounded inactivity, size-derived total budgets, strong-ETag Range/If-Range retry and complete size/SHA verification. Bounded Harbor checks confirmed exact byte ranges; a real historical KiCad attempt retained 16,780,909 bytes and resumed. Native cold downloading is now a retired product path, not a current acceptance requirement or blocker. Preserve its original failures/results as historical evidence rather than implying that Harness still offers it.

Final shared Pack Manager regression: 71 tests passed, including native refusal, Docker-unavailable preflight without transfer, explicit container preparation, externally prepared native association and existing-image identity invalidation. Desktop final assertion counts and exact source/build identities belong in the current QA report. These source and installed task results do not establish a newly signed/notarized public installer, broader platform qualification, Chip native or full PCB native support.
