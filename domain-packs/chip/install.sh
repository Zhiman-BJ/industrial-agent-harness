#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v uv >/dev/null 2>&1; then
  echo 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/' >&2
  exit 1
fi
(
  cd "$root/eda-harness"
  uv sync --frozen --no-dev --managed-python --python 3.13
)
uv venv --managed-python --python 3.13 "$root/.venv-kimi"
uv pip install --python "$root/.venv-kimi/bin/python" 'kimi-cli==1.51.0'
"$root/eda-harness/.venv/bin/python" "$root/scripts/mcp-smoke.py"
"$root/.venv-kimi/bin/kimi" --version
echo 'Chip Pack installed. See README.md for project binding and tool image setup.'
