# Installation experience

The current source also prepares released container images through the shared Desktop/CLI
installer. The immutable owner's lock travels inside the authenticated Pack; anonymous release
tarballs are streamed, verified and loaded into an external Linux Docker engine before Pack
activation. Repair and readiness check the installed lock and live Docker identity. See
[container installation](container-image-installation.md) for the contract and separate real-release
acceptance. The historical native candidate results below retain their original identities.

The 1.0.1-beta.1 local desktop candidate addresses issue #60 on macOS Apple Silicon. It consumes Domain Packs 0.5.1 at immutable commit `09c39193e199de61941882f0e92f10ed7789dbd2`; the lockfile binds the archive integrity. Domain dependencies remain maintained by the Pack owner. The Core contains the generic installer, catalog, readiness descriptions and a small durable installation status record shared by CLI and Desktop.

## User flow

1. Copy the application from the DMG and open it. The list shows all five declared domains. Choose one or more optional domains: Chip, PCB, Godot and CAD are available from bundled Pack archives, even without an online directory. CUDA remains visible with its actual remote-service prerequisites and unavailable desktop-package status; it is not silently hidden or claimed ready.
2. Review the download and disk-space estimate. CAD prepares FreeCAD 1.1.4; PCB prepares KiCad 10.0.6 and its included Python; Godot prepares 4.7.2. Applications live in the user Pack store and do not replace applications the user installed elsewhere. Chip retains explicit Python, compiler and EDA/PDK prerequisites. CUDA remains a configured remote developer integration without a qualified desktop bundle.
3. Preparation reports disk checking, downloading, archive verification, opening/extraction, copying, version/signature checks and activation. Download speed and remaining time appear only when measurable. The installer checks actual free space before writes and reuses archives only after validating their full hash.
4. Completion shows each domain's actual readiness and links to existing model setup and project creation. A Pack may be installed while its external tools still need setup. A model connection is a separate prerequisite. Native tool readiness is not an engineering Verification.
5. Use the capability center to add, update or repair domains. First-run cancellation/close waits for cleanup. A status receipt reports completed, cancelled, failed or interrupted preparation after reopening. Completed domains remain installed if a later selected domain fails. Removal shares the cross-process installation lock. Preparation started in another process stays observable through polling; its cancellation is controlled by that process. Existing project domain bindings do not change.

The catalog explicitly distinguishes unconfigured, unchecked, connected and unavailable states. An unavailable remote catalog retains compatible bundled choices; it never produces a claim that every possible domain is installed. Only authenticated remote entries or Core-owned bundled entries can be installed. Normal checks cannot downgrade installed versions. Both adapters use the same catalog and installed-readiness descriptions; the CLI additionally exposes runtime receipts in `domains list`.

## Qualification commands

```sh
pnpm install --frozen-lockfile
pnpm test:architecture
node scripts/ci-tests.cjs portable
node apps/desktop/scripts/test-install-experience.cjs
pnpm --filter @industrial-agent-harness/desktop build
node scripts/stage-desktop.cjs dist/desktop-stage-local
apps/desktop/node_modules/.bin/electron-builder --projectDir dist/desktop-stage-local --config "$PWD/electron-builder.config.cjs" --mac dmg --arm64 --publish never
node scripts/smoke-packaged-desktop.cjs
node scripts/smoke-packaged-desktop.cjs --domains
node scripts/smoke-packaged-cad.cjs dist/ci-reports/cad-install --dmg
```

For an actual old-to-new application replacement, supply an existing 1.0.0 application and the exact new DMG. The gate creates an isolated profile and Pack store, prepares real CAD history in the old application, replaces the application at the same path, upgrades the bundled CAD Pack, and compares persisted files and logical SQLite records:

```sh
node scripts/smoke-install-upgrade.cjs \
  --old-app "/path/to/1.0.0/Industrial Agent Harness.app" \
  --new-dmg "dist/desktop-release/Industrial Agent Harness-1.0.1-beta.1-arm64.dmg" \
  --evidence dist/ci-reports/install-upgrade \
  --archive /path/to/FreeCAD_1.1.4-macOS-arm64-py311.dmg
```

