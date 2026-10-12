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
managed preparation and clearing a binding are separate operations. Clearing a
binding does not delete user applications. No automatic remote fallback or upload
is introduced.

| Domain/profile                    | Execution dependency and scope                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Godot structural native           | Compatible Godot 4.7.2 application on macOS ARM64; associate an existing app or explicitly prepare its managed download                                                 |
| CAD native FreeCAD                | Compatible FreeCAD 1.1.4 application on macOS ARM64; Docker is unnecessary for this profile                                                                             |
| CAD DXF container                 | Explicitly prepared pinned ezdxf runtime and running Docker; bounded DXF operations                                                                                     |
| PCB bounded native                | Compatible KiCad 10.0.6 on macOS ARM64; only the existing `pcb.kicad.*` operations                                                                                      |
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

Owner commit `2036b599318267b7a28775ff614915da21ad6fcf` (Domain Packs 0.7.0)
maintains `executionProfiles`: `id`, `label`, `kind`, client `platforms`, `qualified`,
canonical `toolIds`, `assetIds` and optional `description`. Asset IDs bind existing
`runtimeAssets`. Native assets add application-root `discoveryPaths` and official
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
- `prepare(domain, {profileId, projectDir?, signal, onProgress?})`: explicitly prepare only that profile's managed dependencies.
- `clear(domain, {projectDir?})`: remove the selection without deleting user software.
- `resolve` / `validate`: supply the integrating Runtime's effective environment, tool subset and configuration identity.

Applications must pass executable mapping, identity, version and applicable
signature checks. Changed executables invalidate association. The Go component
executes only fixed owner-declared version probes for Godot/KiCad/FreeCAD, with
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
