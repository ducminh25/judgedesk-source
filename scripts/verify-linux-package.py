#!/usr/bin/env python3
"""Smoke-test a graphical Linux package with six real sandboxed toolchains."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request


def main():
    if not __debug__:
        raise RuntimeError("Acceptance checks require Python assertions; remove -O/PYTHONOPTIMIZE")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, type=Path)
    parser.add_argument("--bundle-type", required=True, choices=("deb", "rpm", "appimage"))
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--hold-seconds", type=int, default=0)
    parser.add_argument("--artifact", type=Path, help="Exact installer to bind to this acceptance run")
    parser.add_argument("--artifact-sha256", help="Expected installer hash, obtained before installation")
    parser.add_argument("--expected-build-number", help="Expected status.build.buildNumber")
    args = parser.parse_args()
    if bool(args.artifact) != bool(args.artifact_sha256):
        parser.error("--artifact and --artifact-sha256 must be supplied together")
    args.evidence.mkdir(parents=True, exist_ok=False)
    repo = Path(__file__).resolve().parent.parent
    token, port = secrets.token_hex(32), None

    def request(path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/{path}", data=data,
            headers={"X-JudgeDesk-Session": token, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as response:
            return response.read().decode()

    def save(name, value):
        (args.evidence / name).write_text(json.dumps(value, indent=2), encoding="utf-8")

    def digest(path):
        value = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                value.update(block)
        return value.hexdigest()

    identity = {"artifactBound": False, "app": str(args.app.resolve()),
                "osRelease": Path("/etc/os-release").read_text(),
                "kernel": os.uname().release}
    if args.artifact:
        actual = digest(args.artifact)
        if actual != args.artifact_sha256:
            raise RuntimeError(f"Installer SHA-256 mismatch: {actual}")
        identity.update(artifact=str(args.artifact.resolve()), sha256=actual)
        if args.bundle_type == "appimage":
            if args.app.resolve() != args.artifact.resolve():
                raise RuntimeError("AppImage launch path must be the verified installer")
        else:
            if args.app.resolve() != Path("/usr/bin/themis-v2").resolve():
                raise RuntimeError("Installed package acceptance must launch /usr/bin/themis-v2")
            installed = {}
            with tempfile.TemporaryDirectory(prefix="jd-installed-identity-") as temporary:
                extracted = Path(temporary)
                if args.bundle_type == "deb":
                    subprocess.run(["dpkg-deb", "--extract", str(args.artifact.resolve()), str(extracted)], check=True)
                else:
                    subprocess.run(["rpm", "--checksig", str(args.artifact.resolve())], check=True)
                    archive = extracted / "payload.tar"
                    with args.artifact.open("rb") as source, archive.open("wb") as output:
                        subprocess.run(["rpm2archive", "--nocompression", "-"], stdin=source, stdout=output, check=True)
                    subprocess.run(["tar", "--no-same-owner", "-xf", str(archive), "-C", str(extracted)], check=True)
                for prefix in ("usr/bin", "usr/lib/JudgeDesk"):
                    for source in sorted((extracted / prefix).rglob("*")):
                        if source.is_file() and not source.is_symlink():
                            relative = source.relative_to(extracted)
                            expected = digest(source)
                            if digest(Path("/") / relative) != expected:
                                raise RuntimeError(f"Installed payload differs from candidate: {relative}")
                            installed[str(relative)] = expected
            if "usr/bin/themis-v2" not in installed:
                raise RuntimeError("Installer did not contain the application executable")
            identity["installedPayloads"] = installed
        identity["artifactBound"] = True
    save("candidate-identity.json", identity)

    with tempfile.TemporaryDirectory(prefix="jd-package-smoke-") as temporary:
        work = Path(temporary)
        contestants, tests = work / "contestants", work / "tests"
        (tests / "A/01").mkdir(parents=True)
        (tests / "A/01/A.inp").write_text("10 32\n")
        (tests / "A/01/A.out").write_text("42\n")
        (tests / "A/Config.cfg").write_text(json.dumps({"useStdIO": True, "memoryLimit": 512, "timeLimit": 3}))
        sources = {
            "cpp": ("cpp", "#include <bits/stdc++.h>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b;}"),
            "c": ("c", "#include <stdio.h>\nint main(){int a,b;scanf(\"%d%d\",&a,&b);printf(\"%d\",a+b);}"),
            "python": ("py", "a,b=map(int,input().split());print(a+b)\n"),
            "pascal": ("pas", "var a,b:longint; begin readln(a,b); writeln(a+b); end.\n"),
            "java": ("java", "import java.util.*; public class A { public static void main(String[] args){ Scanner s=new Scanner(System.in); System.out.println(s.nextInt()+s.nextInt()); }}\n"),
        }
        for language, (extension, source) in sources.items():
            destination = contestants / language
            destination.mkdir(parents=True)
            (destination / f"A.{extension}").write_text(source)
        scratch = repo / "server/test-fixtures/corpus/static/scratch_ac"
        shutil.copytree(scratch / "tests", tests / "Scratch/tests")
        shutil.copyfile(scratch / "Config.cfg", tests / "Scratch/Config.cfg")
        (contestants / "scratch").mkdir()
        shutil.copyfile(scratch / "project.sb3", contestants / "scratch/Scratch.sb3")
        environment = os.environ.copy()
        graphics_keys = ("GDK_BACKEND", "WEBKIT_DISABLE_COMPOSITING_MODE", "WEBKIT_DISABLE_DMABUF_RENDERER", "LIBGL_ALWAYS_SOFTWARE", "LD_PRELOAD", "LD_LIBRARY_PATH")
        for key in graphics_keys:
            environment.pop(key, None)
        environment.update(XDG_DATA_HOME=str(work / "data"), THEMIS_APP_DATA_DIR=str(work / "appdata"), JUDGEDESK_API_TOKEN=token)
        save("launch-environment.json", {key: environment.get(key) for key in (*graphics_keys, "DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE")})
        unit = f"judgedesk-smoke-{token[:12]}.scope"
        control_group = None
        with (args.evidence / "app.log").open("w") as log:
            process = subprocess.Popen(["systemd-run", "--user", "--scope", "--unit", unit, "-p", "Delegate=yes", str(args.app.resolve())], env=environment, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(300):
                    text = (args.evidence / "app.log").read_text(errors="replace")
                    match = re.search(r"Pure Rust Native Core running directly on port (\d+)", text)
                    if match:
                        port = int(match.group(1))
                        break
                    if process.poll() is not None:
                        raise RuntimeError(f"Application exited: {text}")
                    time.sleep(0.1)
                assert port is not None, "embedded server did not start"
                group = subprocess.check_output(["systemctl", "--user", "show", unit, "--property=ControlGroup", "--value"], text=True).strip()
                assert group.startswith("/") and group != "/", group
                control_group = Path("/sys/fs/cgroup") / group.lstrip("/")
                status = json.loads(request("status"))
                save("status.json", status)
                if args.expected_build_number and status["build"]["buildNumber"] != args.expected_build_number:
                    raise RuntimeError(f"Application build identity differs from candidate: {status['build']}")
                assert status["secureRunner"]["ready"], status
                distribution = json.loads(request("distribution"))
                save("distribution.json", distribution)
                assert distribution["bundleType"] == args.bundle_type, distribution
                for language in (*sources, "scratch"):
                    result = json.loads(request(f"toolchains/profiles/{language}/diagnose", {}))
                    save(f"diagnose-{language}.json", result)
                    assert result["success"] and result["diagnostic"]["phase"] == "execution", result
                completed = []
                for problem, selected in (("A", list(sources)), ("Scratch", ["scratch"])):
                    stream = request("batch-judge", {"thisinhPath": str(contestants), "testPath": str(tests), "targetContestants": selected, "targetProblems": [problem], "problemConfigs": {}, "jobId": f"package-smoke-{problem}"})
                    (args.evidence / f"judge-{problem}.ndjson").write_text(stream)
                    events = [json.loads(line) for line in stream.splitlines() if line.strip()]
                    assert any(event["type"] == "done" and event["data"]["success"] for event in events), events
                    rows = [event["data"] for event in events if event["type"] == "problem_completed"]
                    assert {row["contestant"] for row in rows} == set(selected), rows
                    for row in rows:
                        result = row["problemResult"]
                        assert result["compileStatus"] == "OK", row
                        assert result["testCases"] and all(case["status"] == "AC" for case in result["testCases"]), row
                    completed.extend(rows)
                save("judge-results.json", completed)
                print(f"Judging verified: {args.bundle_type}, six sandbox diagnostics and six AC submissions; port={port}", flush=True)
                if args.hold_seconds:
                    time.sleep(args.hold_seconds)
            finally:
                shutdown_error = None
                if port is not None:
                    try:
                        acknowledgement = json.loads(request("shutdown", {}))
                        assert acknowledgement["success"], acknowledgement
                    except (OSError, ValueError, KeyError, AssertionError) as error:
                        if process.poll() is None:
                            shutdown_error = error
                # /api/shutdown drains the backend; it does not close the Tauri
                # window. Check native descendants before terminating any GUI.
                def owned_pids():
                    pids = []
                    if control_group is not None and control_group.exists():
                        for processes in control_group.rglob("cgroup.procs"):
                            try:
                                pids.extend(processes.read_text().split())
                            except FileNotFoundError:
                                continue  # systemd may remove an emptied group.
                    return pids

                native_orphans = []
                for _ in range(50):
                    native_orphans = []
                    for pid in owned_pids():
                        try:
                            command = Path(f"/proc/{pid}/cmdline").read_bytes()
                        except FileNotFoundError:
                            continue
                        executable_name = Path(os.fsdecode(command.split(b"\0")[0])).name
                        # The application supervisor owns the window lifetime;
                        # the executor must already be gone after backend drain.
                        if executable_name.startswith("judgedesk-executor"):
                            native_orphans.append(pid)
                    if not native_orphans:
                        break
                    time.sleep(0.1)
                gui_terminated = process.poll() is None
                if gui_terminated:
                    subprocess.run(["systemctl", "--user", "kill", "--kill-who=all", "--signal=SIGTERM", unit], check=True)
                try:
                    exit_code = process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    subprocess.run(["systemctl", "--user", "kill", "--kill-who=all", "--signal=SIGTERM", unit], check=False)
                    process.wait(timeout=10)
                    raise RuntimeError("Application failed to drain after shutdown")
                assert exit_code in ((0, -15, 143) if gui_terminated else (0,)), f"Application exited with {exit_code}"
                # systemd-run may finish before an AppImage runtime/FUSE helper
                # has completed its own teardown. Require the whole scope to
                # drain within a fixed deadline, rather than sample it once.
                cleanup_started = time.monotonic()
                remaining = owned_pids()
                while remaining and time.monotonic() - cleanup_started < 10:
                    time.sleep(0.05)
                    remaining = owned_pids()
                save("shutdown.json", {"scope": unit, "exitCode": exit_code, "guiTerminated": gui_terminated, "shutdownError": None if shutdown_error is None else str(shutdown_error), "nativePidsAfterBackendDrain": native_orphans, "remainingPids": remaining})
                if shutdown_error is not None:
                    raise RuntimeError("Backend shutdown failed; owned scope cleaned up") from shutdown_error
                assert not native_orphans, f"Backend failed to drain native processes: {native_orphans}"
                assert not remaining, f"Orphan processes in owned scope: {remaining}"
        print(f"PASS: {args.bundle_type}, six sandbox diagnostics, six AC submissions, clean shutdown", flush=True)


if __name__ == "__main__":
    main()
