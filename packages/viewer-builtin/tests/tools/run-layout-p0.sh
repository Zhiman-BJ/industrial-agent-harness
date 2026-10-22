#!/bin/sh
# Run manually from the user's Terminal. Uses Electron's existing isolated
# layout selftest profile; never changes a layout source or the normal profile.
set -eu

tool_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$tool_dir/../../../.." && pwd)
layout_python=${KLAYOUT_PYTHON:-"$repo_dir/../industrial-agent-harness/apps/desktop/.venv-klayout/bin/python"}
report_dir=${INDUSTRIAL_UI_SCREENSHOTS:-"$repo_dir/doc/evidence/layout-p0-20261019/native"}

if [ ! -x "$layout_python" ]; then
  printf '%s\n' 'Set KLAYOUT_PYTHON to the Python executable with KLayout installed.' >&2
  exit 1
fi
if [ ! -f "$repo_dir/apps/desktop/dist/index.html" ]; then
  printf '%s\n' 'Build the desktop first: pnpm --filter @industrial-agent-harness/desktop build' >&2
  exit 1
fi
mkdir -p "$report_dir"
cd "$repo_dir/apps/desktop"
printf 'Native layout acceptance report: %s\n' "$report_dir"
exec env -u ELECTRON_RUN_AS_NODE -u INDUSTRIAL_DEV_URL \
  KLAYOUT_PYTHON="$layout_python" \
  INDUSTRIAL_UI_SCREENSHOTS="$report_dir" \
  node node_modules/electron/cli.js . --layout-selftest --keep-open
