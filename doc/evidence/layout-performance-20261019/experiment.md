# Real-artifact service performance and recovery experiment

This is a read-only, headless RasterService experiment on the existing Sobel archive and SKY130 FIFO. Source provenance and SHA-256 values are in `../layout-p0-20261019/real-layouts.json` and `provenance.json`. It does not measure browser/Electron frame rate, GPU upload, or interactive input-to-frame latency.

The measured run lasted **60.875 seconds**: four 15-second epochs alternate Sobel/FIFO, using deterministic changing 4/8/16/32 µm regions and 256 px tile requests. Each of 1,200 cold requests is followed by an immediate replay under a new generation. Requests are paced at one pair per 50 ms, with bounded cancellation and fault bursts. The script has a 115-second wall limit and uses production queue/cache/resource settings.

| Operation | Samples | p50 ms | p95 ms | Maximum ms |
| --- | ---: | ---: | ---: | ---: |
| Changing-ROI cold request | 1,200 | 7.337 | 32.272 | 105.246 |
| Immediate cache replay | 1,200 | 0.032 | 0.132 | 6.172 |
| Source load / replacement | 4 | 124.274 | 379.637 | 379.637 |
| Worker crash recovery | 1 | 276.562 | 276.562 | 276.562 |

Cold responses included 1,118 exact meshes and 82 empty regions. No cold response in this run used overview fallback. The cache reached 65,018,458 bytes (62.01 MiB), below its 64 MiB limit; this run did not trigger eviction. Overview correctness and geometry comparison have separate earlier evidence; this soak is not a saturation or eviction test.

The queue reached its configured 32 waiting requests. In a 40-request burst, 7 were rejected as queue-full and the active/remaining 33 were superseded. Repeated generation changes and three source replacements rejected obsolete requests. A separate immediate-generation probe measured the newest uncached result after cancellation in **25.770–57.863 ms** across six trials; all 48 obsolete requests were rejected and none entered the cache.

An intentional SIGKILL targeted only the test's worker during a request. That request failed explicitly. The next uncached request reloaded the same immutable source and produced identical exact geometry. Both source SHA-256 values and the production implementation hashes remained unchanged during the measured run.

Worker `resource.ru_maxrss` reached **100.41 MiB**. This is a per-process high-water mark, not current RSS; monotonic high-water growth alone is not evidence of a leak. The Node test host's sampled current RSS peaked at **171.29 MiB**. The report includes 250 ms samples and per-PID lifetime/peak data. Four bounded epochs cannot establish long-session leak freedom, and these small/medium archived designs do not qualify large industrial layouts.

Three source changes briefly overlapped an already SIGKILL-signalled worker awaiting its exit event and its replacement: **1.006, 0.559, and 1.048 ms**. At most one worker had not yet been signalled to terminate; the spawned-until-exit count peaked at two. Strictly one live process at every instant is therefore not established. On final close, live workers, queued requests, cache entries, and cache bytes all reached zero.

## Reproduce

Run from the repository root with KLayout 0.30.12 Python and the external FIFO matching the recorded SHA-256. See the [shared input and hash-check instructions](../layout-p0-20261019/README.md#公开路径与复现); `LAYOUT_ACCEPTANCE_MANIFEST` optionally selects a manifest with the same structure:

```sh
export LAYOUT_FIFO_FILE=/path/to/sync_fifo.gds
KLAYOUT_PYTHON=/path/to/klayout/python node doc/evidence/layout-performance-20261019/soak-real-layouts.cjs
KLAYOUT_PYTHON=/path/to/klayout/python node doc/evidence/layout-performance-20261019/probe-generation-latency.cjs
```

The scripts read original GDS files, use a test-owned worker, and write reports in this directory. `soak-report.json` contains requests, samples, source/implementation hashes, worker lifetimes, and cleanup results. `summary.json` includes aggregate and per-fixture/mode latency. `generation-latency.json` records the immediate cancellation probe. The reproduction script also records `layout_resources.py` in its implementation fingerprint; that monitor file's hash was captured after the original run as an explicitly labeled additional field.

Publication note: only source-path metadata was normalized in the archived reports; measurements, selected-source hashes and historical implementation fingerprints remain unchanged. This publication cleanup did not rerun the workloads.
