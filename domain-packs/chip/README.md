# Chip Pack: EDA Harness 0.6.0

This is a separate, no UI domain release. It contains the full EDA Harness MCP server (25 tools), its `eda-core` Skill, a project-bound Kimi adapter generator, and a Dockerfile for the EDA tool image. It is not installed into the Industrial Agent Harness Core Broker yet.

## Install

Download the `industrial-agent-harness-chip-<tag>.tar.gz` asset and matching `.sha256` file from the Chip Pack GitHub Release. Verify with `sha256sum -c` (or `shasum -a 256 -c` on macOS), then:

```bash
tar -xzf industrial-agent-harness-chip-<tag>.tar.gz
cd chip-pack
sh ./install.sh
```

Installation needs `uv`, network access to the pinned Python dependencies, and Python 3.13 managed by uv. It creates separate environments for EDA Harness 0.6.0 and Kimi CLI 1.51.0 inside this directory; it does not modify global Kimi settings. Check the live MCP surface with `./eda-harness/.venv/bin/python scripts/mcp-smoke.py`.

The archive itself contains the EDA MCP source and Skill, not prebuilt Python environments. The installer downloads Python packages, including Kimi CLI; the installed environments occupy substantially more disk space than the archive. This keeps the Release portable across supported Python platforms while preserving the EDA dependency lock.

## Bind a project to Kimi

An existing EDA project needs `eda.yaml`. To create one, first prepare the EDA tool image (below), then use `./chip-harness.sh --project /absolute/project init --top TOP`. For an existing project:

```bash
./bind-kimi.sh /absolute/project /absolute/new-adapter-dir
./.venv-kimi/bin/kimi --work-dir /absolute/project \
  --mcp-config-file /absolute/new-adapter-dir/mcp.project.json \
  --skills-dir /absolute/new-adapter-dir/kimi-code/skills \
  --prompt 'Inspect the EDA project status'
```

The adapter binds the project to the installed Python environment. Recreate it if the Chip Pack is moved or reinstalled. Model configuration and credentials are still required by Kimi. The MCP server itself can be started with `./chip-harness.sh --project /absolute/project mcp`; no model key is needed for the MCP smoke test.

## EDA executables

The 25 MCP tools are installed, but actual lint/simulation/synthesis/physical actions require Docker and the EDA tool image. Build and inspect the image from this pack:

```bash
docker build --platform linux/amd64 -f eda-harness/Dockerfile.tools -t eda-harness-tools:dev eda-harness
./chip-harness.sh --project /absolute/project tools --image eda-harness-tools:dev
./chip-harness.sh --project /absolute/project doctor --target rtl.lint
```

The image contains Verilator, Yosys, OpenROAD, KLayout, Magic, Netgen LVS, and GTKWave. Building it downloads large upstream images and may require platform emulation outside Linux/amd64. Project inputs, PDK, constraints, and acceptance rules are supplied by the project. MCP `run_action`/`run_until` submit work through EDA Harness's persistent runtime; `get_run` and acceptance evidence must be checked separately.

## Boundary with Core

This domain pack runs as a standalone EDA Harness/Kimi integration. It does not inherit the current Core Broker allowlist. Do not connect its 25-tool MCP directly through the Core's empty Domain MCP registry or claim the Core vertical slice is complete. The split release lets real EDA scenarios expose gaps while Core's DomainState, Broker gateway, contracts, and shared Runtime integration are built and tested.
