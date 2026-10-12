# Desktop environment and installation QA

Build the renderer first. Electron selftests load `dist/`; an old build is not evidence for current UI code.

```sh
pnpm --filter @industrial-agent-harness/desktop build
pnpm --filter @industrial-agent-harness/desktop test
```

## Environment selection through production IPC

Use new isolated directories for each run:

```sh
INDUSTRIAL_HARNESS_PACK_STORE=/tmp/harness-env-packs-unique \
INDUSTRIAL_UI_SCREENSHOTS=/absolute/path/to/fresh-evidence \
pnpm --filter @industrial-agent-harness/desktop exec electron . \
  --runtime-environments-selftest --user-data-dir=/tmp/harness-env-user-unique
```

This real renderer test installs one signed fixture Pack through `domains:install`, verifies that no native archive is requested, detects two signed fixture applications through the shared backend, and checks explicit application association, unsupported profiles, cancellation, failed association, project/default binding isolation, unconfigured remote selection without upload, system font sizes and dark narrow layouts. It produces `report.json` and PNG screenshots.

The test catalog is deliberately `https://environment-fixture.example/catalog.json`, contains only **Environment fixture**, and is served by deterministic local transport. Other declared domains may display **Not offered by the current catalog** in these screenshots because the fixture catalog omits their release bundles. That is test context, not a shipping support or distribution claim. Only the actual signed release catalog and its qualified bundles establish distribution availability.

## Installation, explicit preparation and repair

```sh
HARNESS_INSTALL_EXPERIENCE_REPORT_DIR=/absolute/path/to/fresh-install-evidence \
INDUSTRIAL_HARNESS_PACK_STORE=/tmp/harness-install-packs-unique \
pnpm --filter @industrial-agent-harness/desktop exec electron . \
  --install-experience-selftest --user-data-dir=/tmp/harness-install-user-unique
```

The installation gate covers catalog states, selection, Pack transfer estimates and cancellation, failed update preservation, background installation, external-process preparation status, navigation, both languages and narrow layouts. The signed native fixture app is installed externally and explicitly associated after the source Pack is installed; zero native archive requests are asserted. The repair path clicks **Choose installed application → Check and save environment**; installation alone must not report native readiness.

Repeat with `HARNESS_INSTALL_EXPERIENCE_QUIT_TEST=true` to exit normally during an active Pack transfer. The transfer must cancel and release its installation lock before exit, with no native downloads.

The fixture tests exercise the application and shared lifecycle, not engineering acceptance of FreeCAD, KiCad, Godot, CUDA or an EDA toolchain.

## Packaged native CAD qualification

`electron/cad-install-selftest.cjs` is the packaged Apple Silicon acceptance flow. Run the release qualification procedure with a real bundled CAD Pack, externally installed FreeCAD, pinned native Kimi and controlled model endpoint. Set `HARNESS_CAD_INSTALL_REPORT_DIR` and invoke the installed application with `--cad-install-selftest`; set `HARNESS_CAD_INSTALL_APP_PATH` (or `HARNESS_FREECAD_APP_PATH`) to an externally installed app. The test clones it outside the Pack store before damaging only the test copy.

The gate first installs the source Pack, verifies that no software environment was selected, then selects the external app and saves the qualified native profile. It subsequently exercises native build/edit actions, independent readback, the OCCT Viewer, runtime damage and explicit repair. Restart and upgrade modes preserve projects, action evidence, chat history and verified native receipts; the target version comes from the signed bundled catalog.

A fixture renderer pass does not replace this packaged native gate. Signing, notarization, public first launch, actual remote services and platforms not exercised must be reported separately.

## Actual five-domain bootstrap catalog

Use the publisher output that ships as `bootstrap-packs`, rather than the fixture catalog:

```sh
HARNESS_RELEASE_CATALOG_BUNDLED_DIR=/absolute/path/to/domain-packs-v2 \
HARNESS_RELEASE_CATALOG_REPORT_DIR=/absolute/path/to/fresh-five-domain-evidence \
INDUSTRIAL_HARNESS_PACK_STORE=/tmp/harness-five-packs-unique \
pnpm --filter @industrial-agent-harness/desktop exec electron . \
  --release-catalog-selftest --user-data-dir=/tmp/harness-five-user-unique
```

The gate installs all five actual source archives through production IPC, checks catalog availability and versions, verifies that installation emits no environment preparation events, and captures the installed capability center with native, container and remote profiles. `report.json` records actual catalog provenance and each profile's qualification/configuration state. The explicitly enabled test flag is required to override the bundled directory.

## Secure remote service configuration

Runtime-managed remote profiles render their declared endpoint, credential and expected identity fields. **Save connection securely** uses Electron's OS-backed encryption and keeps only ciphertext in the application's `runtime-connections` directory. Existing credentials never return to the renderer; an empty credential retains the saved value, and **Remove saved credential** explicitly deletes that stored override. A trusted launch environment may still supply the same setting. Without OS encryption, saving is disabled; Linux `basic_text` never falls back to plaintext.

Saving settings does not select a profile. **Check and save environment** associates it explicitly. Configured connections remain unverified until the owner Runtime completes the service and project handshake. This connection is distinct from the existing project remote coordinator. Connecting alone never uploads project files or substitutes a local environment.

The environment renderer gate also saves a remote fixture connection through actual IPC and OS encryption, checks ciphertext and returned views for credential leakage, then verifies the configured/unchecked state and explicit association. Actual CUDA paired-service execution still requires the deployed service acceptance gate.

The renderer gate also delays actual environment IPC responses across project switches. Old descriptions, connection results, errors and pending cleanup must not overwrite the newly selected context. Secure saving has no cancellation button because the encrypted write cannot be interrupted once accepted. A damaged encrypted record disables the affected remote profile; **Clear damaged saved connection** explicitly removes that record and allows reconfiguration without requiring decryption or silently selecting another environment.

Native applications and private runtime folders must be installed externally, then selected and associated. Native preparation IPC must refuse before any download. Container profiles alone expose **Prepare container image**; Docker must already be installed and running. Pack installation must never pull images implicitly.