`--prepare` and `--upgrade` run those stages separately. `--capture-existing` can inspect and preserve a completed old-app engineering baseline after a later legacy selftest failure; it does not turn that failure into a full acceptance pass. `--recheck-final` replaces a previously upgraded application with a final candidate and checks restart/data preservation. It retains the original migration identity and does not claim a second Pack upgrade. Adding `--update-pack` explicitly tests the subsequent CAD `.6` → `.7` transition in separate reports without replacing the original migration/restart evidence.

The installation UI test uses a signed local fixture feed, real IPC/Pack installation and a tiny locally signed app to exercise states, cancellation, retry and repair. It is transport and UI evidence, not domain qualification. The packaged domain smoke prepares the actual owner-declared native tools on macOS. For released container Packs, a runner without a Linux Docker engine must demonstrate a visible installation failure, a failed journal and no Pack activation or temporary tar; the report lists these prerequisite failures separately. It does not count registration alone as a successful image installation. The existing installed PCB/Godot tests require independent production CLI/Desktop payloads, real native reports and independent verification; they do not fall back to development sources. CAD's DMG gate verifies real build/edit, independent geometry checks, viewer, repair and restart.

Optional `HARNESS_RUNTIME_ARCHIVES` maps runtime asset IDs to exact official archives for qualification. The helper only populates the archive cache; production hash, archive, signature and version checks still execute. No runtime path or receipt override is used. Cached tests do not establish network download throughput.

CAD qualification can additionally set `HARNESS_CAD_INSTALL_RUNTIME_CACHE` to a previously production-verified runtime asset store. The selftest creates an independent copy in its empty isolated store, validates ordinary production readiness and asserts no Pack is preinstalled. Installation UI, both native tasks, Viewer, executable corruption, real repair and restart remain required. The report labels this `warm-runtime-reuse`; it is not a second cold native installation. Repair diagnostics retain recent UI state and window lifecycle events on failure.

## Source reconciliation recorded on 2026-10-10

That source revision merged the main-branch model/project synchronization and capability resource refresh, while retaining the installation flows and navigation alignment above. It pinned Domain Packs 0.5.2 at `b9759342cace66df0be0c4559b7c24fb28ea07d9` (Godot `0.2.2`, CAD `1.1.4-pack.7`). This reconciliation preserved the complete Godot Runtime validation from main together with the owner-maintained native preparation declarations. The current tarball installer consumes the later immutable owner commit recorded in the root README.

The source and CI reconciliation is distinct from the already qualified local DMG below. Its owner 0.5.1 identity, source commit, hashes and acceptance results remain historical facts. The new source requires its own CI result and any applicable native acceptance; those results are recorded separately when complete. No new installer qualification follows merely from updating the pin.

The reconciliation also separates fresh managed installation tests into a required `native-installed` job on each supported macOS runner. Native task deadlines and engineering assertions are unchanged. The internal Kimi MCP callback now uses a finite communication watchdog compatible with the existing one-hour generic task contract; the upstream default 60-second request timeout previously cancelled otherwise permitted host execution. A real 65-second Runtime task verifies the transport fix, while short execution deadlines and explicit cancellation still fail and clean up owned processes. Runtime archive caching still validates and copies official archives into each independent store; no installed app is substituted for preparation.


## Integrated delivery

Source `7fc7c445263fdc6efd03b6c9293b1fcf0ecfad21` includes the main-branch task-results integration and the capability-center alignment correction. It consumes the combined owner 0.5.1 / CAD `.7` release, preserving both native installation recipes and result presentation. Its Apple Silicon DMG is 272,166,575 bytes, SHA-256 `bddd7de095ebb6ece157d70a7f0615543a9422154142332f3111c66ffd679d85`.

The integrated source passed 366 portable tests with the existing optional KLayout skip, architecture and release checks, build/typecheck and repository formatting. Twenty actual Electron installation/UI flows plus normal-quit cleanup passed. Five layout variants verify aligned navigation icons/labels, a stable sidebar when changing pages/languages, full-width capability content, keyboard focus and normal pointer appearance. Both the five-domain packaged first-run screen and the alignment screenshots were visually inspected.

The exact integrated DMG passed its subsequent CAD `.6` → `.7` update and restart against the existing upgraded profile. It retained the native runtime directory, receipt hash, check time and executable inode. All 68 tracked files retained their contents (67 byte-identical; chat/state database tables identical logically), including project binding, model configuration, chat history and engineering evidence. Original and subsequent candidate identities remain separately attributed.

