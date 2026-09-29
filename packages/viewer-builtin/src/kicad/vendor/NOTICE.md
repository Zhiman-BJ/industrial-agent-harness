# Local KiCanvas runtime

- Source: https://github.com/theacodes/kicanvas
- Commit: `b031159eb74aaa7eef2b026fd85d35bc05ff2095`
- Build: `scripts/build-kicanvas.cjs`, esbuild `0.27.1`, ES2022 module
- Entry: embed element, board and schematic applications, and upstream SVG toolbar icon setup; no standalone shell
- Modification: omit the upstream Google Fonts link. No CAD parser or renderer changes.
- Material Symbols Outlined font: Google Fonts snapshot retrieved 2026-09-28 from `https://fonts.gstatic.com/s/materialsymbolsoutlined/v374/kJF1BvYX7BgnkSrUwT8OhrdQw4oELdPIeeII9v6oDMzByHX9rA6RzaxHMPdY43zj-jCxv3fzvRNU22ZXGJpEpjC_1n-q_4MrImHCIJIZrDCvHOem.ttf`; full Apache 2.0 terms in `symbols-LICENSE`.

`LICENSE.md`, `earcut-LICENSE`, `newstroke-README.md`, and `newstroke-NOTICES.txt` retain upstream and third-party copyright/license statements. UI text uses system fonts; Nunito and Bellota are not distributed. `manifest.json` pins the runtime and icon-font SHA-256 hashes. Rebuild instructions and boundaries: `doc/kicad-viewer.md`.
