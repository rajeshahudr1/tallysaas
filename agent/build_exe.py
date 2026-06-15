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

import shutil
import subprocess
import sys
from pathlib import Path


APP_NAME = "TallyCloudSyncAgent"
ENTRY_SCRIPT = "sync_agent.py"


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


if __name__ == "__main__":
    sys.exit(build())
