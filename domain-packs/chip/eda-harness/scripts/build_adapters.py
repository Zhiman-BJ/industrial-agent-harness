"""Build project-bound Claude/Kimi packages without changing either runtime's settings."""

import argparse
import json
import shlex
import shutil
import sys
from pathlib import Path


def build(project, output, read_only=False):
    repo = Path(__file__).resolve().parents[1]
    project, output = Path(project).resolve(), Path(output).resolve()
    if not (project / "eda.yaml").is_file():
        raise ValueError("Project must contain eda.yaml")
    if output.exists():
        raise ValueError("Output already exists; choose a new directory")
    # Keep the venv interpreter path; resolving the symlink would select Python outside the venv.
    server = {"command": sys.executable, "args": ["-m", "eda_harness.cli", "--project", str(project), "mcp"]}
    if read_only:
        server["args"].append("--read-only")
    for runtime in ("claude-code", "kimi-code"):
        target = output / runtime
        shutil.copytree(repo / "integrations" / runtime, target)
        shutil.copytree(repo / "skills", target / "skills", dirs_exist_ok=True)
        if runtime == "claude-code":
            (target / ".mcp.json").write_text(json.dumps({"mcpServers": {"eda": server}}, indent=2))
            command = f'{shlex.quote(sys.executable)} "${{CLAUDE_PLUGIN_ROOT}}/hooks/bootstrap.py"'
            hooks = {"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": command}]}]}}
            (target / "hooks/hooks.json").write_text(json.dumps(hooks, indent=2))
        else:
            manifest = target / "kimi.plugin.json"
            data = json.loads(manifest.read_text())
            data["mcpServers"] = {"eda": server}
            manifest.write_text(json.dumps(data, indent=2))
    (output / "mcp.project.json").write_text(json.dumps({"mcpServers": {"eda": server}}, indent=2))
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--read-only", action="store_true")
    args = parser.parse_args()
    print(build(args.project, args.output, args.read_only))
