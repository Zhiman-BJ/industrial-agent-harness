# EDA Viewer examples

This directory carries the three existing in-app EDA viewers into the new Viewer layer as reference implementations. They are source examples, not yet wired into the new Electron desktop application or Artifact registry.

| Example | Existing rendering API | Migrated pieces |
| --- | --- | --- |
| Layout | KLayout Python `LayoutView`, `zoom_box`, `get_pixels_with_options` | `layout/` raster service, Python renderer, React viewport |
| Netlist | `netlistsvg.render` on Yosys `write_json` | `netlist/` bounded worker and React viewport |
| Waveform | Surfer WASM viewer and host message bridge | `waveform/` local protocol, isolated iframe UI, pinned upstream assets |

The layout renderer needs a Python environment with `klayout` installed. The netlist worker uses locked `netlistsvg@1.0.2`. The Surfer assets are a pinned official-site snapshot; `waveform/surfer/NOTICE.md`, `LICENSE-EUPL-1.2.txt` and `ASSET-MANIFEST.json` preserve attribution, license and hashes. The host adapter uses Surfer message commands that upstream warns can change between versions, so they require a compatibility check before an upgrade.

The migrated React components still call the former demo's `window.replayApi` shape. `api.ts` records the minimum host contract needed to study them. The production Viewer Host will replace it with requests bound to `projectId`, `artifactId` and explicit Run/State identity. Do not expose these examples directly to arbitrary file paths in the product.

`viewer-styles.css` is the original replay workbench stylesheet used by these React components. It includes some surrounding demo styles; production integration should extract only the Viewer rules.

The `fixtures/counter.json` and `counter.vcd` files exercise netlist and waveform handling. The layout test creates a small real GDS with KLayout; it runs when `KLAYOUT_PYTHON` points to a Python executable with KLayout. Run the backend checks from the repository root:

```bash
pnpm --filter @industrial-agent-harness/viewer-builtin test:examples
```

For the optional layout check:

```bash
KLAYOUT_PYTHON=/path/to/klayout-python pnpm --filter @industrial-agent-harness/viewer-builtin test:examples
```

The checks confirm real netlist rendering, local waveform file isolation, upstream binary hashes, and (when KLayout is available) viewport rendering. They do not claim an end-to-end new desktop Viewer Host. Product integration rules are in [Viewer layer design](../../../../doc/viewer-layer.md).
