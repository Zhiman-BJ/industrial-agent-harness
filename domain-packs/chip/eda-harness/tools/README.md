# Complete EDA tool environment

`Dockerfile.tools` now supplies **Verilator, Yosys, OpenROAD, KLayout, Magic, Netgen LVS and GTKWave together**, with the ORFS
Nangate45 platform. It uses fixed public upstream binary images rather than requiring local private
tags. The target is `linux/amd64`, including when building on an ARM Mac.

```bash
docker build --platform linux/amd64 -f Dockerfile.tools -t eda-harness-tools:dev .
uv run eda tools
uv run python scripts/prepare_nangate45.py --destination /tmp/eda-counter
uv run eda --project /tmp/eda-counter run-until simulate --wait
uv run eda --project /tmp/eda-counter run-until post_route_sta --wait
uv run eda --project /tmp/eda-counter run-until drc --wait
```

The original tool versions are Verilator **5.026**, Yosys **0.68**, OpenROAD
**26Q3-1867-g84e3ff1eb2**, and KLayout **0.30.7**.

The first pull is large: the official ORFS image includes its toolchain, flow scripts, and platforms.
Subsequent builds reuse the pinned layers. The compiler and `make` are intentionally retained because
Verilator simulation compiles generated C++ at execution time. The added tools use fixed Ubuntu package versions. The package index and transitive runtime
dependencies are resolved at build time; the actual package inventory and resulting image ID
are recorded after validation. No mutable source branch is compiled.

## Fixed upstream identities

| Component | Executable upstream manifest |
|---|---|
| ORFS (OpenROAD, Yosys, KLayout, platforms) | `openroad/orfs@sha256:cdb377cec7796c5cb01d482ca035811bfe559ca55dcca7f5e5f46fa811c63142` |
| Verilator v5.026 | `verilator/verilator@sha256:4381a83fc2864cc2be91c5acb8ddff688077c73db20304b7f2c38cccd6a965da` |

The ORFS digest was resolved once from the public upstream image during implementation; builds use
the digest above, never the mutable tag. `eda tools` reports actual embedded versions and the local
image ID. Upstream source identities, versions and local acceptance results are recorded in
[validation.json](validation.json).

Source and license references:

- [OpenROAD/ORFS](https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts): BSD-3-Clause for ORFS/OpenROAD;
  bundled components retain their own licenses, including OpenSTA's GPL terms.
