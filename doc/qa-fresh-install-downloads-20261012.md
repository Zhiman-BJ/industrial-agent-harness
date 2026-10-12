# Fresh-install Harbor download QA — 2026-10-12

The cold-download QA verdict is **FAIL**: KiCad and FreeCAD hit the production
20-minute total timeout. Godot passed real remote cancellation, cleanup and a
complete recovery download. This record tests native-archive downloads with empty
stores; it is separate from the packaged Desktop/UI qualification.

## Method and boundaries

- Host starting commit: `56c13604ca9956a57aa3585c4f920bb7e3409b21`; immutable Domain Packs pin:
  `e7347c14bddc956ed0336570dea0af652ccec296`.
- `scripts/qa-first-install-downloads.cjs` loads the installed consumer's
  owner declarations, creates new temporary runtime stores and invokes the default
  `RuntimeAssetManager.fetchArchive` implementation. There is no injected download
  implementation, prepared archive, Range downloader or official-source fallback.
- Production limits remain unchanged: 60 seconds without transfer progress and
  20 minutes total per download. The production size and SHA-256 checks must pass;
  successful archives also receive an independent full-file hash check.
- KiCad and FreeCAD started together (two concurrent downloads). A separately owned
  Desktop Godot installation overlapped from `05:08:26.772Z` until ready at
  `05:21:15.182Z`; its network transfer finished within that installation window.
  This script's Godot cancellation/recovery runs after both large downloads ended.
  Typical first-install flows can be
  serial. A timeout under these conditions does not establish a unique cause.
- This stage downloads archives only. It does not mount/copy native applications,
  run signatures/version probes, issue an installation-ready receipt, or qualify
  a complete first-launch UI. Those are separate production-installer checks.
- Existing user caches, applications, Docker images and containers are preserved.
  No cold Docker-layer claim is made. Evidence contains request origins/paths and
  response status/length, but no tokens or authorization headers.

## Results

| Archive       | Declared bytes | First complete attempt                                                    | Cleanup / source                                                               |
| ------------- | -------------: | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| KiCad 10.0.6  |  1,404,303,659 | **FAIL**: default timeout at 1,200.089 s; last progress 367,033,965 bytes | Partial removed; no archive or ready runtime; Harbor only                      |
| FreeCAD 1.1.4 |    649,760,538 | **FAIL**: default timeout at 1,200.147 s; last progress 477,159,022 bytes | Partial removed; no archive or ready runtime; Harbor only                      |
| Godot 4.7.2   |    170,622,178 | **PASS**: cancellation at 2.074 s; recovery verified in 222.322 s         | Production partial removal; empty same-store recovery cache; own store removed |

KiCad ran from `05:05:28.983Z` to `05:25:29.040Z`; FreeCAD ran from
`05:05:29.026Z` to `05:25:29.130Z`. Both errors were exactly
`Download timed out. Please retry.` Each had one complete-download attempt and no
retry. Progress is reported at approximately 1 MiB intervals, so the final progress
count is a lower bound on bytes received before production cleanup. These are
real failures under the recorded concurrency conditions, not missing-prerequisite
blocks. They do not establish whether serial downloads would fail or identify a
single network/server cause. Previous full Range/hash publication checks do not
qualify this single-GET first-install download path.

Godot cancellation ran from `05:26:22.264Z` to `05:26:24.364Z`; recovery ran from
`05:26:24.365Z` to `05:30:06.702Z`, after the other native downloads ended. Its
complete 170,622,178 bytes matched SHA-256
`c58a24e31d720be9d62f60cb5627c4e695fb72f21b0cfe1bc9ccaa9a3b3ba63e`.
Both production verification and the independent full-file hash passed. Cancellation
left no partial or final archive, recovery began with an empty cache, all observed
requests stayed on Harbor, and the final strict wrapper exited zero. The download-only
runtime remained unready, as expected. Its verified archive was removed only after
hash metadata was recorded; this is not an application-installation-ready claim.

Machine-readable progress and final outcomes are retained under
`dist/qa-first-install-20261012/downloads/`. A failed attempt retains its actual
error, last reported bytes, elapsed time, remaining cache files and absence/presence
of a ready runtime. No failed download is promoted to an installation success.

The immutable first-attempt records are `kicad-first-attempt.json` and
`freecad-first-attempt.json`; Godot records are
`godot-isolated/godot-cancellation.json` and `godot-isolated/godot-recovery.json`.
`download-qa-assessment.json` records the overall failure, concurrency, wrapper
scope and final inspection/cleanup of the two original empty stores. Small progress
logs and the existing-evidence-directory rejection are retained beside them.

## Reproduction

Run the explicit opt-in network probe from the Host root:

```sh
node scripts/qa-first-install-downloads.cjs --output dist/my-new-large-download-evidence kicad freecad
# Wait for other native download activity to finish before the separate Godot run.
node scripts/qa-first-install-downloads.cjs --output dist/my-new-godot-evidence --cancel-recover godot
```

The script refuses an existing evidence directory, including an empty one. Omitting
`--output` generates a unique evidence directory. Each invocation creates a
new temporary store. The final script records hashes and removes only its own
temporary store after every attempt ends; it preserves the small JSON evidence. Do not
point it at a user store or prepopulate its cache. Failed `.partial` files are
removed by the production downloader, not by a QA replacement implementation.

The two large attempts started with the earlier dated QA wrapper, before final
evidence-directory guards, aggregate QA checks, concurrency metadata and store
cleanup were added. Their production downloader and default limits did not change;
they were not repeated after the wrapper was hardened. Their raw first-attempt
JSON files remain unchanged. Both original temporary stores had empty caches and
no app directories; those empty directories were subsequently removed without
recursive deletion or touching an existing user store.
The final wrapper additionally fails its exit status if cleanup, source-origin,
empty-cache, hash/size, cancellation or absence of a download-only ready runtime
does not match the expected observations.

After these recorded downloads, the wrapper's final evidence-directory creation
was made atomically exclusive. It also captures one repository-root-based
`invocation.json` with the full Host commit, dirty status, platform/architecture
and script SHA-256; every attempt references the same snapshot. Relative output
paths resolve from the script's repository root, even when invoked elsewhere.
These metadata and directory guards were checked without network access; they do
not change the production download strategy or rewrite the existing raw results.
