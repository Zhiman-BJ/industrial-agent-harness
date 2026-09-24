#!/bin/sh
set -eu
if ! command -v uvx >/dev/null 2>&1; then
    echo "EDA Harness requires uv (including uvx). Install uv, then reconnect the MCP server." >&2
    exit 1
fi
# Resolve paths relative to the installed plugin, including paths containing spaces.
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Diagnostic declarations; the server separately reads installed VCS metadata as evidence.
export EDA_HARNESS_LAUNCHER_PATH="$plugin_root/scripts/serve.sh"
export EDA_HARNESS_PLUGIN_VERSION="0.6.0"
# Pin source, interpreter, runtime dependencies AND isolated build dependencies.
# Always use a uv-managed environment, never a separately installed eda executable.
exec uvx --isolated --managed-python --python 3.13.13 \
    --constraints "$plugin_root/locks/runtime.txt" \
    --build-constraints "$plugin_root/locks/build.txt" \
    --from "git+https://github.com/Zhiman-BJ/eda-harness@b60ad86620f163c09a5d36eeedfd8152e1518c73" eda \
    mcp "$@"
