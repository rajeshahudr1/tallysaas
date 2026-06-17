"""Build the standalone Tally Cloud Sync Agent executable with PyInstaller.

Produces a single ``TallyCloudSyncAgent.exe`` from :mod:`sync_agent` so the
customer does not need a Python install. Run on a Windows machine that has the
project's dependencies installed.

Quick build (manual)
---------------------
    pip install pyinstaller
    pyinstaller --onefile --name TallyCloudSyncAgent sync_agent.py

…or just run this script, which does the same with sensible flags and a few
pre-flight checks:

    python build_exe.py

The resulting binary lands in ``dist/TallyCloudSyncAgent.exe``.

Auto-start at logon
-------------------
The agent is meant to run whenever the customer logs in. Two common ways:

1. Startup-folder shortcut (simplest):
   - Press Win+R, type ``shell:startup``, press Enter.
   - Drop a shortcut to ``dist\\TallyCloudSyncAgent.exe`` into that folder.
   - It launches automatically at every logon.

2. Task Scheduler (more robust — survives without an open console, can
   restart on failure). Create a logon-triggered task:

       schtasks /Create /TN "TallyCloudSyncAgent" ^
           /TR "C:\\TallyAgent\\TallyCloudSyncAgent.exe" ^
           /SC ONLOGON /RL HIGHEST /F

   Remove it later with:

       schtasks /Delete /TN "TallyCloudSyncAgent" /F

Notes
-----
* ``config.ini`` and the ``logs/`` directory are created/read next to the
  executable's working directory — ship ``config.example.ini`` alongside the
  exe and have the customer copy + edit it (set ``api_url`` + ``license_key``).
* For a true Windows *service* (no logged-in user), install ``pywin32`` and
  wrap the agent in a service shim — out of scope for this one-file build.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path


APP_NAME = "TallyCloudSyncAgent"
ENTRY_SCRIPT = "sync_agent.py"


def _stamp_version(version: str) -> bool:
    """Stamp ``version`` into config so the built exe reports the new version.

    The reported agent_version has TWO sources that must agree:
      • config.example.ini  [agent] agent_version=  (shipped beside the exe; the
        customer copies it to config.ini)
      • config.py           _DEFAULT_AGENT_VERSION   (the fallback when config.ini
        omits agent_version — and what a fresh install reports)

    Both are rewritten here so a release built with ``python build_exe.py
    --version 1.0.1`` reports v1.0.1 in its heartbeat (which the cloud compares
    against the published agent_releases.version). Returns True on success.
    """
    here = Path(__file__).resolve().parent
    ok = True

    ini = here / "config.example.ini"
    try:
        text = ini.read_text(encoding="utf-8")
        new = re.sub(r"(?m)^(agent_version\s*=).*$", r"\g<1>" + version, text)
        if new != text:
            ini.write_text(new, encoding="utf-8")
            print(f"Stamped agent_version={version} into config.example.ini")
    except OSError as exc:
        print(f"Could not stamp config.example.ini: {exc}")
        ok = False

    cfg = here / "config.py"
    try:
        text = cfg.read_text(encoding="utf-8")
        new = re.sub(r'(?m)^(_DEFAULT_AGENT_VERSION\s*=\s*").*(")\s*$',
                     r"\g<1>" + version + r"\g<2>", text)
        if new != text:
            cfg.write_text(new, encoding="utf-8")
            print(f"Stamped _DEFAULT_AGENT_VERSION = \"{version}\" into config.py")
    except OSError as exc:
        print(f"Could not stamp config.py: {exc}")
        ok = False

    return ok


def _ensure_pyinstaller() -> bool:
    """Return True if PyInstaller is importable, else print guidance."""
    try:
        import PyInstaller  # noqa: F401  (import is the check)
        return True
    except ImportError:
        print("PyInstaller is not installed. Install it with:")
        print("    pip install pyinstaller")
        return False


def _ensure_entry_script() -> bool:
    """Verify the entry script exists next to this builder."""
    script = Path(__file__).resolve().parent / ENTRY_SCRIPT
    if not script.exists():
        print(f"Entry script not found: {script}")
        return False
    return True


def build() -> int:
    """Invoke PyInstaller to produce the one-file executable.

    Returns a process exit code (0 on success).
    """
    if not _ensure_entry_script():
        return 1
    if not _ensure_pyinstaller():
        return 1

    here = Path(__file__).resolve().parent
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--onefile",
        "--name",
        APP_NAME,
        "--clean",
        "--noconfirm",
        # The agent imports its siblings as top-level modules; ensure they are
        # collected even if PyInstaller's static analysis misses one.
        "--hidden-import",
        "config",
        "--hidden-import",
        "logger",
        "--hidden-import",
        "api_client",
        "--hidden-import",
        "tally_connector",
        str(here / ENTRY_SCRIPT),
    ]

    print("Running:", " ".join(cmd))
    try:
        result = subprocess.run(cmd, cwd=str(here), check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"Build failed to start: {exc}")
        return 1

    if result.returncode != 0:
        print(f"PyInstaller exited with code {result.returncode}.")
        return result.returncode

    exe = here / "dist" / f"{APP_NAME}.exe"
    if exe.exists():
        print(f"\nBuild complete: {exe}")
        # Place a starter config next to the exe for convenience.
        example = here / "config.example.ini"
        if example.exists():
            try:
                shutil.copy2(example, here / "dist" / "config.example.ini")
                print(f"Copied config.example.ini next to the exe.")
            except OSError:
                pass
        print("\nNext: copy config.example.ini -> config.ini beside the exe,")
        print("      set api_url + license_key, then run the exe once to activate.")
    else:
        print("Build reported success but the exe was not found.")
        return 1

    return 0


def main(argv: list[str] | None = None) -> int:
    """CLI: optionally stamp a release version, then build the exe.

    Usage:
        python build_exe.py                  Build with the current version.
        python build_exe.py --version 1.0.1  Stamp v1.0.1 into config, then build.

    After building, the operator drops dist/TallyCloudSyncAgent.exe into the
    server's AGENT_RELEASE_DIR and publishes its version (POST
    /super-admin/agent-release) so agents auto-update to it.
    """
    args = list(sys.argv[1:] if argv is None else argv)
    version = None
    i = 0
    while i < len(args):
        if args[i] in ("--version", "-v") and i + 1 < len(args):
            version = args[i + 1].strip()
            i += 2
            continue
        i += 1

    if version:
        if not re.match(r"^\d+(\.\d+){0,3}([.\-].+)?$", version):
            print(f"Refusing to stamp a non-version-looking value: {version!r}")
            return 1
        _stamp_version(version)

    return build()


if __name__ == "__main__":
    sys.exit(main())
