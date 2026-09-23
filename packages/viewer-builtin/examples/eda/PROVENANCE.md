# Provenance

The example adapters and React viewports were migrated from the local `silicon-lens-harness` demo worktree on 2026-09-23. The layout Python renderer uses KLayout's Python APIs; the netlist worker uses the published `netlistsvg` package. The waveform adapter wraps a pinned Surfer official-site JavaScript/WASM snapshot. The copied source was kept close to its demo form so future Viewer integrations can inspect the existing behavior; paths and a small API type declaration were adjusted for this example directory.

The former demo's playback, project registry and Electron IPC are intentionally not copied. Product code must resolve registered Artifact IDs and verify provenance before invoking these viewers. See `waveform/surfer/NOTICE.md` for Surfer asset attribution and hashes.