The same DMG passed the complete CAD gate with independently copied, previously verified runtime assets: install through the first-run UI, two real native Kimi/FreeCAD build/edit tasks, both independent Verifications passed, OCCT BREP viewing, removal of the actual executable, real native repair, Ready UI and restart with the original project/actions retained. Repair took about 251 seconds on the local machine. This is explicitly warm runtime reuse, not a new cold preparation claim. The first integrated attempt found the isolated profile's onboarding-skip flag set before any installation; its failure is retained. One fresh-directory rerun of the unchanged DMG completed every gate condition without increasing timeouts or weakening assertions.

## Initial candidate qualification, 2026-10-09

The first qualified Apple Silicon DMG (Domain Packs 0.4.1, before the main-branch task-results integration and capability-navigation alignment fix) was built from `0e63a25` (including the committed application changes and test capture fix). Its SHA-256 is `329ed76e1781ed7c1b52a79cb018858db546c2305cbe0e1f3ff4553b9b633bf2`, size 272,099,091 bytes. Its results below apply to that exact candidate; the integrated delivery requires its own build and acceptance record.

- The actual packaged first-run screen showed all five declared domains with four installable choices. The unconfigured online catalog retained bundled installation. Official Chip/PCB first installation and subsequent Godot installation passed on the packaged application.
- Nineteen Electron installation flows and a separate normal-quit cleanup check passed, covering light/dark/narrow layouts, cancellation, retry, repair, failed-update preservation, cross-process status, removal rejection and language switching. The design uses the existing Desktop dialog, typography, icon and control styles; the UI review also used [Impeccable](https://impeccable.cn/).
- Official FreeCAD, KiCad and Godot preparation passed full hash, archive, upstream signature and executable/version checks. Independent installed CLI/Desktop payloads passed PCB and Godot task, edit, verification, history and repair integration checks. These do not certify unexercised tasks or platforms.
- The committed portable suite passed 341 tests with one declared KLayout skip; the MCP transport suite passed 13 with one declared private PCB fixture skip. Pack Manager/CLI (40), release (17), architecture (11 + 24) and repository formatting checks passed.
- A real 1.0.0 profile with two completed CAD turns, two Actions, 25 Artifacts, two passed Verifications and three Checkpoints survived application replacement and CAD Pack `.4` → `.6`. The native application receipt/path was reused. Of 68 tracked files, 67 remained byte-identical; the changed state SQLite file retained identical logical records. Project binding, model configuration, chat database, native chat files, artifact objects and project files were preserved.
- That original migration used candidate DMG `bdfb4f420991c2b0e121e278891ee721f7e5af8763529b4e12b305f03e301788`. The `329ed76e…` candidate was then installed at the same path and passed its own restart and data-preservation checks. The old application's full legacy selftest had failed at an `UnknownVizError` screenshot after creating the engineering baseline; this remains recorded as a legacy capture failure, not a full old-app acceptance pass.
- A separate cold native CAD attempt on `329ed76e…` completed native preparation, two verified tasks, the OCCT Viewer and the actual repair operation. The window was then destroyed while waiting for the final repair UI, before the gate wrote acceptance/restart results. The process exited with code 1, without a timeout kill; the close source was not established. Its failure, journal timings and screenshot remain separate evidence, not a full CAD acceptance pass.

First-run screenshot acceptance now waits for a newly presented frame and stable pixels, not just DOM readiness. Both final first-run and installed-domain screenshots were visually inspected; the older stale loading-frame capture is not used as delivery evidence.

## Release boundary

This candidate is a local unsigned installer. The current account has no Developer ID signing identity and the repository has no release signing secrets configured. Public Gatekeeper acceptance, the signed online Pack channel and actual Core OTA therefore remain separate release requirements. The existing release workflow fails without matching Pack keys and code-signing/notarization credentials; its Pack build now installs the pinned consumer dependency before creating the catalog. No keys or private credentials belong in source.

Windows retains its existing build/first-run scope. These changes do not qualify native CAD/PCB/Godot on Windows, Linux or Intel Mac. Native project success, failure, recovery and historical evidence remain governed by each domain's declared profile.
