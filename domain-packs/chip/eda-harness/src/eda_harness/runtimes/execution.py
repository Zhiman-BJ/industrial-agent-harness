import hashlib
import os
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from eda_harness.core.models import RuntimeConfig


@dataclass
class Execution:
    status: str
    returncode: int | None
    elapsed_seconds: float
    argv: list[str]


def identity(config: RuntimeConfig, tool: str):
    if config.kind == "docker":
        proc = subprocess.run(
            ["docker", "image", "inspect", config.image, "--format", "{{.Id}}"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if proc.returncode:
            raise ValueError(f"Docker image unavailable: {config.image}. Pull/build it before submitting.")
        return {"kind": "docker", "image_id": proc.stdout.strip()}
    binary = shutil.which(tool)
    if not binary:
        raise ValueError(f"Tool not installed: {tool}")
    flags = {"yosys": "-V", "klayout": "-v", "openroad": "-version", "netgen": "-batch"}
    command = [binary, flags.get(tool, "--version")]
    if tool == "gtkwave" and not os.environ.get("DISPLAY"):
        command = ["xvfb-run", "-a", *command]
    proc = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=15,
        env={**os.environ, "GSETTINGS_BACKEND": "memory"},
    )
    if proc.returncode:
        raise ValueError(f"Cannot determine {tool} version: {proc.stderr[:500]}")
    return {
        "kind": "local",
        "binary": binary,
        "sha256": hashlib.sha256(Path(binary).read_bytes()).hexdigest(),
        "version": (proc.stdout + proc.stderr).strip()[:2000],
    }


class Runtime:
    def __init__(self, config, tool_identity, token, source, deps, work):
        self.config = config
        self.identity = tool_identity
        self.token = token
        self.source, self.deps, self.work = source, deps, work
        docker = config.kind == "docker"
        self.paths = {
            "input": "/inputs" if docker else str(source),
            "deps": "/deps" if docker else str(deps),
            "work": "/work" if docker else str(work),
        }

    def execute(self, argv, env, log, cancelled, started):
        actual = list(argv)
        resource = self.config.resources
        docker = self.config.kind == "docker"
        if docker:
            actual = [
                "docker",
                "run",
                "--rm",
                "--init",
                "--name",
                self.token,
                "--network",
                "none",
                "--cpus",
                str(resource.cpu),
                "--memory",
                f"{resource.memory_gb}g",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--mount",
                f"type=bind,src={self.source},dst=/inputs,readonly",
                "--mount",
                f"type=bind,src={self.deps},dst=/deps,readonly",
                "--mount",
                f"type=bind,src={self.work},dst=/work",
                "--workdir",
                "/work",
            ]
            for key, value in env.items():
                actual.extend(["--env", f"{key}={value}"])
            actual.extend(["--entrypoint", argv[0], self.identity["image_id"], *argv[1:]])
        start = time.monotonic()
        with log.open("ab") as output:
            output.write(("argv: " + repr(actual) + "\n").encode())
            output.flush()
            proc = subprocess.Popen(
                actual,
                cwd=self.work,
                env={**os.environ, **env},
                stdout=output,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
            started(proc.pid, self.token if docker else None)
            status = "RUNNING"
            try:
                while proc.poll() is None:
                    if cancelled():
                        status = "CANCELLED"
                        break
                    if time.monotonic() - start >= resource.timeout_seconds:
                        status = "TIMEOUT"
                        break
                    time.sleep(0.1)
            finally:
                if proc.poll() is None:
                    if docker:
                        subprocess.run(["docker", "rm", "-f", self.token], capture_output=True, timeout=20)
                    try:
                        os.killpg(proc.pid, signal.SIGTERM)
                        proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait()
        if status == "RUNNING":
            status = "SUCCESS" if proc.returncode == 0 else "FAILED"
        return Execution(status, proc.returncode, time.monotonic() - start, actual)