- [Yosys](https://github.com/YosysHQ/yosys): ISC.
- [KLayout](https://www.klayout.de/license.html): GPL-2.0-or-later under the published upstream license policy.
- [Verilator](https://github.com/verilator/verilator/tree/v5.026): LGPL-3.0-only OR Artistic-2.0.
- Nangate45/FreePDK45 files and rule decks retain the notices shipped in the ORFS platform directory.
  The example preparation script copies those original notices with the platform.

The repository provides a reproducible assembly recipe. It does not publish a derived image to a registry.
For later image distribution, retain upstream source/license notices and record the published digest.

## Local processing validation

The required host interface runs one RTL input through one fresh container:

```bash
./validate.sh --help
./validate.sh examples/counter/rtl/counter.sv
./validate.sh examples/counter/rtl/counter.sv --output /tmp/eda-validation
./validate.sh /path/to/small-design.sv --top my_top --image eda-harness-tools:dev --timeout 180
```

This is a **small-design tool interoperability test**, not an arbitrary production physical flow. It
runs lint, library-mapped synthesis, floorplanning/placement, and KLayout DEF/GDS conversion with GDS
round-trip and referenced-cell checks. It does not infer simulation correctness or timing/DRC/LVS
closure from those stages. Use the Harness project workflow for full project-specific execution.

The build runs the same real processing smoke on the embedded counter. Output artifacts include
`netlist.json`, `netlist.v`, `placed.odb`, `placed.def`, `routed.gds` (a historical exporter filename;
this smoke has placement only), `streamout-checks.json`, and `versions.json`.

Every validation task uses a read-only input/root, a unique output directory, disabled network,
dropped capabilities, no-new-privileges, caller UID/GID, two CPUs, 4 GiB RAM, 256 PIDs,
a 128 MiB non-executable `/tmp`, and a configurable timeout (180 seconds by default).

When output is omitted, a unique temporary directory is printed as `Output directory: ...` and
logs stream to the terminal. An explicit empty output directory additionally receives `workload.log`.
An existing nonempty output directory is never overwritten. Every started validation writes
`result.json` with schema `zhiman.eval/software-validation-result/1.0`; success includes a validated
nonempty primary artifact. Failures preserve their exit code and diagnostics.

Exit codes: 0 success, 64 usage, 65 unsupported format, 66 missing input, 73 unusable output,
124 timeout, 130 interruption; tool/processing failure is nonzero.

Run the complete local acceptance suite after building:

```bash
uv run python tools/test_contract.py --image eda-harness-tools:dev
```

It checks help/usage, missing/unsupported/invalid inputs, explicit/default output behavior,
non-overwrite, readable artifacts, and two concurrent isolated tasks. Tool image acceptance is
performed locally; the GitHub workflow continues to run the lightweight Harness tests and package build.
The separate `tests/test_tool_environment.py` verifies error paths without requiring Docker.

## Tool completeness versus design completeness

All seven tools are included. OpenSTA is available through OpenROAD's STA commands. KLayout can
execute DRC and LVS scripts; the project must still provide an appropriate LVS extraction/comparison
deck. Having the executable does not supply foundry rules or make the teaching counter signoff-clean.
The updated counter now passes the supplied full DRC deck, transistor LVS and RTL-to-routed-netlist
equivalence. Negative fixtures verify that broken routing and changed logic are rejected.
Current physical-flow evidence is in [docs/validation.md](../docs/validation.md); the tool image
record in validation.json is the historical image-build acceptance, not the latest design acceptance.

## Independent verification and waveform tools

| Tool | Fixed Ubuntu package | Source and license |
|---|---|---|
| Magic | `8.3.105+ds.1-1.1` | [Magic](https://github.com/RTimothyEdwards/magic), BSD-style; see `/usr/share/doc/magic/copyright` |
| Netgen LVS | `1.5.133-1.1` | [RTimothyEdwards Netgen](https://github.com/RTimothyEdwards/netgen), GPL-1 and component licenses; `/usr/share/doc/netgen-lvs/copyright` |
| GTKWave | `3.3.104-2build1` | [GTKWave](https://github.com/gtkwave/gtkwave), GPL-2-or-later and component licenses; `/usr/share/doc/gtkwave/copyright` |
| Xvfb | `2:21.1.4-2ubuntu1.7~22.04.16` | Ubuntu X server package, temporary headless display |
| xauth | `1:1.1-1build2` | X display authorization |
| libnss-wrapper | `1.1.11-1ubuntu2` | Temporary passwd mapping for arbitrary container UIDs |

These are deliberately fixed distribution releases, not claims of latest upstream versions.
Netgen is the circuit comparator (`netgen-lvs`), exposed as `netgen`; it is not the unrelated
mesh-generation package. GTKWave's wrapper supplies a temporary NSS entry when needed, avoiding
its null passwd-record crash under `--user UID:GID`; `/etc` remains untouched.

[The independent verification example](../examples/verification/README.md) runs native Magic
SCMOS extraction, Netgen LVS, and GTKWave VCD/FST viewing through Harness custom actions.
The image build and `validate.sh` now also test a matching netlist, wrong transistor width,
shorted gate, FST round-trip data, and GTKWave session save/reopen. Waveform viewing does not
prove design correctness. This SCMOS fixture does not qualify Magic for Nangate45 extraction.

Current acceptance evidence is in [verification-validation.json](verification-validation.json).
`validation.json` retains the original four-tool image's historical evidence.

## 网表渲染

Dockerfile.tools 增加 Graphviz 包 `2.42.2-6ubuntu0.1`，用于 Yosys 内置 show/viz 生成 SVG。库存检查包含 dot -V。旧镜像需要重新构建；默认后端不依赖本机 Node.js。

本次实际增量镜像的包版本、镜像身份和 show/viz 验证结果见 [yosys-viewer-validation.json](yosys-viewer-validation.json)。完整构建因 Docker Hub frontend 元数据 EOF 暂未完成；原生渲染在已验证旧镜像上增加相同 Graphviz 包的增量镜像中完成。
