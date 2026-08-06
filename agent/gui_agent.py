"""Professional tkinter GUI for the Teloora Agent (the windowed exe).

This is the SINGLE entry point of the new windowed (no-console) build. It is a
thin, self-installing front end over the EXISTING sync engine in
:mod:`sync_agent` - it never duplicates the heartbeat / push / pull logic. It
calls :func:`sync_agent.run_sync_loop` (a daemon thread) and reuses
:class:`config.Config`, :class:`api_client.ApiClient`, :func:`logger.get_logger`
and the Tally-exe finder verbatim.

Two views, chosen at startup:

* SETUP wizard - shown on FIRST run (the exe is running from a download/temp
  location with no activated ``config.ini`` next to it). The operator enters the
  license key + install folder + settings; [Install] verifies the key against
  the cloud, creates ``C:\\TallyCloudSync`` (or the chosen folder), COPIES the
  running exe there, writes ``config.ini`` with the returned agent token, sets up
  a hidden Startup launcher + Start-Menu shortcut, then offers to open the
  Dashboard (relaunching the INSTALLED exe).

* DASHBOARD - shown when the exe is running from an install dir that already has
  an activated ``config.ini`` (a non-empty ``agent_token``). Live status,
  editable settings, Start / Stop, Sync-now, Open-logs and Uninstall.

THREADING: the sync loop runs in a daemon thread (``run_sync_loop``). That thread
NEVER touches a tkinter widget - it pushes status dicts onto a
:class:`queue.Queue`, and the GUI drains the queue on the Tk main thread via
``root.after(...)``. A :class:`threading.Event` stops the loop. A single-instance
file lock makes a second launch focus the first window instead of double-syncing.

Dependencies: Python stdlib + ``requests`` only. ``tkinter`` is stdlib.
``pystray`` + ``Pillow`` are OPTIONAL (import-guarded) for a real tray icon; when
absent the window just hides (``withdraw``) and re-launching the exe re-shows it.
ASCII-only throughout so it renders on any Windows console / font.
"""

from __future__ import annotations

import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import traceback
from typing import Optional

# When this module started importing. Startup timings are logged against it so a
# slow launch can be attributed — unpacking, imports, or the app's own work —
# from a customer's log file instead of a guess.
_IMPORT_STARTED = time.perf_counter()

# Brand name — single source of truth (constants.py). Imported first (constants
# has no deps) so even the tkinter-missing fallback dialog below can use it.
from constants import BRAND_NAME, AGENT_UI_URL, SUPPORT_EMAIL

# tkinter is stdlib; import-guard only so a broken Tcl/Tk install fails with a
# clear message instead of a bare traceback in a windowed (no-console) process.
try:
    import tkinter as tk
    from tkinter import ttk, filedialog, messagebox
except Exception as _exc:  # pragma: no cover - only on a broken Python build.
    # No console to print to in a windowed exe; surface via a native dialog.
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(
            0, "tkinter (Tcl/Tk) is not available: " + str(_exc),
            BRAND_NAME, 0x10)
    except Exception:
        pass
    raise

# Engine + helpers - REUSED, never re-implemented.
from config import Config, machine_fingerprint
from logger import get_logger
import sync_agent


APP_TITLE = BRAND_NAME

# Palette + type scale live in ui_theme (the "Ledger" design system). They are
# re-exported under the original names so the view code below — which predates
# the theme — keeps working unchanged.
#
# The colours are ledger-ink rather than the blue/slate every other sync utility
# uses: ink-green chrome, warm paper, an amber audit stamp for attention and an
# oxide red for a variance. See ui_theme for the reasoning.
import ui_theme
import ui_signin
import ui_splash
import ui_dashboard
from ui_theme import (          # noqa: F401  (re-exported for the views)
    BRAND, BRAND_DEEP, BG, CARD, TXT, SUB, BORDER,
    OK_GREEN, BAD_RED, WARN_AMBER,
    INK, PAPER, SHEET, RULE, TEXT, MUTED, STAMP, POSTED, VARIANCE,
    FONT_BODY, FONT_TITLE, FONT_DISPLAY, FONT_SMALL, FONT_EYEBROW,
    FONT_DATA, FONT_DATA_BIG, FONT_DATA_SM,
    SPACE_TIGHT, SPACE_ITEM, SPACE_GROUP, SPACE_BLOCK, SPACE_SECTION, SPACE_PAGE,
)

# IDENTITY — deliberately NOT rebranded. These are the on-disk names an
# existing install already uses (exe filename, startup script, install
# folder). Renaming any of them would make an updated build unable to find /
# recognise a machine's existing installation (duplicate install at best, an
# orphaned config at worst). Only SHORTCUT_NAME (cosmetic, recreated on every
# install/update) follows the brand.
INSTALLED_EXE_NAME = "TallyCloudSync.exe"
STARTUP_VBS_NAME = "TallyCloudSync.vbs"
SHORTCUT_NAME = f"{BRAND_NAME}.lnk"
DEFAULT_INSTALL_DIR = r"C:\TallyCloudSync"

# Bounds on the sync interval, enforced wherever it is set or read.
#
# TallyPrime answers the agent by compiling and evaluating TDL, on the same
# process the customer is typing into. A short interval does not just cost
# bandwidth — it keeps a desktop application busy, and a request that lands
# while it is recalculating is the one that ends in an error box. Thirty
# seconds is the floor the engine and the Settings page BOTH honour, so a
# hand-edited config.ini cannot get past what the UI refuses.
MIN_SYNC_INTERVAL = 30
MAX_SYNC_INTERVAL = 6 * 3600
# IDENTITY — deliberately NOT rebranded (see note above INSTALLED_EXE_NAME):
# a lock filename that changed on update would let two copies run at once.
LOCK_FILENAME = "tally_cloud_sync.lock"

# Files that travel WITH the exe into the install folder (best-effort; the exe
# is fully self-contained, these are just nice-to-haves when running from source
# or for the operator to inspect). Missing ones are skipped silently.
_SIDE_FILES = ("config.example.ini", "README.md")


# --------------------------------------------------------------------------- #
# Frozen / path helpers
# --------------------------------------------------------------------------- #
def running_frozen() -> bool:
    """True when running as the PyInstaller one-file exe (not a .py)."""
    return bool(getattr(sys, "frozen", False))


def exe_path() -> str:
    """Absolute path of the running executable (the frozen exe, or python.exe)."""
    return os.path.abspath(sys.executable)


def _close_splash() -> None:
    """Dismiss the PyInstaller boot splash, if this build has one.

    ``pyi_splash`` exists ONLY inside a --splash frozen build: running from
    source, or from a build without one, the import simply fails and there is
    nothing to close. Every call is guarded because a splash that will not close
    must never be the reason the app fails to start — the worst acceptable
    outcome is a splash that lingers, not a window that never opens.
    """
    try:
        import pyi_splash                                   # noqa: PLC0415
    except Exception:                                       # noqa: BLE001
        return
    try:
        pyi_splash.close()
    except Exception:                                       # noqa: BLE001
        pass


def app_dir() -> str:
    """Directory the app should treat as 'home' for config.ini + logs.

    Frozen: the folder the exe lives in (so an INSTALLED exe reads the config
    that was written next to it). From source: this file's directory.
    """
    if running_frozen():
        return os.path.dirname(exe_path())
    return os.path.dirname(os.path.abspath(__file__))


def config_path() -> str:
    """Absolute path to the config.ini this instance reads/writes."""
    return os.path.join(app_dir(), "config.ini")


def icon_path() -> Optional[str]:
    """The app icon, resolved in the ONE place that knows where assets live.

    Delegates to ui_signin so the icon has a single source: the main window,
    the splash and every dialog all end up with the same file, and changing it
    is one edit rather than a hunt for whoever hard-coded a second copy.
    """
    return ui_signin.asset(ui_signin.ICON_FILE) or None


def startup_dir() -> str:
    """The current user's Startup folder (where the hidden launcher VBS goes)."""
    return os.path.join(
        os.environ.get("APPDATA", ""),
        "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
    )


def start_menu_programs_dir() -> str:
    """The current user's Start Menu Programs folder (for the .lnk shortcut)."""
    return os.path.join(
        os.environ.get("APPDATA", ""),
        "Microsoft", "Windows", "Start Menu", "Programs",
    )


def desktop_dir() -> str:
    """Best-effort path to the user's Desktop (for an optional shortcut)."""
    return os.path.join(os.path.expanduser("~"), "Desktop")


# --------------------------------------------------------------------------- #
# Installed-vs-setup detection
# --------------------------------------------------------------------------- #
def load_config_safe() -> Config:
    """Load Config from THIS instance's directory, never raising.

    The GUI must come up even with a missing/corrupt config (it just shows
    Setup). On any error a fresh default Config is returned.
    """
    try:
        return Config.load(config_path())
    except Exception:
        cfg = Config(config_path())
        return cfg


def is_activated(cfg: Config) -> bool:
    """True when this directory holds an activated config (non-empty token)."""
    try:
        return bool(cfg.get_token())
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# Finding an EXISTING install (so a freshly downloaded exe updates it)
# --------------------------------------------------------------------------- #
# The exe decides Setup-vs-Dashboard from where IT is running: the installed copy
# sits next to an activated config.ini, a downloaded one does not. That is right
# for a first install and wrong for every one after it — a customer who
# downloads a new build gets the full wizard and is asked for a licence key the
# machine already has, on top of an install that is working.
#
# So the install records WHERE it went, and a later exe looks that up. Registry
# first (it survives a custom folder), then the default folder, and a candidate
# only counts when it really holds an activated install — a leftover registry
# value from an uninstall must not send a first-time customer into "update" mode
# for something that is not there.
# IDENTITY — deliberately NOT rebranded: an existing install's registry value
# lives under this key, and changing it would orphan every machine already
# activated (see note above INSTALLED_EXE_NAME).
REG_SUBKEY = r"Software\TallyCloudSync"
REG_VALUE_INSTALL_DIR = "InstallDir"


def remember_install_dir(install_dir: str) -> bool:
    """Record the install folder in HKCU so a later exe can find it.

    HKCU, not HKLM: setup runs unelevated, and this is a per-user pointer, not a
    system registration. Best-effort — a machine with a locked-down registry
    still installs fine, it just falls back to the default-folder probe.
    """
    try:
        import winreg                                   # noqa: PLC0415 (Windows-only)
    except ImportError:
        return False
    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, REG_SUBKEY, 0,
                                winreg.KEY_WRITE) as key:
            winreg.SetValueEx(key, REG_VALUE_INSTALL_DIR, 0, winreg.REG_SZ,
                              os.path.abspath(install_dir))
        return True
    except Exception:                                   # noqa: BLE001
        return False


def forget_install_dir() -> None:
    """Drop the pointer on uninstall, so a later exe offers a fresh install."""
    try:
        import winreg                                   # noqa: PLC0415
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_SUBKEY, 0,
                            winreg.KEY_WRITE) as key:
            winreg.DeleteValue(key, REG_VALUE_INSTALL_DIR)
    except Exception:                                   # noqa: BLE001
        pass


def _read_remembered_install_dir() -> str:
    try:
        import winreg                                   # noqa: PLC0415
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_SUBKEY) as key:
            val, _kind = winreg.QueryValueEx(key, REG_VALUE_INSTALL_DIR)
        return str(val or "").strip()
    except Exception:                                   # noqa: BLE001
        return ""


def _is_activated_install(candidate: str) -> bool:
    """True when ``candidate`` holds a REAL, activated install.

    Both halves matter. The exe alone could be a copy someone pasted into a
    folder; the config alone could be left behind by an uninstall that removed
    the binary. Only the pair means "there is a working install here".
    """
    if not candidate:
        return False
    try:
        d = os.path.abspath(candidate)
        if not os.path.isfile(os.path.join(d, INSTALLED_EXE_NAME)):
            return False
        ini = os.path.join(d, "config.ini")
        if not os.path.isfile(ini):
            return False
        return is_activated(Config.load(ini))
    except Exception:                                   # noqa: BLE001
        return False


def find_existing_install(skip_dir: Optional[str] = None) -> str:
    """The folder of an activated install on this machine, or "".

    ``skip_dir`` is ignored as a candidate — the caller passes its own directory
    so an exe already running from the install does not "find itself" and try to
    update in place from itself onto itself.
    """
    # Wholly defensive: this runs while the window is being chosen, so ANY
    # exception here would stop the app from opening at all. "I could not find
    # one" is always a safe answer — it just means the wizard.
    try:
        skip = os.path.normcase(os.path.abspath(skip_dir)) if skip_dir else None
    except Exception:                                       # noqa: BLE001
        skip = None
    try:
        remembered = _read_remembered_install_dir()
    except Exception:                                       # noqa: BLE001
        remembered = ""
    for cand in (remembered, DEFAULT_INSTALL_DIR):
        try:
            if not cand:
                continue
            if skip and os.path.normcase(os.path.abspath(cand)) == skip:
                continue
            if _is_activated_install(cand):
                return os.path.abspath(cand)
        except Exception:                                   # noqa: BLE001
            continue
    return ""


# --------------------------------------------------------------------------- #
# Single-instance lock (so a second launch focuses the first window)
# --------------------------------------------------------------------------- #
class SingleInstance:
    """A best-effort single-instance guard backed by a lock file + a TCP port.

    Strategy (no pywin32): bind a localhost socket on a fixed port. The first
    instance binds successfully and OWNS it; a second instance fails to bind,
    learns 'someone is already running', and exits (the user double-launched).
    The lock FILE additionally records the owner pid for diagnostics. Everything
    is best-effort: if locking fails for any reason we let the app run rather
    than block the user out.
    """

    # A fixed, high, unlikely-to-clash loopback port acts as the named mutex.
    _PORT = 50573

    def __init__(self) -> None:
        self._sock = None
        self._lock_file = os.path.join(app_dir(), LOCK_FILENAME)

    def acquire(self) -> bool:
        """Try to become the single instance. True = we own it, False = another."""
        import socket
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
            sock.bind(("127.0.0.1", self._PORT))
            sock.listen(1)
            self._sock = sock
        except OSError:
            return False  # another instance already holds the port.
        except Exception:
            return True   # locking unavailable -> do not block the user.
        try:
            with open(self._lock_file, "w", encoding="ascii") as fh:
                fh.write(str(os.getpid()))
        except OSError:
            pass
        return True

    def release(self) -> None:
        """Release the lock socket + remove the lock file (best-effort)."""
        try:
            if self._sock is not None:
                self._sock.close()
        except Exception:
            pass
        try:
            if os.path.exists(self._lock_file):
                os.remove(self._lock_file)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Auto-start launcher + Start-Menu shortcut (reuses the run-hidden VBS pattern)
# --------------------------------------------------------------------------- #
def write_startup_vbs(installed_exe: str) -> Optional[str]:
    """Write the hidden Startup launcher VBS pointing at ``installed_exe``.

    Mirrors install-autostart.ps1: a tiny VBS in the user's Startup folder that
    launches the INSTALLED exe HIDDEN (window style 0, don't-wait) every logon.
    Returns the VBS path on success, else None. Never raises.
    """
    try:
        sdir = startup_dir()
        os.makedirs(sdir, exist_ok=True)
        vbs_path = os.path.join(sdir, STARTUP_VBS_NAME)
        here = os.path.dirname(installed_exe)
        lines = [
            'Set sh = CreateObject("WScript.Shell")',
            'sh.CurrentDirectory = "' + here + '"',
            'sh.Run """' + installed_exe + '""", 0, False',
        ]
        with open(vbs_path, "w", encoding="ascii", errors="replace") as fh:
            fh.write("\r\n".join(lines) + "\r\n")
        return vbs_path
    except Exception:
        return None


def remove_startup_vbs() -> None:
    """Remove the Startup launcher VBS, if present (best-effort)."""
    try:
        vbs_path = os.path.join(startup_dir(), STARTUP_VBS_NAME)
        if os.path.exists(vbs_path):
            os.remove(vbs_path)
    except OSError:
        pass


def create_shortcut(installed_exe: str, lnk_path: str) -> bool:
    """Create a Windows .lnk shortcut to ``installed_exe`` via a throwaway VBS.

    pywin32 is not available, so we generate a tiny VBS that uses
    ``WScript.Shell.CreateShortcut`` (built into Windows) and run it with
    ``cscript`` hidden. Returns True if the .lnk ended up on disk. Never raises.
    """
    if os.name != "nt":
        return False
    try:
        os.makedirs(os.path.dirname(lnk_path), exist_ok=True)
    except OSError:
        return False
    work_dir = os.path.dirname(installed_exe)
    # A temp VBS that creates the shortcut, then is deleted.
    import tempfile
    vbs_fd, vbs_tmp = tempfile.mkstemp(suffix=".vbs")
    try:
        script = (
            'Set sh = CreateObject("WScript.Shell")\r\n'
            'Set lnk = sh.CreateShortcut("' + lnk_path + '")\r\n'
            'lnk.TargetPath = "' + installed_exe + '"\r\n'
            'lnk.WorkingDirectory = "' + work_dir + '"\r\n'
            f'lnk.Description = "{APP_TITLE}"\r\n'
            'lnk.IconLocation = "' + installed_exe + ', 0"\r\n'
            'lnk.Save\r\n'
        )
        with os.fdopen(vbs_fd, "w", encoding="ascii", errors="replace") as fh:
            fh.write(script)
        flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
        subprocess.run(["cscript", "//nologo", vbs_tmp],
                       creationflags=flags, timeout=20, check=False)
        return os.path.exists(lnk_path)
    except Exception:
        return False
    finally:
        try:
            if os.path.exists(vbs_tmp):
                os.remove(vbs_tmp)
        except OSError:
            pass


def remove_shortcuts() -> None:
    """Remove the Start-Menu + Desktop shortcuts, if present (best-effort)."""
    for d in (start_menu_programs_dir(), desktop_dir()):
        try:
            p = os.path.join(d, SHORTCUT_NAME)
            if os.path.exists(p):
                os.remove(p)
        except OSError:
            pass


def _is_lock_error(exc: BaseException) -> bool:
    """True when ``exc`` is Windows' "file is in use by another process".

    Checked by winerror (32) rather than by message, since the text is
    localised. Any OTHER OSError — no space, bad path, read-only media — is a
    real failure the retry loop must NOT swallow.
    """
    return isinstance(exc, OSError) and getattr(exc, "winerror", None) == 32 \
        or isinstance(exc, PermissionError)


def copy_over_running_exe(src: str, dst: str, stop_fn, append,
                          copy_fn=None, sleep_fn=None, tries: int = 6) -> None:
    """Copy ``src`` onto ``dst``, stopping the background syncer if it holds it.

    Re-running setup on a machine that is ALREADY installed means the Windows
    service is running the very exe the copy must overwrite, and Windows answers
    with WinError 32. The customer sees "Install failed" for something they
    cannot act on — the fix is not to warn them, it is to stop the syncer (which
    setup is about to reconfigure and restart anyway) and copy again.

    The service releases the file asynchronously after the stop returns, so the
    retry polls rather than assuming: waiting on the CONDITION, not on a guessed
    delay. Stopping only happens if the first copy actually fails, so the normal
    first install never touches the service.

    Raises
    ------
    RuntimeError
        The file is still locked after the retries — with a message naming the
        cause and the file, since a bare Windows code tells the customer nothing.
    """
    copy_fn = copy_fn or shutil.copy2
    sleep_fn = sleep_fn or time.sleep
    try:
        copy_fn(src, dst)
        return
    except Exception as exc:
        if not _is_lock_error(exc):
            raise
    append("[..] The background syncer is using the app file - stopping it "
           "(accept the administrator prompt if one appears)...")
    try:
        stop_fn()
    except Exception:
        pass                      # a stop we could not perform is not fatal yet.
    for attempt in range(tries):
        try:
            copy_fn(src, dst)
            return
        except Exception as exc:
            if not _is_lock_error(exc):
                raise
            sleep_fn(1.0)
    raise RuntimeError(
        "The agent is still running and holding " + dst + ".\n\n"
        "This usually means the administrator prompt was declined. Run this "
        "app again and accept it, or restart the computer and run it before "
        "opening anything else.")


def file_is_locked(path: str) -> bool:
    """True when ``path`` exists and something else has it open for writing.

    The single question the update actually needs answered. Asked directly
    rather than inferred from whether a stop "worked", because a stop that
    returns success and a file that is still held is exactly the case that used
    to end in "Update failed" with nothing left to try.
    """
    if not path or not os.path.isfile(path):
        return False
    try:
        with open(path, "r+b"):
            return False
    except PermissionError:
        return True
    except OSError:
        return True


def _kill_agent_processes_script(install_dir: str) -> str:
    """PowerShell that ends agent processes belonging to ``install_dir``.

    Two groups are targeted:

    * those whose image path is INSIDE the install folder — the ordinary case
      (a Dashboard left open, or the hidden Startup launcher);
    * those with the agent's image name whose path CANNOT BE READ. A process
      running as LocalSystem — which is what the Windows service is — reports an
      empty path to an ordinary user, so filtering on "path starts with the
      install folder" skipped the one process that most often holds the file.
      The name is ours, so an unreadable one is still ours.

    This process and its PyInstaller parent are always excluded: they share the
    image name, and killing them would end the updater mid-copy.
    """
    target = os.path.normcase(os.path.abspath(install_dir or ""))
    skip = {os.getpid(), os.getppid()}
    skip_list = ",".join(str(p) for p in sorted(skip) if p)
    return (
        "$t = '" + target.replace("'", "''") + "'.ToLower(); "
        "$skip = @(" + (skip_list or "0") + "); "
        "$n = 0; "
        "Get-CimInstance Win32_Process -Filter \"Name='"
        + INSTALLED_EXE_NAME.replace("'", "''") + "'\" | "
        "Where-Object { $skip -notcontains $_.ProcessId -and "
        "( [string]::IsNullOrEmpty($_.ExecutablePath) -or "
        "$_.ExecutablePath.ToLower().StartsWith($t) ) } | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force "
        "-ErrorAction SilentlyContinue; $n++ }; "
        "Write-Output $n")


def stop_processes_in(install_dir: str) -> int:
    """End agent processes belonging to ``install_dir``. Returns how many.

    Runs unelevated first; see :func:`stop_processes_in_elevated` for the
    SYSTEM-owned case, which an ordinary user is not allowed to touch.
    """
    if os.name != "nt":
        return 0
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             _kill_agent_processes_script(install_dir)],
            capture_output=True, text=True, timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return int((out.stdout or "0").strip().splitlines()[-1] or 0)
    except Exception:                                       # noqa: BLE001
        return 0


def stop_processes_in_elevated(install_dir: str) -> bool:
    """The same kill, with admin — one UAC prompt.

    Needed because the Windows service runs as LocalSystem: a user-level
    Stop-Process on it is refused, the exe stays locked, and the update dies
    with a message telling the customer to stop a service that the Services
    console already reports as stopped.
    """
    if os.name != "nt":
        return False
    script = _kill_agent_processes_script(install_dir)
    params = ("-NoProfile -NonInteractive -WindowStyle Hidden -Command \""
              + script.replace('"', '\\"') + "\"")
    try:
        return _run_elevated_program("powershell.exe", params, wait=True)
    except Exception:                                       # noqa: BLE001
        return False


def stop_background_syncer(install_dir: str = "") -> bool:
    """Stop whatever is running the installed agent, so its exe can be replaced.

    Two things can hold it and BOTH are handled: the Windows service, and any
    process started from the install folder (the Startup-folder launcher, or a
    Dashboard the customer left open). Tries the no-UAC service stop first
    (setup granted this account start/stop rights), then the elevated re-launch.
    Never raises — the caller retries the copy and reports honestly if the file
    is still held.
    """
    target = install_dir or DEFAULT_INSTALL_DIR
    exe = os.path.join(target, INSTALLED_EXE_NAME)
    stopped = False
    if service_installed():
        try:
            stopped = bool(service_direct("stop-service"))
        except Exception:
            stopped = False
        if not stopped:
            try:
                stopped = bool(run_elevated_verb("stop-service", wait=True,
                                                 timeout=60))
            except Exception:
                stopped = False
    # Even when the service stopped, a leftover launcher copy can still hold the
    # file — so this runs either way rather than as a fallback.
    killed = stop_processes_in(target)

    # THE TEST IS THE FILE, not whether a stop reported success. A service can
    # report Stopped to the SCM while its process is still alive and still
    # holding the exe; that process runs as LocalSystem, so only an elevated
    # kill can end it. One UAC prompt here is the difference between the update
    # working and the customer being told to stop something that already says
    # it is stopped.
    for _ in range(6):
        if not file_is_locked(exe):
            return True
        time.sleep(0.5)
    if file_is_locked(exe):
        stop_processes_in_elevated(target)
        for _ in range(10):
            if not file_is_locked(exe):
                return True
            time.sleep(0.5)
    return stopped or bool(killed)


def relaunch_installed(installed_exe: str) -> bool:
    """Launch the INSTALLED exe (which will detect its config and show Dashboard).

    Detached so it outlives this process. Returns True if the spawn succeeded.
    """
    try:
        flags = 0x00000008 if os.name == "nt" else 0  # DETACHED_PROCESS
        subprocess.Popen([installed_exe], cwd=os.path.dirname(installed_exe),
                         close_fds=True, creationflags=flags)
        return True
    except Exception:
        return False


# The detached cleanup batch the Uninstall flow drops to delete the install
# folder AFTER this exe (which lives inside it and so cannot delete itself) exits.
_CLEANUP_BAT = "_agent_uninstall.bat"


def _is_real_install_dir(install_dir: str) -> bool:
    """Guard: only treat ``install_dir`` as deletable when it is the REAL install
    folder of a FROZEN exe - never a dev/source checkout.

    Requires: running as the frozen exe; the dir is this exe's own folder; the
    installed exe is present in it; and it is an absolute path with a parent (so
    we never rmdir a drive root). Returns False for any source-run / odd path.
    """
    try:
        if not running_frozen():
            return False
        install_dir = os.path.abspath(install_dir)
        if os.path.normcase(install_dir) != os.path.normcase(app_dir()):
            return False
        # The install dir must actually hold the installed exe (sanity check).
        if not os.path.isfile(os.path.join(install_dir, INSTALLED_EXE_NAME)):
            # Fall back to the running exe's own name being inside it.
            if os.path.normcase(os.path.dirname(exe_path())) != \
                    os.path.normcase(install_dir):
                return False
        parent = os.path.dirname(install_dir)
        if not parent or os.path.normcase(parent) == os.path.normcase(install_dir):
            return False  # a drive root (e.g. C:\) has no real parent -> refuse.
        return True
    except Exception:
        return False


def _is_purgeable_install_dir(candidate: str) -> bool:
    """True when ``candidate`` is an install folder it is SAFE to delete.

    Unlike :func:`_is_real_install_dir` this does not require the folder to be
    the running exe's own — uninstall has to be able to remove
    ``C:\\TallyCloudSync`` while the customer is running the exe they
    downloaded. What it still requires is proof the folder is an install and
    not something else: the installed exe AND a config beside it, an absolute
    path with a real parent (never a drive root), and never the source tree.
    """
    try:
        if not running_frozen():
            return False                    # a dev checkout deletes nothing
        d = os.path.abspath(candidate or "")
        if not d or not os.path.isdir(d):
            return False
        parent = os.path.dirname(d)
        if not parent or os.path.normcase(parent) == os.path.normcase(d):
            return False                    # C:\ and friends
        if not os.path.isfile(os.path.join(d, INSTALLED_EXE_NAME)):
            return False
        if not os.path.isfile(os.path.join(d, "config.ini")):
            return False
        src = os.path.dirname(os.path.abspath(__file__))
        return os.path.normcase(d) != os.path.normcase(src)
    except Exception:                                       # noqa: BLE001
        return False


def installed_root() -> str:
    """The folder the agent was INSTALLED into, or "".

    Asked in the same order as :func:`find_existing_install` — what the install
    recorded, then the default location, then this exe's own folder — so
    uninstall removes the install even when it is driven from a copy of the exe
    sitting somewhere else entirely.
    """
    for cand in (_read_remembered_install_dir(), DEFAULT_INSTALL_DIR, app_dir()):
        try:
            if cand and _is_purgeable_install_dir(cand):
                return os.path.abspath(cand)
        except Exception:                                   # noqa: BLE001
            continue
    return ""


def spawn_folder_cleanup(install_dir: str, elevated: bool = False) -> bool:
    """Write + launch a DETACHED batch that removes the agent but KEEPS logs/.

    The running GUI exe lives INSIDE ``install_dir`` and cannot delete itself, so
    (mirroring the self-update swap) we drop a batch that: waits in a loop until
    this exe is no longer locked (we are exiting), deletes every file + subfolder
    in the install dir EXCEPT ``logs/`` (so the activity logs survive the
    uninstall for debugging), then deletes itself. Launched DETACHED with no
    window so it survives our exit, and from a TEMP copy so it is not sitting
    inside the folder it cleans.

    ``elevated`` -> launch the batch via ShellExecuteW(runas) (the folder is under
    a protected location like C:\\). Returns True if the batch was launched. Never
    deletes anything itself; all deletion happens in the detached batch AFTER the
    guard in the caller confirmed this is the real install dir.
    """
    if os.name != "nt":
        return False
    import tempfile
    # Drop the batch in TEMP (NOT inside install_dir, which it will delete).
    try:
        bat_fd, bat = tempfile.mkstemp(suffix=".bat", prefix="tcs_uninstall_")
    except Exception:
        return False
    # The unlock probe is the INSTALLED exe, always the one INSIDE the folder
    # being purged — never ``exe_path()``. It used to be the running exe, which
    # is the same file only when the uninstall is driven from the installed
    # copy. Uninstall from the downloaded exe instead and the batch deleted THAT
    # — the customer's own download vanished while C:\TallyCloudSync stayed put,
    # which is the exact opposite of what they asked for.
    exe = os.path.join(install_dir, INSTALLED_EXE_NAME)
    lines = [
        "@echo off",
        "setlocal",
        'set "DIR=' + install_dir + '"',
        'set "EXE=' + exe + '"',
        "rem Wait for the running agent to exit and release its exe, then purge",
        "rem the whole install folder. Deleting the exe succeeds only once the",
        "rem process has released it, so it doubles as the 'is it unlocked' probe.",
        "set /a tries=0",
        ":waitloop",
        'if not exist "%EXE%" goto purge',
        'del /F /Q "%EXE%" >nul 2>&1',
        'if not exist "%EXE%" goto purge',
        "set /a tries+=1",
        "if %tries% geq 60 goto purge",
        "ping -n 2 127.0.0.1 >nul",
        "goto waitloop",
        ":purge",
        "ping -n 2 127.0.0.1 >nul",
        "rem Remove the agent itself (exe + config.ini + .status.json + any",
        "rem service interop files) AND every subfolder EXCEPT logs/ - the user",
        "rem wants the activity logs to survive an uninstall for debugging.",
        'del /F /Q "%DIR%\\*.*" >nul 2>&1',
        'for /d %%D in ("%DIR%\\*") do if /I not "%%~nxD"=="logs" rd /s /q "%%D" >nul 2>&1',
        'del /F /Q "%~f0" >nul 2>&1',
    ]
    try:
        with os.fdopen(bat_fd, "w", encoding="ascii", errors="replace") as fh:
            fh.write("\r\n".join(lines) + "\r\n")
    except Exception:
        try:
            os.close(bat_fd)
        except Exception:
            pass
        return False
    if elevated:
        # Launch the batch elevated so rmdir can remove a folder under C:\.
        return _run_elevated_program("cmd.exe", '/c "%s"' % bat, wait=False)
    try:
        flags = 0x00000008 | 0x00000200 | 0x08000000  # DETACHED|NEW_GROUP|NO_WINDOW
        subprocess.Popen(["cmd.exe", "/c", bat], close_fds=True,
                         creationflags=flags)
        return True
    except Exception:
        return False


def _run_elevated_program(program: str, params: str, wait: bool = False) -> bool:
    """ShellExecuteW(runas) an arbitrary program+params (the UAC building block).

    Mirrors :func:`run_elevated_verb` but for a generic program (used to launch
    the cleanup batch elevated). Returns True if the elevated process launched.
    """
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:
        return False
    SEE_MASK_NOCLOSEPROCESS = 0x00000040
    SEE_MASK_NO_CONSOLE = 0x00008000

    class SHELLEXECUTEINFOW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("fMask", ctypes.c_ulong),
            ("hwnd", wintypes.HWND),
            ("lpVerb", wintypes.LPCWSTR),
            ("lpFile", wintypes.LPCWSTR),
            ("lpParameters", wintypes.LPCWSTR),
            ("lpDirectory", wintypes.LPCWSTR),
            ("nShow", ctypes.c_int),
            ("hInstApp", wintypes.HINSTANCE),
            ("lpIDList", ctypes.c_void_p),
            ("lpClass", wintypes.LPCWSTR),
            ("hkeyClass", wintypes.HKEY),
            ("dwHotKey", wintypes.DWORD),
            ("hIcon", wintypes.HANDLE),
            ("hProcess", wintypes.HANDLE),
        ]

    info = SHELLEXECUTEINFOW()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NO_CONSOLE
    info.hwnd = None
    info.lpVerb = "runas"
    info.lpFile = program
    info.lpParameters = params
    info.lpDirectory = None
    info.nShow = 0  # SW_HIDE
    try:
        ok = ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(info))
    except Exception:
        return False
    if not ok or not info.hProcess:
        return False
    if not wait:
        try:
            ctypes.windll.kernel32.CloseHandle(info.hProcess)
        except Exception:
            pass
        return True
    return True


# --------------------------------------------------------------------------- #
# Windows service control (Phase 2): one exe serves GUI + service + management
# --------------------------------------------------------------------------- #
# The exe re-invokes ITSELF with a verb (install-service / remove-service /
# start-service / stop-service) ELEVATED via ShellExecuteW(runas) so the UAC
# prompt appears; the elevated copy performs the SCM action and exits. The GUI
# never needs to be elevated itself - only these short verb runs are.
SERVICE_VERBS = ("install-service", "remove-service", "start-service",
                 "stop-service")


def service_module():
    """Import win_service lazily; return the module or None if unavailable.

    pywin32 may be absent on a dev/source box, in which case the GUI simply runs
    in PORTABLE (in-process) mode. Never raises.
    """
    try:
        import win_service  # type: ignore
        return win_service
    except Exception:
        return None


def service_installed() -> bool:
    """True when the Windows service is registered (any state). False if pywin32
    is missing or the service is not installed."""
    svc = service_module()
    if svc is None:
        return False
    try:
        return bool(svc.is_service_installed())
    except Exception:
        return False


def service_state() -> Optional[str]:
    """Coarse service state ('running'/'stopped'/...) or None if not installed."""
    svc = service_module()
    if svc is None:
        return None
    try:
        return svc.service_state()
    except Exception:
        return None


def service_direct(verb: str) -> bool:
    """Start/stop the service IN-PROCESS with NO elevation/UAC.

    Works because the installer grants this account start/stop rights on the
    service (win_service.grant_service_control_to_users). Returns True on
    success; False if denied or unavailable, so the caller can fall back to the
    elevated re-launch. Never raises.
    """
    svc = service_module()
    if svc is None:
        return False
    try:
        if verb == "start-service":
            return svc.start_service() == 0
        if verb == "stop-service":
            return svc.stop_service() == 0
    except Exception:
        return False
    return False


def _control_target() -> str:
    """The program to re-invoke for a service verb (the frozen exe, or
    python.exe when running from source).

    Returns just the program path; the verb (and, from source, this script's
    path) are passed as separate ShellExecuteW parameters by the caller.
    """
    return exe_path()


def run_elevated_verb(verb: str, wait: bool = True, timeout: int = 60,
                      extra: "Optional[str]" = None) -> bool:
    """Re-launch THIS exe with a service ``verb`` ELEVATED (UAC) and wait for it.

    Uses ``ShellExecuteW(..., 'runas', ...)`` so Windows shows the consent
    prompt; the elevated process performs the SCM action (install/remove/start/
    stop) and exits. Returns True if the elevated process ran AND exited 0.
    Returns False if the user declined UAC or the action failed. Windows-only;
    on other OSes (or without ctypes) returns False.

    For a frozen exe the parameters are just the verb. From source we pass the
    gui_agent.py path plus the verb so the same routing runs under python.exe.

    ``extra`` is an OPTIONAL extra argument appended AFTER the verb (quoted) -
    used by ``install-service`` to carry the absolute, STABLE installed-exe path
    (``<install_dir>\\TallyCloudSync.exe``) so the elevated copy registers the
    service to that exact path, never to whatever exe is currently running.
    """
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:
        return False

    program = _control_target()
    tail = (' "%s"' % extra) if extra else ""
    if running_frozen():
        params = verb + tail
    else:
        params = '"%s" %s%s' % (os.path.abspath(__file__), verb, tail)

    SEE_MASK_NOCLOSEPROCESS = 0x00000040
    SEE_MASK_NO_CONSOLE = 0x00008000

    class SHELLEXECUTEINFOW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("fMask", ctypes.c_ulong),
            ("hwnd", wintypes.HWND),
            ("lpVerb", wintypes.LPCWSTR),
            ("lpFile", wintypes.LPCWSTR),
            ("lpParameters", wintypes.LPCWSTR),
            ("lpDirectory", wintypes.LPCWSTR),
            ("nShow", ctypes.c_int),
            ("hInstApp", wintypes.HINSTANCE),
            ("lpIDList", ctypes.c_void_p),
            ("lpClass", wintypes.LPCWSTR),
            ("hkeyClass", wintypes.HKEY),
            ("dwHotKey", wintypes.DWORD),
            ("hIcon", wintypes.HANDLE),
            ("hProcess", wintypes.HANDLE),
        ]

    info = SHELLEXECUTEINFOW()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NO_CONSOLE
    info.hwnd = None
    info.lpVerb = "runas"
    info.lpFile = program
    info.lpParameters = params
    info.lpDirectory = os.path.dirname(program) or None
    info.nShow = 0  # SW_HIDE - the verb runs invisibly.

    try:
        ok = ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(info))
    except Exception:
        return False
    if not ok or not info.hProcess:
        # User declined UAC (or the launch failed) -> caller falls back.
        return False
    if not wait:
        return True
    try:
        # WaitForSingleObject, then read the exit code (0 == success).
        ctypes.windll.kernel32.WaitForSingleObject(
            info.hProcess, int(timeout * 1000))
        code = wintypes.DWORD()
        ctypes.windll.kernel32.GetExitCodeProcess(
            info.hProcess, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(info.hProcess)
        return code.value == 0
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# Sync controller - owns the daemon thread, the queue and the stop Event
# --------------------------------------------------------------------------- #
class SyncController:
    """Drive :func:`sync_agent.run_sync_loop` in a daemon thread.

    The thread NEVER touches tkinter. It only:
      * pushes status dicts (from the engine's ``on_status`` callback) onto
        ``self.status_q``;
      * pushes log lines (via a logging handler) onto ``self.log_q``.
    The GUI drains both queues on the Tk thread with ``root.after``. Start/Stop
    create a fresh :class:`threading.Event` + thread each time.
    """

    def __init__(self) -> None:
        self.status_q: "queue.Queue[dict]" = queue.Queue()
        self.log_q: "queue.Queue[str]" = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._stop: Optional[threading.Event] = None
        self._lock = threading.Lock()

    def is_running(self) -> bool:
        """True while the sync thread is alive."""
        t = self._thread
        return bool(t and t.is_alive())

    def start(self, cfg: Config, logger) -> bool:
        """Start the sync loop in a daemon thread. No-op if already running."""
        with self._lock:
            if self.is_running():
                return False
            self._stop = threading.Event()
            stop = self._stop
            self._thread = threading.Thread(
                target=self._run, args=(cfg, logger, stop),
                name="sync-loop", daemon=True,
            )
            self._thread.start()
            return True

    def _run(self, cfg: Config, logger, stop: threading.Event) -> None:
        """Thread body: run the shared engine loop, funnel status to the queue."""
        def on_status(payload: dict) -> None:
            # Cheap + thread-safe: just enqueue. The GUI reads it on its thread.
            try:
                self.status_q.put_nowait(dict(payload))
            except Exception:
                pass
        try:
            api = sync_agent.build_api(cfg, logger)
            sync_agent.run_sync_loop(cfg, logger, api,
                                     on_status=on_status, stop_event=stop)
        except SystemExit:
            # The engine raises SystemExit to hand off to the self-updater.
            self.status_q.put_nowait({"event": "updating", "ts": time.time()})
        except Exception as exc:
            logger.error("Sync thread crashed: %s", exc)
            logger.debug("%s", traceback.format_exc())
            self.status_q.put_nowait(
                {"event": "error", "message": str(exc), "ts": time.time()})

    def stop(self, timeout: float = 5.0) -> None:
        """Signal the loop to stop and wait briefly for the thread to end."""
        with self._lock:
            stop, thread = self._stop, self._thread
        if stop is not None:
            stop.set()
        if thread is not None and thread.is_alive():
            thread.join(timeout=timeout)


class QueueLogHandler:
    """A logging handler shim that funnels formatted log lines onto a queue.

    Kept as a plain object wrapping a real ``logging.Handler`` so the engine's
    file logging is untouched - we only ADD a tap that the GUI drains for its
    live activity tail. Lines are ASCII-coerced so the Text widget never chokes.
    """

    def __init__(self, log_q: "queue.Queue[str]") -> None:
        import logging

        class _H(logging.Handler):
            def emit(self_inner, record):  # noqa: N805
                try:
                    msg = self_inner.format(record)
                    log_q.put_nowait(msg)
                except Exception:
                    pass

        self.handler = _H()
        self.handler.setFormatter(
            __import__("logging").Formatter("%(asctime)s [%(levelname)s] %(message)s",
                                            datefmt="%H:%M:%S"))


# --------------------------------------------------------------------------- #
# Optional tray icon (pystray + Pillow) - import-guarded, never required
# --------------------------------------------------------------------------- #
def tray_available() -> bool:
    """True only when BOTH pystray and Pillow import cleanly."""
    try:
        import pystray  # noqa: F401
        from PIL import Image  # noqa: F401
        return True
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# Base application window
# --------------------------------------------------------------------------- #
class AgentApp:
    """Top-level Tk application that hosts either the Setup or Dashboard view."""

    def __init__(self, root: tk.Tk, instance: SingleInstance, splash=None) -> None:
        self.root = root
        self.instance = instance
        # The animated boot splash, if one is up. Startup steps report through
        # it so the customer sees WHICH slow thing is happening, not just that
        # something is.
        self.splash = splash
        self.logger = get_logger("gui-agent")
        self.controller = SyncController()
        self.tray = None  # set when a tray icon is created
        self.view = None  # the view currently on screen (see _bring_to_front)
        self._tray_log_tap_installed = False

        root.title(APP_TITLE)
        root.geometry("780x620")
        root.minsize(700, 540)
        self._setup_theme(root)
        # Window + taskbar icon = the SAME brand .ico every other window uses.
        ui_signin.apply_icon(root)
        try:
            root.protocol("WM_DELETE_WINDOW", self.on_close)
        except Exception:
            pass

    # -- boot -------------------------------------------------------------- #
    def boot(self) -> None:
        """Choose and build the first view — WITHOUT blocking the Tk thread.

        The expensive part is ``find_existing_install``: it walks the usual
        install locations looking for an older copy of the agent, and on a real
        machine that took upwards of twenty seconds. Running it here, inline,
        froze the whole UI thread for that entire time — which is precisely why
        the splash looked like a dead picture instead of something loading. Its
        bar cannot animate if nothing is servicing the event loop.

        So the scan happens on a worker and the answer comes back through
        ``after``. Everything that touches a widget still runs on the Tk thread;
        the only thing that moved is the waiting.
        """
        t0 = time.perf_counter()
        self.logger.info("Startup: imports took %.2fs", t0 - _IMPORT_STARTED)
        self._boot("Loading settings...")
        cfg = load_config_safe()
        self.logger.info("Startup: config read in %.2fs", time.perf_counter() - t0)
        if is_activated(cfg):
            # Running from an activated folder (installed, or from source for
            # manual testing) -> the Dashboard. Nothing to scan for.
            self._finish_boot(cfg, "")
            return
        if not running_frozen():
            self._finish_boot(cfg, "")
            return

        # A DOWNLOADED exe on a machine that is already installed. The old
        # behaviour was the full wizard — asking for a licence key this machine
        # already holds, to install over an install that works. Update it in
        # place instead, without asking anything.
        self._boot("Checking for an existing install...")

        def work() -> None:
            t = time.perf_counter()
            try:
                existing = find_existing_install(skip_dir=app_dir())
            except Exception:
                existing = ""
            self.logger.info("Startup: install scan took %.2fs",
                             time.perf_counter() - t)
            self.root.after(0, lambda: self._finish_boot(cfg, existing))

        threading.Thread(target=work, name="boot-scan", daemon=True).start()

    def _finish_boot(self, cfg: Config, existing: str) -> None:
        """Build the first view and retire the splash. Always on the Tk thread.

        Startup is LOGGED, because this is the one stretch of the app's life
        with no window to report from: if building the first view fails here,
        the customer sees a splash vanish and nothing take its place, and
        without these lines there is nothing to send support either.
        """
        try:
            if is_activated(cfg):
                self.logger.info("Startup: opening the Dashboard.")
                self.show_dashboard(cfg)
            elif existing:
                self.logger.info("Startup: updating the install at %s", existing)
                self.show_update(existing)
            else:
                self._boot("Preparing sign-in...")
                t = time.perf_counter()
                self.show_setup(cfg)
                self.logger.info("Startup: sign-in built in %.2fs, window up "
                                 "%.2fs after start",
                                 time.perf_counter() - t,
                                 time.perf_counter() - _IMPORT_STARTED)
        except Exception:
            self.logger.exception("Startup: could not build the first view")
            raise
        finally:
            if self.splash is not None:
                self.splash.close()
                self.splash = None
            self._bring_to_front()

    def _bring_to_front(self) -> None:
        """Show the window IN FRONT, not merely shown.

        Windows will not hand the foreground to a process the user did not just
        interact with — and this window is created by a background boot, so
        deiconify + lift left it behind whatever was already open. The customer
        launched the app and then had to go find it on the taskbar.

        Flashing topmost on and straight back off is the sanctioned way to say
        "I am the window they asked for" without leaving it pinned above
        everything else forever.
        """
        try:
            self.root.deiconify()
            self.root.lift()
            self.root.attributes("-topmost", True)
            self.root.focus_force()
            self.root.after(400, lambda: self._drop_topmost())
            # The cursor goes into the first field only AFTER the window has the
            # foreground. Focusing it while the window is still in the
            # background sets Tk's idea of focus but not Windows's, so the
            # caret blinked in the email box and the first thing typed went to
            # whatever app actually had the keyboard.
            self.root.after(120, self._focus_first_field)
        except Exception:
            pass

    def _focus_first_field(self) -> None:
        """Ask the current view for the field the customer should type in."""
        try:
            first = getattr(self.view, "focus_first", None)
            if callable(first):
                first()
        except Exception:
            pass

    def _drop_topmost(self) -> None:
        try:
            self.root.attributes("-topmost", False)
        except Exception:
            pass

    def _boot(self, message: str) -> None:
        """Name the startup step on the splash.

        No pumping here any more: the splash animates from the event loop like
        any other widget, because ``boot`` no longer blocks it.
        """
        if self.splash is None:
            return
        try:
            self.splash.status(message)
        except Exception:
            pass

    # -- theme ------------------------------------------------------------- #
    @staticmethod
    def _setup_theme(root: tk.Tk) -> None:
        """Apply the "Ledger" design system (see ui_theme).

        Every colour, font and spacing value lives in that module, so the look
        can be changed in one place instead of being spread across the ~300
        lines of ttk style calls this used to be.
        """
        ui_theme.apply(root)


    # -- view switching ---------------------------------------------------- #
    def _clear(self) -> None:
        for child in self.root.winfo_children():
            child.destroy()

    def show_setup(self, cfg: Config) -> None:
        """Render the first-run Setup wizard."""
        self._clear()
        # Held so the window can hand keyboard focus back to whatever the view
        # says its first field is, AFTER the window itself has the foreground.
        self.view = SetupView(self.root, self, cfg)

    def show_dashboard(self, cfg: Config) -> None:
        """Render the installed/activated Dashboard."""
        self._clear()
        self._unlock_window()
        self.view = DashboardView(self.root, self, cfg)

    def _unlock_window(self) -> None:
        """Undo the sign-in screen's fixed geometry.

        SetupView pins the window to a non-resizable 1000x600 because its right
        pane is drawn at absolute coordinates. The Dashboard is a normal
        resizable layout, so leaving that pin in place would lock a working
        window at the sign-in screen's size for the rest of the session.
        """
        try:
            self.root.resizable(True, True)
            self.root.minsize(700, 540)
            self.root.geometry("780x620")
        except Exception:
            pass

    def show_update(self, install_dir: str) -> None:
        """Render the in-place update of an existing install."""
        self._clear()
        self._unlock_window()
        UpdateView(self.root, self, install_dir)

    # -- window lifecycle -------------------------------------------------- #
    def on_close(self) -> None:
        """Closing the window must NOT kill a running sync.

        If a tray icon exists, hide to tray. Otherwise withdraw (hide) the
        window and keep the loop running - re-launching the exe re-focuses it
        (single-instance). If nothing is syncing, just exit.
        """
        if self.controller.is_running():
            if self.tray is not None:
                self.hide_to_tray()
            else:
                try:
                    self.root.withdraw()
                except Exception:
                    self.quit_app()
        else:
            self.quit_app()

    def hide_to_tray(self) -> None:
        """Withdraw the window (the tray icon's menu re-shows it)."""
        try:
            self.root.withdraw()
        except Exception:
            pass

    def restore_window(self) -> None:
        """Re-show + focus the main window (from tray or a second launch).

        Same foreground problem as at startup — a tray click or a second launch
        is an interaction with ANOTHER process, so Windows will not give this
        one the foreground on deiconify alone.
        """
        self._bring_to_front()

    def quit_app(self) -> None:
        """Stop the loop, release the lock, destroy the window."""
        try:
            self.controller.stop(timeout=4.0)
        except Exception:
            pass
        try:
            if self.tray is not None:
                self.tray.stop()
        except Exception:
            pass
        try:
            self.instance.release()
        except Exception:
            pass
        try:
            self.root.destroy()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
# Setup wizard view
# --------------------------------------------------------------------------- #
class SetupView:
    """First run: sign in, and nothing else.

    WHY THIS SCREEN IS NEARLY EMPTY. It used to ask for an install folder, the
    Tally executable, a sync interval and three checkboxes before the customer
    had proved who they were. Every one of those has a correct default, none of
    them can be judged by someone who has not used the product yet, and all of
    them stood between them and the only thing that actually had to happen.

    So the wizard asks for the two things it cannot guess — who you are, and the
    code proving it is really you — and installs with defaults. Everything else
    moved to Settings, where it can be changed by someone who now has a reason
    to change it.
    """

    # A fixed, two-pane window: the product on the left, the sign-in card on the
    # right. Non-resizable — the illustration is a 1:1 PNG and the card is drawn
    # at absolute coordinates, and neither gains anything from more room.
    # Geometry and painting both live in ui_signin; this class stays about what
    # happens when the customer presses the button.
    WIDTH = ui_signin.WIDTH
    HEIGHT = ui_signin.HEIGHT

    EMAIL_HINT = "Enter your email address"
    PASS_HINT = "Enter your password"

    def __init__(self, parent: tk.Tk, app: AgentApp, cfg: Config) -> None:
        self.app = app
        self.cfg = cfg
        self.logger = app.logger
        self._installing = False
        self._installed_exe: Optional[str] = None
        self.challenge_id = ""
        self.email_masked = ""
        self._machine_id = ""

        self._size_window(parent)

        # Defaults for everything the wizard no longer asks. Tally is detected
        # rather than typed — the customer running this installer is sitting at
        # the machine Tally is on, so guessing wrong is unlikely and correcting
        # it later is one field in Settings.
        # tally_exe starts as whatever config already knows and is refined by a
        # BACKGROUND probe (see below). The probe walks Program Files, which on a
        # busy or networked disk takes seconds — and it used to run right here,
        # freezing the window before it had drawn a single pixel. Nothing on this
        # screen needs the answer: it is only read when the customer presses
        # Continue, minutes of typing later.
        self._opts = {
            "install_dir": DEFAULT_INSTALL_DIR,
            "tally_exe": cfg.tally_exe or "",
            "interval": int(cfg.sync_interval or 60),
            "auto_update": True,
            "auto_start": True,
            "desktop": True,
        }

        self.var_email = tk.StringVar(value="")
        self.var_password = tk.StringVar(value="")

        self.shell = ui_signin.Shell(parent)
        self.shell.side()
        p = self.panel = self.shell.panel()
        p.card()
        p.header("Connect this computer",
                 "Sign in to start syncing Tally data securely", chip="256-bit")

        self.entry_email = p.field(
            "Email Address", self.var_email, icon_name="mail",
            placeholder=self.EMAIL_HINT, on_return=self.on_install, focus=True)
        self.entry_password = p.field(
            "Password", self.var_password, icon_name="lock", secret=True,
            placeholder=self.PASS_HINT, on_return=self.on_install)

        # No "remember this device" and no "forgot password" here. The first was
        # a promise this build does not keep — the emailed code is required on
        # every sign-in — and a checkbox that silently does nothing is worse than
        # no checkbox. The second sent the customer to a web page mid-install;
        # it belongs on that page's own sign-in, not in the installer.
        p.gap(4)
        self.install_btn = p.primary("Connect to Cloud Securely",
                                     command=self.on_install)
        p.divider("OR")
        p.link_line("Don't have an account?", "Create Account",
                    on_link=self._create_account)
        p.notice(["A 6-digit verification code will be sent to your email address",
                  "to confirm this computer."])

        # One line, replaced in place. The old build had an eight-line console
        # here; during a 20-second install it scrolled messages nobody could act
        # on, and the rest of the time it was an empty black rectangle.
        self.status = p.status()

        self.open_btn = None      # created only once there is a dashboard to open
        self._start_tally_probe(cfg)
        p.footer(SUPPORT_EMAIL, on_support=self._contact_support,
                 version="v" + str(cfg.agent_version or "1.0.0"), state_text="",
                 policy=lambda: self._open_url(self._portal("/privacy")),
                 on_quit=self.app.quit_app)

    # -- chrome ------------------------------------------------------------ #
    def _size_window(self, parent: tk.Tk) -> None:
        """Kept for callers; ui_signin.Shell now owns the geometry."""
        return

    def focus_first(self) -> None:
        """The field this screen wants typed into first.

        Whichever of the two screens is up: the email on sign-in, the code on
        the verify screen. Called once the WINDOW has the foreground — see
        AgentApp._bring_to_front for why it cannot simply be done at build time.
        """
        entry = getattr(self, "entry_code", None) or getattr(self, "entry_email", None)
        if entry is None:
            return
        try:
            entry.focus_set()
            entry.icursor("end")
        except Exception:
            pass

    def _contact_support(self) -> None:
        self._open_url("mailto:" + SUPPORT_EMAIL)

    @staticmethod
    def _portal(path: str) -> str:
        """A page on the customer portal.

        Derived from AGENT_UI_URL (which points at the agent's own page on that
        portal) so a deployment only ever configures ONE host — a second base
        URL is a second thing to get wrong on a customer's machine.
        """
        base = AGENT_UI_URL.rstrip("/")
        if base.endswith("/agent-app"):
            base = base[: -len("/agent-app")]
        return base + path

    def _create_account(self) -> None:
        self._open_url(self._portal("/register"))

    @staticmethod
    def _open_url(url: str) -> None:
        """Hand the link to the browser. A dead link must not raise here — the
        customer's sign-in is not the place to surface a webbrowser failure."""
        try:
            import webbrowser                                  # noqa: PLC0415
            webbrowser.open(url)
        except Exception:
            pass

    def _append(self, text: str, error: bool = False) -> None:
        """Show one line of PROGRESS. Replaces, never accumulates.

        Failures do not appear here at all — they get the modal alert, which is
        the only thing on this screen that can actually stop the customer and be
        read. A red line under the card said the same thing twice and left the
        error sitting there long after it had been dealt with, so ``error=True``
        now just clears the line and lets the dialog carry the message.
        """
        try:
            self.status.set("" if error else text)
            # update(), not update_idletasks(): the install runs on this thread
            # and its steps are seconds long, so this is the ONLY chance the
            # button's spinner gets to advance. update_idletasks redraws but
            # never runs the timer callback that moves it, which left a frozen
            # spinner sitting over a working install.
            self.app.root.update()
        except Exception:
            pass

    def _alert(self, message: str, *, kind: str = "error", title: str = "") -> None:
        """The app's own modal alert (see ui_signin.Dialog for why not
        messagebox)."""
        ui_signin.alert(self.app.root, message, kind=kind, title=title)

    def _enable(self, name: str) -> None:
        """Re-enable the button ``name`` IF this screen still has it.

        Setup is two screens in one window and the second destroys the first's
        widgets, so a button created on sign-in is already gone by the time the
        install (driven from the OTP screen) finishes. Touching it raised
        TclError and turned a SUCCESSFUL install into an "Install failed"
        dialog. Missing or destroyed → nothing to do, never an error.
        """
        self._set_state(name, "normal")

    def _set_state(self, name: str, state: str) -> None:
        """Set a button's state IF this screen still has that button.

        Some controls exist on only one of the two screens (the resend link, the
        Open Dashboard button), so "missing" is a normal outcome here and never
        an error.
        """
        btn = getattr(self, name, None)
        if btn is None:
            return
        try:
            btn.configure(state=state)
        except tk.TclError:
            pass                      # widget belonged to a destroyed screen.


    def _detect_tally(self, cfg: Config) -> str:
        """Auto-detect tally.exe using the engine's finder (editable later)."""
        try:
            found = sync_agent._find_tally_exe(cfg)
            return found or (cfg.tally_exe or "")
        except Exception:
            return cfg.tally_exe or ""

    def _start_tally_probe(self, cfg: Config) -> None:
        """Find tally.exe on a worker thread, off the UI's critical path.

        Fire-and-forget: the result is only consulted at install time, and if the
        probe has not finished (or found nothing) by then, the install writes an
        empty path and the customer sets it in Settings — exactly what happens
        today on a machine where Tally is installed somewhere unusual.
        """
        def work() -> None:
            found = self._detect_tally(cfg)
            if found:
                self._opts["tally_exe"] = found

        threading.Thread(target=work, name="setup-tally-probe",
                         daemon=True).start()

    def on_install(self) -> None:
        """Sign in -> email a code -> verify -> install.

        WHAT IS CHECKED HERE, AND WHAT IS NOT. Only the two things that are
        certainly wrong without asking anyone: an empty box, and something in
        the email field that cannot be an address. Those used to go to the
        server, which meant a spinner, a network round-trip and a 422 to be told
        the field was blank — the customer watched a "Signing in..." that was
        never going to sign anything in.

        Everything else is still the server's call — whether the account exists,
        whether the password is right, whether the licence allows this machine —
        and its wording is shown verbatim, so those rules can change without
        shipping a new exe.

        Install options are no longer asked for — they are defaults chosen in
        __init__ and editable in Settings afterwards. See the class docstring
        for why: none of them can be judged by someone who has not used the
        product yet, and all of them stood between the customer and signing in.

        The network call runs off the Tk thread; results come back via after().
        """
        if self._installing:
            return
        # The fields carry a grey hint when untouched; the hint is text in the
        # widget, so it has to be filtered out or it would be sent as a login.
        email = self.panel.value(self.entry_email, self.var_email,
                                 self.EMAIL_HINT).strip()
        password = self.panel.value(self.entry_password, self.var_password,
                                    self.PASS_HINT)

        # Checked BEFORE the spinner starts. The alert names the one field to
        # fix and the cursor is put in it, so the customer's next keystroke lands
        # where it needs to.
        problem, focus_on = self._first_problem(email, password)
        if problem:
            self._alert(problem, title="Check your details")
            self._focus(focus_on)
            return

        self._installing = True
        # A spinner ON the button, not just a pale rectangle: this is the only
        # place the customer looks after clicking, and the request can take a
        # few seconds on a slow line.
        self.install_btn.busy("Signing in...")
        self._append("")

        threading.Thread(
            target=self._login_worker, args=(email, password),
            name="setup-login", daemon=True,
        ).start()

    def _first_problem(self, email: str, password: str):
        """The FIRST thing wrong with the form, and the field to focus.

        One message at a time, in reading order. A list of everything wrong is
        worse here: there are two fields, and a customer who has typed neither
        already knows.

        The email test is deliberately loose — one @, something either side, a
        dot in the domain. Anything stricter starts rejecting addresses that
        really exist (plus-tags, long TLDs, unicode domains), and being told
        your own address is invalid by an installer is a wall, not a hint.
        """
        if not email:
            return "Enter your email address.", self.entry_email
        parts = email.split("@")
        if (len(parts) != 2 or not parts[0] or "." not in parts[1]
                or parts[1].startswith(".") or parts[1].endswith(".")
                or " " in email):
            return "That does not look like an email address.", self.entry_email
        if not password:
            return "Enter your password.", self.entry_password
        return "", None

    def _login_worker(self, email: str, password: str) -> None:
        """Worker: POST /agent/login. Never touches a widget directly."""
        err = None
        data = {}
        try:
            cfg = Config.load(config_path())
        except Exception:
            cfg = Config(config_path())
        self._machine_id = cfg.machine_id or machine_fingerprint()
        try:
            api = sync_agent.build_api(cfg, self.logger)
            data = api.login(email, password, self._machine_id,
                             machine_name=sync_agent._machine_name(),
                             agent_version=cfg.agent_version) or {}
        except Exception as exc:
            err = str(exc)

        def done():
            self._installing = False
            self.install_btn.configure(state="normal",
                                       text="Connect to Cloud Securely")
            if err or not data.get("challenge_id"):
                # What was typed stays on screen. Making somebody retype an
                # email because a password was wrong is its own small insult.
                self._append("", error=True)
                self._alert(err or "Sign-in failed.", title="Sign-in failed")
                return
            self.challenge_id = data.get("challenge_id") or ""
            self.email_masked = data.get("email_masked") or ""
            self._append("Code emailed to " + self.email_masked + ".")
            self._show_code_screen()
        self.app.root.after(0, done)

    def _show_code_screen(self) -> None:
        """Second screen: the 6-digit code.

        A separate screen rather than one more field on the form, because the
        first screen's job is done. Leaving it filled invites the customer to
        edit an address a code has already been sent to.

        Same chrome as sign-in — same size, same header, same footer — so this
        reads as the next step of one thing rather than a different window.
        """
        for child in self.app.root.winfo_children():
            child.destroy()

        self.shell = ui_signin.Shell(self.app.root)
        self.shell.side()
        p = self.panel = self.shell.panel()
        p.card()
        p.header("Check your email",
                 "Enter the 6-digit code we sent you", chip="256-bit")

        p.gap(6)
        p.text("We sent a code to", size=9, fill=ui_signin.MUTED, gap=19)
        p.text(self.email_masked or "your address", size=12, bold=True,
               fill=ui_signin.INK, gap=30)

        self.var_code = tk.StringVar(value="")
        # The code is DATA, so it is set in the data face at display size: it is
        # read off a phone and typed back, and 0/O has to be unmistakable while
        # that is happening.
        self.entry_code = p.field("Verification Code", self.var_code,
                                  icon_name="shield", on_return=self.on_verify,
                                  focus=True)
        self.entry_code.configure(font=(ui_theme.DATA_FACE, 15, "bold"),
                                  justify="center")

        self.verify_btn = p.primary("Verify & Install", command=self.on_verify,
                                    icon_name="shield-check")
        p.link_line("Didn't get the code?", "Resend code", on_link=self.on_resend)
        p.notice(["The code expires in 10 minutes. Keep this window open",
                  "while we finish setting up this computer."])
        self.status = p.status()

        self.resend_btn = None      # the resend is a link here, not a button
        self.open_btn = None
        p.footer(SUPPORT_EMAIL, on_support=self._contact_support,
                 version="v" + str(self.cfg.agent_version or "1.0.0"),
                 state_text="",
                 on_quit=lambda: self.app.show_setup(self.cfg),
                 quit_text="Back")


    def on_verify(self) -> None:
        """Exchange the code for a token, then install.

        The shape of the code is checked here — six digits, nothing else — so a
        half-typed code does not spend an attempt from the server's budget. The
        code's VALIDITY is still entirely the server's to judge.
        """
        if self._installing:
            return
        code = self.var_code.get().strip()
        if not code:
            self._alert("Enter the 6-digit code we emailed you.",
                        title="Code required")
            self._focus(self.entry_code)
            return
        if not (code.isdigit() and len(code) == 6):
            self._alert("The code is 6 digits — check what you typed.",
                        title="That is not a 6-digit code")
            self._focus(self.entry_code)
            return

        self._installing = True
        self.verify_btn.busy("Verifying...")
        self._append("")
        threading.Thread(target=self._verify_worker, args=(code,),
                         name="setup-verify", daemon=True).start()

    @staticmethod
    def _focus(widget) -> None:
        """Put the cursor back where the fix has to happen. Never raises."""
        try:
            widget.focus_set()
        except Exception:
            pass

    def _verify_worker(self, code: str) -> None:
        err = None
        token = ""
        try:
            cfg = Config.load(config_path())
        except Exception:
            cfg = Config(config_path())
        try:
            api = sync_agent.build_api(cfg, self.logger)
            data = api.verify_otp(self.challenge_id, code, self._machine_id,
                                  machine_name=sync_agent._machine_name(),
                                  agent_version=cfg.agent_version) or {}
            token = data.get("agent_token") or ""
            if not token:
                err = "Signed in, but no token came back. Try again."
        except Exception as exc:
            err = str(exc)

        def done():
            if err or not token:
                self._append("", error=True)
                self._alert(err or "Could not verify the code.",
                            title="That code did not work")
                self._installing = False
                # Both the spinner AND the label go back: a button that still
                # says "Verifying..." after the attempt failed reads as an
                # attempt still running.
                self.verify_btn.configure(state="normal", text="Verify & Install")
                self._focus(self.entry_code)
                return
            # The SAME button keeps spinning straight through the install. To
            # the customer, "verify" and "install" are one action they started
            # with one click, and handing them a second, different progress
            # indicator halfway through only asks them to work out whether
            # something restarted.
            self.verify_btn.busy("Installing...")
            self._append("This computer is connected. Installing...")
            # Install happens ONLY now. Doing it before the token existed left a
            # registered service with nothing to authenticate with - running,
            # logging, and useless.
            o = self._opts
            self._do_install("", o["install_dir"], o["tally_exe"], o["interval"],
                             o["auto_update"], o["auto_start"], o["desktop"],
                             self._machine_id, token)
        self.app.root.after(0, done)

    def on_resend(self) -> None:
        """Ask for a fresh code. The server owns the cooldown and the cap."""
        self._set_state("resend_btn", "disabled")
        self._append("Sending a new code...")

        def work():
            err = None
            try:
                cfg = Config.load(config_path())
            except Exception:
                cfg = Config(config_path())
            try:
                api = sync_agent.build_api(cfg, self.logger)
                api.resend_otp(self.challenge_id)
            except Exception as exc:
                err = str(exc)

            def done():
                self._set_state("resend_btn", "normal")
                self._append(("[x] " + err) if err else "[OK] A new code is on its way.",
                             error=bool(err))
            self.app.root.after(0, done)

        threading.Thread(target=work, name="setup-resend", daemon=True).start()


    def _do_install(self, _unused, install_dir, tally_exe, interval,
                    auto_update, auto_start, desktop, machine_id, token) -> None:
        """The file-system install (Tk thread). Writes config only at the END.

        Order matters: create folder -> copy exe -> write config LAST (so we
        never leave a half-written, token-less config that would wrongly look
        'installed'). Auto-start + shortcut are best-effort with clear messages.
        """
        try:
            # 1) Create the install folder.
            self._append("[..] Creating " + install_dir + " ...")
            os.makedirs(install_dir, exist_ok=True)

            installed_exe = os.path.join(install_dir, INSTALLED_EXE_NAME)

            # 2) Copy the running exe (frozen) into the install folder.
            if running_frozen():
                src = exe_path()
                if os.path.abspath(src).lower() != os.path.abspath(installed_exe).lower():
                    self._append("[..] Copying the application to the install folder...")
                    # Re-running setup on an installed machine means the service
                    # is running this exact file; the copy stops it first.
                    copy_over_running_exe(
                        src, installed_exe,
                        # Bound to THIS install folder: the stop must end what
                        # is running from the folder being written to, not
                        # whatever happens to share the exe's name.
                        stop_fn=lambda: stop_background_syncer(install_dir),
                        append=self._append)
                else:
                    self._append("[..] Already running from the install folder.")
            else:
                self._append("[!] Not frozen: skipping exe copy (source run). "
                             "config + auto-start will still be written for testing.")

            # 2b) Copy a couple of side files when present (best-effort).
            here = app_dir()
            for name in _SIDE_FILES:
                try:
                    s = os.path.join(here, name)
                    if os.path.isfile(s):
                        shutil.copy2(s, os.path.join(install_dir, name))
                except OSError:
                    pass

            # 3) Start-Menu / Desktop shortcuts (just GUI launchers; not the
            #    background syncer). Best-effort, independent of the service.
            if auto_start:
                self._append("[..] Creating a Start Menu shortcut...")
                if create_shortcut(installed_exe,
                                   os.path.join(start_menu_programs_dir(), SHORTCUT_NAME)):
                    self._append("[OK] Start Menu shortcut created.")
                else:
                    self._append("[!] Could not create the Start Menu shortcut.")
                if desktop:
                    if create_shortcut(installed_exe,
                                       os.path.join(desktop_dir(), SHORTCUT_NAME)):
                        self._append("[OK] Desktop shortcut created.")
                    else:
                        self._append("[!] Could not create the Desktop shortcut.")

            # 4) Write config.ini in the INSTALL folder (with the token) BEFORE
            #    registering the service, so the service finds a complete config
            #    on its first start. The server URL is baked (constants
            #    .API_BASE_URL) so it is NOT written here. Only the TOKEN is
            #    persisted, encrypted and machine-bound by Config — the email and
            #    password are never written to disk at all.
            self._append("[..] Writing configuration...")
            inst_cfg = Config(os.path.join(install_dir, "config.ini"))
            inst_cfg.sync_interval = interval
            inst_cfg.auto_update = auto_update
            inst_cfg.tally_exe = tally_exe
            inst_cfg.machine_id = machine_id
            inst_cfg.save()              # writes [agent]/[tally] sections
            inst_cfg.set_token(token)    # writes [state] token + machine_id, saves

            # 5) Background syncer: register + start the Windows SERVICE (elevated
            #    via UAC). If the service goes in, that is the ONE syncer. If the
            #    user declines UAC (or pywin32 is missing), fall back to the
            #    Startup-folder hidden launcher so background sync still works -
            #    NEVER both, to avoid double-syncing.
            self._setup_background_syncer(installed_exe, install_dir, auto_start)

            # 6) Remember WHERE we installed, so a newer exe downloaded later
            #    updates this install instead of asking for the licence again.
            #    Best-effort: a machine that refuses the write still installs.
            remember_install_dir(install_dir)

            self._append("Installed to " + install_dir)
            self._installed_exe = installed_exe
            # A fallback only. The dashboard opens on its own below; this is
            # here for the case where that fails and the customer is left on
            # this screen with something to press.
            btn = getattr(self, "verify_btn", None)
            if btn is not None:
                try:
                    btn.configure(state="normal", text="Open Dashboard",
                                  command=self.on_open_dashboard)
                except tk.TclError:
                    pass
            self._enable("install_btn")
            self._installing = False
            self._alert(
                "Opening the dashboard now. It will also start automatically at "
                "logon" + (" in the background." if auto_start else "."),
                kind="success", title=f"{APP_TITLE} is installed")
            # The alert is modal, so this runs the moment the customer presses
            # OK. Setup's job is done at this point and leaving its window up
            # asks them to find and press one more button for the only thing
            # that can happen next.
            self.on_open_dashboard()
        except Exception as exc:
            self.logger.error("Install failed: %s", exc)
            self._append("", error=True)
            self._alert(str(exc), title="Install failed")
            self._installing = False
            self._enable("install_btn")
            # Same as above: put the button back to the action it offers, not
            # the one that just failed.
            btn = getattr(self, "verify_btn", None)
            if btn is not None:
                try:
                    btn.configure(state="normal", text="Verify & Install")
                except tk.TclError:
                    pass

    def _setup_background_syncer(self, installed_exe: str, install_dir: str,
                                 auto_start: bool) -> None:
        """Install the ONE background syncer: service (preferred) or VBS fallback.

        Tries to register + start the Windows service ELEVATED (UAC). On success
        the service is the single syncer, and any leftover Startup VBS is removed
        so the two never run together. If the service cannot be installed (UAC
        declined, pywin32 missing, or running from source), fall back to the
        hidden Startup-folder launcher when ``auto_start`` is set. Best-effort
        with clear progress lines; never raises.
        """
        # The service needs the INSTALLED, frozen exe (SCM launches it with
        # --run-service). From source we cannot register a one-exe service, so go
        # straight to the Startup-launcher fallback for testing.
        if running_frozen() and service_module() is not None:
            self._append("[..] Registering the background Windows service "
                         "(a UAC prompt will appear)...")
            try:
                # Pass the STABLE install-dir exe path so the service binPath is
                # ALWAYS <install_dir>\TallyCloudSync.exe - never the launcher /
                # release / temp exe that ran this installer. The service then
                # reads <install_dir>\config.ini (the token) and writes its logs
                # + .status.json into <install_dir> (its own folder).
                ok = run_elevated_verb("install-service", wait=True, timeout=90,
                                       extra=os.path.abspath(installed_exe))
            except Exception as exc:
                ok = False
                self.logger.error("Service install failed: %s", exc)
            if ok and service_installed():
                # Service is the syncer -> make sure no Startup VBS double-runs.
                remove_startup_vbs()
                self._append("[OK] Background service installed and started "
                             "(runs even when no one is logged in).")
                return
            self._append("[!] Service not installed (UAC declined or "
                         "unavailable). Falling back to a logon auto-start "
                         "launcher.")
        else:
            self._append("[!] Service install skipped (source run). Using the "
                         "logon auto-start launcher instead.")

        # Fallback: the hidden Startup-folder launcher (only when auto_start).
        if auto_start:
            vbs = write_startup_vbs(installed_exe)
            if vbs:
                self._append("[OK] Auto-start at logon installed (background "
                             "launcher).")
            else:
                self._append("[!] Could not install the auto-start launcher "
                             "(enable it later from the Dashboard).")
        else:
            self._append("[!] Auto-start at logon was not selected; start the "
                         "agent manually or enable it later from the Dashboard.")

    def _hide_for_handover(self) -> None:
        """Take this window (and its tray icon) off screen, now.

        Used when another copy of the app is about to take over. ``withdraw``
        rather than ``destroy``: the relaunch can still fail, and a window that
        can be brought back is the difference between "it restarted" and "it
        vanished".
        """
        try:
            tray = getattr(self.app, "tray", None)
            if tray is not None:
                tray.stop()
        except Exception:
            pass
        try:
            self.app.root.withdraw()
            self.app.root.update()          # make the hide actually paint
        except Exception:
            pass

    def on_open_dashboard(self) -> None:
        """Relaunch the installed exe (-> Dashboard) and close this setup window."""
        exe = self._installed_exe
        if exe and os.path.isfile(exe) and running_frozen():
            # Release THIS instance's single-instance lock (the loopback port)
            # BEFORE spawning the installed exe, otherwise the freshly-launched
            # instance can lose the bind race, conclude "already running", send a
            # 'focus' to this dying setup window and exit WITHOUT ever showing the
            # Dashboard. Releasing first frees the port so the child binds cleanly.
            try:
                self.app.instance.release()
            except Exception:
                pass
            # GET OFF THE SCREEN FIRST. The installed exe puts its own loader up
            # within a second, and until this window is gone the customer sees
            # that loader with the finished setup screen sitting behind it — two
            # of the same app, one of which is over. Hiding before the spawn
            # means the loader arrives onto an empty desktop, which is what "the
            # app is restarting" is supposed to look like.
            self._hide_for_handover()
            if relaunch_installed(exe):
                self.app.quit_app()
                return
            # It did not start, so this window is all the customer has left —
            # bring it back before saying so.
            try:
                self.app.root.deiconify()
                self.app.root.lift()
            except Exception:
                pass
            self._alert("Could not launch the installed application.",
                        title="Could not open the Dashboard")
            return
        # Source run (or no copied exe): switch this window to the Dashboard,
        # reading the just-written install-folder config.
        try:
            inst_dir = os.path.dirname(exe) if exe else self._opts["install_dir"]
            cfg = Config.load(os.path.join(inst_dir, "config.ini"))
        except Exception:
            cfg = load_config_safe()
        self.app.show_dashboard(cfg)


# --------------------------------------------------------------------------- #
# Update view — a downloaded exe over an existing install
# --------------------------------------------------------------------------- #
class UpdateView:
    """Copy this (newer) exe over the installed one and reopen it.

    WHY THIS SCREEN EXISTS: without it, running a downloaded build on a machine
    that is already installed showed the Setup wizard — licence key, install
    folder, every setting — for an install that already had all of it. The
    customer either re-entered a key they had to go and find, or gave up and
    asked for help. That is why releases meant hand-holding every customer.

    It ASKS NOTHING. The install folder comes from the pointer written at
    install time, the licence and every setting stay exactly where they are, and
    the only files touched are the exe and its side files. There is no decision
    for the customer to get wrong, so there is no dialog.

    The one thing it must not do is leave the machine broken: the installed exe
    is in use by the service, so the copy stops the syncer and retries
    (copy_over_running_exe). If it still cannot write, the OLD install is left
    running and untouched — a failed update must be a no-op, never a half-update.
    """

    def __init__(self, parent: tk.Tk, app: "AgentApp", install_dir: str) -> None:
        self.app = app
        self.logger = app.logger
        self.install_dir = install_dir
        self.installed_exe = os.path.join(install_dir, INSTALLED_EXE_NAME)
        self._done = False

        outer = ttk.Frame(parent)
        outer.pack(fill="both", expand=True)

        header = ttk.Frame(outer, style="Header.TFrame")
        header.pack(fill="x")
        hpad = ttk.Frame(header, style="Header.TFrame")
        hpad.pack(fill="x", padx=18, pady=14)
        ttk.Label(hpad, text=APP_TITLE, style="Header.TLabel").pack(anchor="w")
        ttk.Label(hpad, text="Updating your existing installation",
                  style="HeaderSub.TLabel").pack(anchor="w")

        body = ttk.Frame(outer)
        body.pack(fill="both", expand=True, padx=18, pady=16)

        card = ttk.Frame(body, style="Card.TFrame")
        card.pack(fill="x")
        cin = ttk.Frame(card, style="Card.TFrame")
        cin.pack(fill="x", padx=16, pady=14)
        self.lbl_state = ttk.Label(cin, text="Updating...", style="CardBig.TLabel")
        self.lbl_state.pack(anchor="w")
        ttk.Label(cin, text="Folder: " + install_dir,
                  style="CardSub.TLabel").pack(anchor="w", pady=(6, 0))
        ttk.Label(cin,
                  text="Your licence and settings are kept — nothing to re-enter.",
                  style="CardSub.TLabel").pack(anchor="w", pady=(2, 0))

        self.progress = ttk.Progressbar(body, style="Brand.Horizontal.TProgressbar",
                                        mode="indeterminate", length=240)
        self.progress.pack(fill="x", pady=(14, 12))
        # Idle until the customer says go: a bar that animates while the screen
        # is still asking a question says work is happening when none is.

        self.log = tk.Text(body, height=8, wrap="word", relief="flat")
        self.log.pack(fill="both", expand=True)
        self.log.configure(state="disabled")

        btns = ttk.Frame(body)
        btns.pack(fill="x", pady=(12, 0))
        self.btn_close = ttk.Button(btns, text="Close", command=self._close,
                                    state="disabled")
        self.btn_close.pack(side="right")
        self.btn_setup = ttk.Button(
            btns, text="Set up as a new install instead", command=self._fallback_setup)
        self.btn_setup.pack(side="left")
        # The decision lives ON this screen, not in a dialog on top of it. The
        # screen already states both versions and what will happen; a modal
        # asking the same question again is the same sentence twice, and it
        # covers the very text it is asking about.
        self.btn_update = ttk.Button(btns, text="Update now",
                                     style="Primary.TButton",
                                     command=self._start_update)
        self.btn_later = ttk.Button(btns, text="Not now",
                                    command=self._open_installed_and_close)

        # Decide FIRST, then act. See _decide.
        self.app.root.after(80, self._decide)

    # -- what this exe is for ---------------------------------------------- #
    def _installed_version(self) -> str:
        """What the OTHER install's config.ini literally says, or "".

        Read RAW, not through Config.load. Config.load deliberately reports at
        least the version of the exe doing the reading — right for an agent
        describing itself, and exactly wrong here: this exe is asking about a
        DIFFERENT install, so that rule made a 1.0.2 download read a 1.0.0
        install as "already 1.0.2", conclude there was nothing to update, and
        skip the update screen entirely.
        """
        try:
            import configparser                             # noqa: PLC0415
            cp = configparser.ConfigParser()
            cp.read(os.path.join(self.install_dir, "config.ini"), encoding="utf-8")
            return (cp.get("agent", "agent_version", fallback="") or "").strip()
        except Exception:
            return ""

    def _decide(self) -> None:
        """Ask before replacing an install — and only when there is a point.

        This screen used to start copying the moment it opened, on the theory
        that nobody should be asked anything. That is right for an update the
        customer went looking for, and wrong for the far more common case: they
        double-clicked the exe in Downloads to OPEN the app. It then replaced a
        working install with the same build and restarted it, which looks like
        the app crashed on launch.

        So the version decides:
          • older or equal  -> nothing to update; just open what is installed.
          • newer           -> say which version, and let them choose.
        """
        installed = self._installed_version()
        mine = str(getattr(self.cfg_for_this_exe(), "agent_version", "") or "")
        self._append("[i] Installed: v%s    This file: v%s"
                     % (installed or "?", mine or "?"))
        if installed and mine and not sync_agent._is_newer(mine, installed):
            self.lbl_state.configure(text="Already up to date",
                                     foreground=OK_GREEN)
            self._append("[OK] The installed copy is already v%s - opening it."
                         % installed)
            self.btn_close.configure(state="normal")
            if relaunch_installed(self.installed_exe):
                try:
                    self.app.root.withdraw()
                    self.app.root.update()
                except Exception:                           # noqa: BLE001
                    pass
                self.app.root.after(400, self._close)
            return

        # Both numbers, spelled out, on the screen — the whole question is
        # "which one am I on and which one is this", and naming only the new one
        # sends the customer looking for the old one.
        try:
            self.lbl_state.configure(
                text="Update available:  v%s  ->  v%s"
                     % (installed or "?", mine or "?"), foreground=BRAND)
        except Exception:                                   # noqa: BLE001
            pass
        self._append("")
        self._append("[i] Press 'Update now' to install v%s. Your licence and "
                     "settings are kept." % (mine or "the new version"))
        self.btn_update.pack(side="right", padx=(8, 0))
        self.btn_later.pack(side="right")
        self.btn_close.configure(state="normal")

    def _open_installed_and_close(self) -> None:
        """'Not now' — leave the install alone and open what is already there."""
        self._append("[i] Update skipped - opening the installed app.")
        if relaunch_installed(self.installed_exe):
            try:
                self.app.root.withdraw()
                self.app.root.update()
            except Exception:                               # noqa: BLE001
                pass
        self.app.root.after(400, self._close)

    def _start_update(self) -> None:
        """'Update now' — from here it is work, not a question."""
        for btn in (self.btn_update, self.btn_later):
            try:
                btn.pack_forget()
            except Exception:                               # noqa: BLE001
                pass
        self.btn_close.configure(state="disabled")
        try:
            self.lbl_state.configure(text="Updating...", foreground=BRAND)
            self.progress.start(12)
        except Exception:                                   # noqa: BLE001
            pass
        threading.Thread(target=self._work, name="update-in-place",
                         daemon=True).start()

    @staticmethod
    def cfg_for_this_exe() -> Config:
        """The config THIS exe carries (its baked default version).

        Read from beside the running exe rather than from the install folder —
        the whole question is what this file is, not what is already there.
        """
        return load_config_safe()

    # -- ui helpers -------------------------------------------------------- #
    def _append(self, line: str) -> None:
        def do():
            try:
                self.log.configure(state="normal")
                self.log.insert("end", line + "\n")
                self.log.see("end")
                self.log.configure(state="disabled")
            except Exception:                               # noqa: BLE001
                pass
        try:
            self.app.root.after(0, do)
        except Exception:                                   # noqa: BLE001
            pass

    def _close(self) -> None:
        try:
            self.app.root.destroy()
        except Exception:                                   # noqa: BLE001
            pass

    def _fallback_setup(self) -> None:
        """Escape hatch: install fresh instead (a second machine, a moved folder,
        or an update that will not apply)."""
        self.app.show_setup(load_config_safe())

    # -- the work ---------------------------------------------------------- #
    def _work(self) -> None:
        ok, err = self._apply()

        def done():
            try:
                self.progress.stop()
                self.progress.configure(mode="determinate", maximum=100,
                                        value=100 if ok else 0)
            except Exception:                               # noqa: BLE001
                pass
            self.btn_close.configure(state="normal")
            if ok:
                self.lbl_state.configure(text="Updated", foreground=OK_GREEN)
                self.btn_setup.pack_forget()
                # Reopen the installed exe; it finds its config and goes straight
                # to the Dashboard. Then get out of the way.
                if relaunch_installed(self.installed_exe):
                    self._append("[OK] Reopening " + APP_TITLE + "...")
                    # Off the screen before the new copy's loader appears, so
                    # the two are never up together (see SetupView for why).
                    try:
                        self.app.root.withdraw()
                        self.app.root.update()
                    except Exception:                       # noqa: BLE001
                        pass
                    self.app.root.after(400, self._close)
                else:
                    self._append("[!] Could not reopen automatically — start "
                                 + APP_TITLE + " from the Start Menu.")
            else:
                self.lbl_state.configure(text="Update failed", foreground=BAD_RED)
                self._append("[x] " + (err or "Unknown error."))
                self._append("    Your existing installation is untouched and "
                             "still running.")
        try:
            self.app.root.after(0, done)
        except Exception:                                   # noqa: BLE001
            pass

    def _apply(self) -> "tuple[bool, str]":
        """Copy this exe (+ side files) over the install. Returns (ok, error)."""
        if not running_frozen():
            return False, ("Running from source, so there is no exe to copy. "
                           "Build the exe first.")
        src = exe_path()
        if os.path.normcase(os.path.abspath(src)) == \
                os.path.normcase(os.path.abspath(self.installed_exe)):
            return False, "Already running from the install folder."

        self._append("[..] Updating " + self.install_dir + " ...")
        try:
            copy_over_running_exe(
                src, self.installed_exe,
                stop_fn=lambda: stop_background_syncer(self.install_dir),
                append=self._append)
        except Exception as exc:                            # noqa: BLE001
            return False, str(exc)
        self._append("[OK] Application updated.")

        # Record the new version in the INSTALL's config, so the machine knows
        # what it is now running. The exe was replaced but this file was not,
        # so an updated install went on reporting the version it was first
        # installed at — to the Dashboard, to the cloud, and to the next
        # update's comparison.
        try:
            inst_cfg = Config.load(os.path.join(self.install_dir, "config.ini"))
            inst_cfg.agent_version = str(
                getattr(self.cfg_for_this_exe(), "agent_version", "") or
                inst_cfg.agent_version)
            inst_cfg.save()
            self._append("[OK] Recorded version v%s." % inst_cfg.agent_version)
        except Exception as exc:                            # noqa: BLE001
            self.logger.warning("Could not record the new version: %s", exc)

        # Side files are cosmetic; a failure here must not fail the update.
        here = app_dir()
        for name in _SIDE_FILES:
            try:
                s = os.path.join(here, name)
                if os.path.isfile(s):
                    shutil.copy2(s, os.path.join(self.install_dir, name))
            except OSError:
                pass

        # Re-assert the pointer: this install is current, and an older build may
        # never have written one (which is how we got here via the default dir).
        remember_install_dir(self.install_dir)

        # Restart the syncer we stopped to free the file. Best-effort: if the
        # service will not start, the Dashboard we are about to open says so and
        # can start it — better than blocking the update on it.
        try:
            if service_installed():
                self._append("[..] Restarting the background service...")
                if run_elevated_verb("start-service", wait=True, timeout=60):
                    self._append("[OK] Background service restarted.")
                else:
                    self._append("[!] Could not restart the service — open the "
                                 "Dashboard and press Start.")
        except Exception as exc:                            # noqa: BLE001
            self.logger.debug("Service restart after update failed: %s", exc)
        return True, ""


# --------------------------------------------------------------------------- #
# Dashboard view
# --------------------------------------------------------------------------- #
class DashboardView:
    """Installed/activated dashboard: live status, settings, controls."""

    POLL_MS = 500
    # Version-check cadence in _poll ticks (POLL_MS each) -> one hour.
    # Re-check for a published release every ten minutes, not every hour. The
    # window is often left open all day: at an hour, a release published five
    # minutes after it opened went unnoticed for fifty-five, and the customer
    # who was told an update was waiting saw nothing. Ten minutes is one cheap
    # call against a value that changes a few times a year.
    UPDATE_CHECK_TICKS = int(600_000 / POLL_MS)

    def __init__(self, parent: tk.Tk, app: AgentApp, cfg: Config) -> None:
        self.app = app
        self.cfg = cfg
        self.logger = app.logger
        self.controller = app.controller
        self._last_sync_ts: Optional[float] = None
        self._connected = False
        # Service mode but the Windows service isn't running: the GUI runs the
        # syncer IN-PROCESS so the agent keeps syncing (Connected + logs + cloud
        # heartbeats) instead of a dead Disconnected screen. `_paused` lets the
        # user Stop it without the next status tick auto-restarting it.
        self._fallback_active = False
        self._fallback_paused = False
        # Version of the published exe when it is NEWER than the one running.
        # "" means "up to date or not checked yet" — the banner keys off this.
        self._update_available = ""
        self._update_info: dict = {}
        self._update_busy = False

        # MODE (Phase 2 G): if the Windows service is installed, the Dashboard
        # MONITORS + CONTROLS the service and NEVER runs its own in-process sync
        # thread (no double-sync). Only in PORTABLE mode (no service) does it fall
        # back to the in-process daemon-thread syncer. Decided once at open.
        self.service_mode = service_installed()
        self._status_mtime = 0.0  # last .status.json mtime we read (service mode)

        # Live log tail (SERVICE mode): the background service writes to
        # <install_dir>/logs/agent.log; we tail it into the Activity console so
        # the user sees real sync activity for a process the GUI does not host.
        self._logtail_path = os.path.join(app_dir(), "logs", "agent.log")
        self._logtail_pos = 0       # byte offset we have read up to.
        self._logtail_size = 0      # last seen file size (detect rotation/shrink).
        self._logtail_inited = False
        self._logtail_buf = ""      # carry a partial last line between reads.

        # Tap the engine logger so the activity tail shows real log lines.
        self._install_log_tap()

        self._build_window(parent)
        # Live update pump.
        self._poll()

        if self.service_mode:
            # Service mode: do NOT spin up an in-process syncer (the service is
            # the one syncer). Just reflect the service's state + last status.
            self._activity("[i] Background service mode: the Windows service "
                           f"'{APP_TITLE}' performs the sync. This window "
                           "monitors and controls it. Live activity from "
                           + self._logtail_path + " follows:")
            self.app.root.after(300, self._refresh_service_status)
            # Stream the service's log file into the Activity console.
            self.app.root.after(400, self._tail_service_log)
        else:
            # Portable mode: no service installed -> run the sync in-process.
            self._activity("[i] Portable mode: no Windows service installed; "
                           "syncing runs while this window is open.")
            self.app.root.after(300, self.on_start)

    # -- window -------------------------------------------------------------- #
    def _build_window(self, parent: tk.Tk) -> None:
        """Draw the Dashboard: sidebar, header, and one page per job.

        Everything here is layout. What the widgets SAY is decided by the
        methods below, which already existed and were not touched — the setters
        they call (``self.progress.configure``, ``self.lbl_sync_state``…) are
        deliberately the same names and the same shapes as the ttk widgets they
        replaced, so the redesign did not become a rewrite of the sync logic.
        """
        ui_signin.apply_icon(parent)
        self.ui = ui_dashboard.Chrome(parent, on_nav=self._on_nav)
        for key, text, icon_name in (
                ("overview", "Overview", "cloud"),
                ("sync", "Sync Now", "upload"),
                ("history", "Sync History", "doc"),
                ("settings", "Settings", "shield"),
                ("logs", "Logs", "doc"),
                ("help", "Help & Support", "headset"),
                ("about", "About", "info")):
            self.ui.add_page(key, text)
            self.ui.add_nav(key, text, icon_name)

        self._build_overview(self.ui.pages["overview"])
        self._build_sync_page(self.ui.pages["sync"])
        self._build_history(self.ui.pages["history"])
        self._build_settings_page(self.ui.pages["settings"])
        self._build_logs(self.ui.pages["logs"])
        self._build_help(self.ui.pages["help"])
        self._build_about(self.ui.pages["about"])
        self.ui.select("sync")

    def _on_nav(self, key: str) -> None:
        self.ui.lbl_page.configure(text=self.ui.page_title(key))

    # -- pages ------------------------------------------------------------- #
    def _build_overview(self, page) -> None:
        wrap = tk.Frame(page, bg=ui_dashboard.PAGE)
        wrap.pack(fill="both", expand=True, padx=22, pady=18)

        # The update banner. Built here and simply not packed until there IS an
        # update, so showing it is never a widget created off the Tk thread.
        self.update_bar = ui_dashboard.card(wrap)
        ubin = tk.Frame(self.update_bar, bg=ui_dashboard.CARD)
        ubin.pack(fill="x", padx=16, pady=12)
        self.lbl_update_msg = tk.Label(ubin, text="", font=(ui_dashboard.FACE, 9, "bold"),
                                       fg=ui_dashboard.AMBER, bg=ui_dashboard.CARD)
        self.lbl_update_msg.pack(side="left")
        self.btn_update_later = ttk.Button(ubin, text="Later",
                                           command=self._hide_update_bar)
        self.btn_update_later.pack(side="right")
        self.btn_update = ttk.Button(ubin, text="Update Now", style="Primary.TButton",
                                     command=self.on_update_now)
        self.btn_update.pack(side="right", padx=(0, 8))

        top = ui_dashboard.card(wrap, fill="x")
        # The banner is packed with before=<this>, so the anchor has to be a
        # SIBLING. Pointing it at the container silently raised inside the
        # banner's own try/except, and an update the customer was never offered
        # is indistinguishable from an update that was never published.
        self._ctrl_frame = top
        inner = tk.Frame(top, bg=ui_dashboard.CARD)
        inner.pack(fill="x", padx=18, pady=16)
        self.lbl_sync_state = tk.Label(inner, text="Starting…",
                                       font=(ui_dashboard.FACE, 17, "bold"),
                                       fg=ui_dashboard.INK, bg=ui_dashboard.CARD,
                                       anchor="w")
        self.lbl_sync_state.pack(anchor="w")
        self.lbl_update = tk.Label(inner, text="", font=(ui_dashboard.FACE, 9),
                                   fg=ui_dashboard.MUTED, bg=ui_dashboard.CARD,
                                   anchor="w")
        self.lbl_update.pack(anchor="w", pady=(2, 0))

        meta = tk.Frame(inner, bg=ui_dashboard.CARD)
        meta.pack(fill="x", pady=(14, 0))
        self.lbl_company = ui_dashboard.label(
            meta, "Company: " + (getattr(self.cfg, "company_name", None) or "—"),
            size=9, side="left", padx=(0, 22))
        self.lbl_last_sync = ui_dashboard.label(meta, "Last sync: never", size=9,
                                                side="left", padx=(0, 22))
        self.lbl_version = ui_dashboard.label(
            meta, "Agent v" + (self.cfg.agent_version or "?"), size=9, side="left")

        acts = tk.Frame(wrap, bg=ui_dashboard.PAGE)
        acts.pack(fill="x", pady=(14, 0))
        ttk.Button(acts, text="Sync Now", style="Primary.TButton",
                   command=self.on_sync_now).pack(side="left")
        self.btn_start = ttk.Button(acts, text="Start", command=self.on_start)
        self.btn_start.pack(side="left", padx=(8, 0))
        self.btn_stop = ttk.Button(acts, text="Stop", command=self.on_stop,
                                   state="disabled")
        self.btn_stop.pack(side="left", padx=(6, 0))
        ttk.Button(acts, text="Open Logs Folder",
                   command=self.on_open_logs).pack(side="left", padx=(6, 0))
        ttk.Button(acts, text="Uninstall", style="Danger.TButton",
                   command=self.on_uninstall).pack(side="right")
        ttk.Button(acts, text="Sign in again",
                   command=self.on_reactivate_prompt).pack(side="right", padx=(0, 8))

    def _build_sync_page(self, page) -> None:
        body = tk.Frame(page, bg=ui_dashboard.PAGE)
        body.pack(fill="both", expand=True, padx=22, pady=18)
        left = tk.Frame(body, bg=ui_dashboard.PAGE)
        left.pack(side="left", fill="both", expand=True)
        rail = tk.Frame(body, bg=ui_dashboard.PAGE, width=ui_dashboard.RAIL_W)
        rail.pack(side="right", fill="y", padx=(16, 0))
        rail.pack_propagate(False)

        top = ui_dashboard.card(left, fill="x")
        head = tk.Frame(top, bg=ui_dashboard.CARD)
        head.pack(fill="x", padx=18, pady=(14, 4))
        self.lbl_sync_title = tk.Label(head, text="Waiting for the next sync",
                                       font=(ui_dashboard.FACE, 14, "bold"),
                                       fg=ui_dashboard.INK, bg=ui_dashboard.CARD,
                                       anchor="w")
        self.lbl_sync_title.pack(anchor="w")
        self.lbl_sync_sub = tk.Label(head, text="", font=(ui_dashboard.FACE, 9),
                                     fg=ui_dashboard.MUTED, bg=ui_dashboard.CARD,
                                     anchor="w")
        self.lbl_sync_sub.pack(anchor="w")

        self.stepper = ui_dashboard.Stepper(top)
        barbox = tk.Frame(top, bg=ui_dashboard.CARD)
        barbox.pack(fill="x", padx=18, pady=(4, 6))
        self.progress = ui_dashboard.ProgressBar(barbox)
        foot = tk.Frame(top, bg=ui_dashboard.CARD)
        foot.pack(fill="x", padx=18, pady=(0, 14))
        self.lbl_step = ui_dashboard.label(foot, "Current step:  —", size=9,
                                           side="left")
        self.lbl_elapsed = ui_dashboard.label(foot, "", size=9, fg=ui_dashboard.MUTED,
                                              side="right")

        # The action bar is packed BEFORE the activity card and anchored to the
        # bottom, so the card gives up space to it rather than pushing it off
        # the window — the buttons are the one thing that must never be clipped.
        bar = tk.Frame(left, bg=ui_dashboard.PAGE)
        bar.pack(side="bottom", fill="x", pady=(14, 0))
        ttk.Button(bar, text="Sync Now", style="Primary.TButton",
                   command=self.on_sync_now).pack(side="left")
        # No Pause. The loop can run or be stopped; there is no third state, and
        # a button that quietly means "stop" is worse than one that says it.
        ttk.Button(bar, text="Stop Sync", style="Danger.TButton",
                   command=self.on_stop).pack(side="right")

        actcard = ui_dashboard.card(left, fill="both", expand=True, pady=(14, 0))
        ui_dashboard.label(actcard, "Sync Activity", size=11, bold=True,
                           fg=ui_dashboard.INK, anchor="w", padx=16, pady=(14, 8))
        holder = tk.Frame(actcard, bg=ui_dashboard.CARD)
        holder.pack(fill="both", expand=True, padx=16, pady=(0, 14))
        self.acts = ui_dashboard.ActivityTable(holder)

        self.rail = ui_dashboard.DetailRail(rail)
        self.rail.set("company", getattr(self.cfg, "company_name", None) or "—")
        self.rail.set("path", getattr(self.cfg, "tally_exe", "") or "—")
        self.rail.set("type", "Full sync")
        self.rail.set("status", "Idle")

    def _build_history(self, page) -> None:
        wrap = ui_dashboard.card(page, fill="both", expand=True, padx=22, pady=18)
        ui_dashboard.label(wrap, "Sync History", size=11, bold=True,
                           fg=ui_dashboard.INK, anchor="w", padx=16, pady=(14, 4))
        ui_dashboard.label(wrap, "Completed cycles from this session and the "
                                 "agent's log.", size=9, fg=ui_dashboard.MUTED,
                           anchor="w", padx=16, pady=(0, 8))
        holder = tk.Frame(wrap, bg=ui_dashboard.CARD)
        holder.pack(fill="both", expand=True, padx=16, pady=(0, 14))
        self.history = ui_dashboard.ActivityTable(holder)

    def _build_settings_page(self, page) -> None:
        wrap = ui_dashboard.card(page, fill="both", expand=True, padx=22, pady=18)
        st = tk.Frame(wrap, bg=ui_dashboard.CARD)
        st.pack(fill="both", expand=True, padx=16, pady=14)
        self._build_settings(st)

    def _build_logs(self, page) -> None:
        wrap = ui_dashboard.card(page, fill="both", expand=True, padx=22, pady=18)
        head = tk.Frame(wrap, bg=ui_dashboard.CARD)
        head.pack(fill="x", padx=16, pady=(14, 8))
        ui_dashboard.label(head, "Agent Log", size=11, bold=True,
                           fg=ui_dashboard.INK, side="left")
        ttk.Button(head, text="Open Logs Folder",
                   command=self.on_open_logs).pack(side="right")
        # The raw tail stays a console: these are log LINES, not rows, and the
        # customer is usually here to copy one into a support email.
        self.activity = tk.Text(wrap, height=10, wrap="word", state="disabled",
                                background="#0f172a", foreground="#cbd5e1",
                                insertbackground="#cbd5e1", relief="flat",
                                font=("Consolas", 9), padx=10, pady=8)
        self.activity.pack(fill="both", expand=True, padx=16, pady=(0, 14))

    def _build_help(self, page) -> None:
        wrap = ui_dashboard.card(page, fill="x", padx=22, pady=18)
        ui_dashboard.label(wrap, "Help & Support", size=11, bold=True,
                           fg=ui_dashboard.INK, anchor="w", padx=16, pady=(14, 6))
        for line in (
                "1.  Keep TallyPrime open on this computer. The agent reads it "
                "through Tally's own gateway.",
                "2.  Sync runs every " + str(self.cfg.sync_interval or 60) +
                " seconds; 'Sync Now' runs one immediately.",
                "3.  If something looks wrong, open the log and send us the last "
                "few lines.",
        ):
            ui_dashboard.label(wrap, line, size=9, anchor="w", padx=16, pady=2)
        row = tk.Frame(wrap, bg=ui_dashboard.CARD)
        row.pack(fill="x", padx=16, pady=(10, 16))
        ui_dashboard.label(row, "Email:  " + SUPPORT_EMAIL, size=9, bold=True,
                           fg=ui_dashboard.BLUE, side="left")

    def _build_about(self, page) -> None:
        wrap = ui_dashboard.card(page, fill="x", padx=22, pady=18)
        ui_dashboard.label(wrap, APP_TITLE, size=13, bold=True, fg=ui_dashboard.INK,
                           anchor="w", padx=16, pady=(16, 2))
        ui_dashboard.label(wrap, "Desktop Sync Agent", size=9,
                           fg=ui_dashboard.MUTED, anchor="w", padx=16)
        for cap, val in (("Version", "v" + (self.cfg.agent_version or "?")),
                         ("Installed in", app_dir()),
                         ("Machine ID", (self.cfg.machine_id or "")[:16] + "…"),
                         ("Sync mode", "Windows service" if self.service_mode
                          else "Runs while this window is open")):
            row = tk.Frame(wrap, bg=ui_dashboard.CARD)
            row.pack(fill="x", padx=16, pady=3)
            ui_dashboard.label(row, cap, size=9, fg=ui_dashboard.MUTED,
                               side="left")
            ui_dashboard.label(row, val, size=9, bold=True, fg=ui_dashboard.INK,
                               side="right")
        tk.Frame(wrap, bg=ui_dashboard.CARD, height=12).pack()

    # -- settings panel ---------------------------------------------------- #
    def _build_settings(self, st) -> None:
        st.columnconfigure(1, weight=1)
        cfg = self.cfg
        # NOTE: the server URL is baked into the exe (constants.API_BASE_URL) so
        # there is no editable Server URL field here - only non-secret settings.
        # The license key is NEVER displayed or pre-filled here: per owner
        # policy the key is visible ONLY in the cloud super-admin License View.
        # The Dashboard shows a non-secret "License: Activated" status and a
        # separate explicit "Re-activate with new key..." button that opens a
        # blank, masked prompt - the stored key is never read into any widget.
        self.s_tally = tk.StringVar(value=cfg.tally_exe)
        self.s_interval = tk.StringVar(value=str(cfg.sync_interval))
        self.s_autoupdate = tk.BooleanVar(value=bool(cfg.auto_update))
        self.s_autostart = tk.BooleanVar(
            value=os.path.exists(os.path.join(startup_dir(), STARTUP_VBS_NAME)))

        def row(r, label, var, browse=None):
            ttk.Label(st, text=label).grid(row=r, column=0, sticky="w",
                                           padx=(0, 8), pady=4)
            e = ttk.Entry(st, textvariable=var)
            e.grid(row=r, column=1, sticky="ew", pady=4)
            if browse:
                ttk.Button(st, text="Browse", command=browse).grid(
                    row=r, column=2, padx=(8, 0), pady=4)
            return e

        # Non-secret license status: "Activated" when an agent token is stored;
        # NEVER the key itself (the key is not available/shown locally).
        activated = is_activated(cfg)
        ttk.Label(st, text="License:").grid(row=0, column=0, sticky="w",
                                            padx=(0, 8), pady=4)
        self.lbl_license = ttk.Label(
            st,
            text="Activated" if activated else "Not activated",
            foreground="#0a7d28" if activated else "#b00020")
        self.lbl_license.grid(row=0, column=1, sticky="w", pady=4)
        ttk.Button(st, text="Sign in again...",
                   command=self.on_reactivate_prompt).grid(
            row=0, column=2, padx=(8, 0), pady=4)

        row(1, "Tally exe:", self.s_tally, self._browse_tally)
        self.e_interval = row(2, "Sync interval (s):", self.s_interval)
        ttk.Checkbutton(st, text="Auto-update the agent",
                        variable=self.s_autoupdate).grid(
            row=3, column=0, columnspan=2, sticky="w", pady=(6, 0))
        ttk.Checkbutton(st, text="Start automatically at logon",
                        variable=self.s_autostart).grid(
            row=4, column=0, columnspan=2, sticky="w")
        ttk.Button(st, text="Save settings", command=self.on_save).grid(
            row=5, column=0, sticky="w", pady=(10, 0))
        self.s_msg = ttk.Label(st, text="", foreground="#0a7d28")
        self.s_msg.grid(row=5, column=1, sticky="w", pady=(10, 0))

    def _focus_interval(self) -> None:
        """Put the cursor in the interval box after a rejected Save."""
        try:
            self.ui.select("settings")
            self.e_interval.focus_set()
            self.e_interval.select_range(0, "end")
        except Exception:
            pass

    def _browse_tally(self) -> None:
        chosen = filedialog.askopenfilename(
            title="Locate tally.exe",
            filetypes=[("Tally executable", "tally.exe"), ("All files", "*.*")])
        if chosen:
            self.s_tally.set(chosen)

    # -- log tap ----------------------------------------------------------- #
    def _install_log_tap(self) -> None:
        """Attach a queue-backed handler to the engine loggers (once)."""
        if self.app._tray_log_tap_installed:
            return
        try:
            import logging
            tap = QueueLogHandler(self.controller.log_q)
            for name in ("sync-agent", "gui-agent", "agent"):
                logging.getLogger(name).addHandler(tap.handler)
            # The engine builds its ApiClient with get_logger("gui-agent") here,
            # so its INFO lines reach this tap.
            self.app._tray_log_tap_installed = True
        except Exception:
            pass

    # -- controls ---------------------------------------------------------- #
    def _set_sync_enabled(self, enabled: bool) -> None:
        """Persist the operator's Start/Stop intent so it survives a reboot.

        The Windows service is registered auto-start, so without this a
        deliberate Stop lasts only until the next boot — the button would mean
        "pause until I restart the PC", which is not what anyone pressing Stop
        expects. The running loop re-reads this flag every cycle
        (sync_agent._sync_is_enabled), so it also takes effect immediately in the
        service process without restarting it.

        Best-effort: a config we cannot write must not block the Start/Stop the
        operator just asked for — the in-session action still happens, it simply
        will not outlive the reboot.
        """
        try:
            self.cfg.sync_enabled = bool(enabled)
            self.cfg.save()
        except Exception as exc:                            # noqa: BLE001
            self.logger.warning("Could not persist sync_enabled=%s: %s", enabled, exc)

    def on_start(self) -> None:
        """Start syncing. Service mode -> start the service (elevated); portable
        mode -> start the in-process daemon thread."""
        self._set_sync_enabled(True)
        if self.service_mode:
            # Trying the real service again clears any user pause on the fallback.
            self._fallback_paused = False
            self._service_action("start-service", "Starting the service...")
            return
        if self.controller.is_running():
            return
        # Re-read config from disk so a just-saved change takes effect.
        cfg = load_config_safe()
        self.cfg = cfg
        if self.controller.start(cfg, self.logger):
            self._activity("[..] Starting sync...")
            self.btn_start.configure(state="disabled")
            self.btn_stop.configure(state="normal")

    def on_stop(self) -> None:
        """Stop syncing. Service mode -> stop the service (elevated); portable
        mode -> signal the in-process loop to stop.

        Also records the intent, so the auto-start service does not simply bring
        syncing back on the next boot.
        """
        self._set_sync_enabled(False)
        if self.service_mode:
            # If we're syncing IN-PROCESS (service down), Stop pauses that so the
            # next status tick doesn't auto-restart it; otherwise stop the service.
            if self._fallback_active or self._fallback_paused:
                self._fallback_paused = True
                self._stop_inprocess_fallback(user=True)
                self._connected = False
                self._set_status(False)
                self.btn_start.configure(state="normal")
                self.btn_stop.configure(state="disabled")
                return
            self._service_action("stop-service", "Stopping the service...")
            return
        self._activity("[..] Stopping sync...")

        def worker():
            self.controller.stop(timeout=6.0)
            self.app.root.after(0, self._after_stop)
        threading.Thread(target=worker, name="stop-sync", daemon=True).start()

    def _after_stop(self) -> None:
        self._connected = False
        self._set_status(False)
        self.btn_start.configure(state="normal")
        self.btn_stop.configure(state="disabled")
        self._activity("[OK] Sync stopped.")

    # -- self-update ------------------------------------------------------- #
    # The engine already updates itself on its own schedule (sync_agent.
    # maybe_self_update, every cfg.update_check_cycles cycles). What was missing
    # was any way to SEE that from the window: a customer with auto-update off —
    # or one who simply wants the new build now — had no signal and no button,
    # so every release meant mailing an exe. These three methods are that
    # signal; the update itself is still the engine's code path, not a copy.

    def _check_for_update(self) -> None:
        """Ask the cloud whether a newer exe is published (background thread).

        Best-effort and silent on failure: an offline agent, an expired token or
        a cloud hiccup must leave the Dashboard exactly as it was, never show a
        scary banner. Only a confirmed-newer version turns the banner on.
        """
        if self._update_busy or self._update_available:
            return          # already updating, or already showing the banner.

        def work():
            info = {}
            try:
                api = sync_agent.build_api(self.cfg, self.logger)
                token = self.cfg.get_token()
                if token:
                    info = api.get_latest_version(
                        token, installed_version=self.cfg.agent_version) or {}
            except Exception as exc:                       # noqa: BLE001
                self.logger.debug("Update check failed: %s", exc)
                return

            latest = str(info.get("latest_version") or "").strip()
            try:
                newer = bool(latest) and sync_agent._is_newer(latest, self.cfg.agent_version)
            except Exception:                              # noqa: BLE001
                newer = False
            if not newer:
                return
            self.app.root.after(0, lambda: self._show_update_bar(latest, info))

        threading.Thread(target=work, name="update-check", daemon=True).start()

    def _show_update_bar(self, latest: str, info: dict) -> None:
        """Reveal the banner (Tk thread). Mandatory releases hide 'Later'."""
        self._update_available = latest
        self._update_info = info or {}
        mandatory = bool(self._update_info.get("mandatory"))
        try:
            self.lbl_update_msg.configure(
                text=("Required update: v%s  (installed v%s)" if mandatory else
                      "Update available: v%s  (installed v%s)")
                     % (latest, self.cfg.agent_version or "?"),
                foreground=(BAD_RED if mandatory else WARN_AMBER))
            if mandatory:
                self.btn_update_later.pack_forget()
            self.update_bar.pack(fill="x", pady=(12, 0), before=self._ctrl_frame)
        except Exception:                                  # noqa: BLE001
            return
        self._activity("[..] Version v%s is available." % latest)

    def _hide_update_bar(self) -> None:
        """'Later' — hide until the next Dashboard open. The engine's own
        auto-update is untouched; this only dismisses the banner."""
        try:
            self.update_bar.pack_forget()
        except Exception:                                  # noqa: BLE001
            pass

    def on_update_now(self) -> None:
        """Download + swap the exe, via the engine's own update path.

        ``maybe_self_update`` ends by launching the detached updater batch file
        and calling ``sys.exit(0)`` — the running exe cannot replace itself while
        it is open. So this window IS expected to close; the batch relaunches the
        new build. Anything short of that (no newer version, download failed,
        checksum mismatch) returns normally and we say so instead of hanging on
        a disabled button.
        """
        if self._update_busy:
            return
        latest = self._update_available or "?"
        if not ui_signin.confirm(
                self.app.root,
                "%s will close and reopen on the new version. Syncing resumes "
                "automatically — your licence and settings are kept." % APP_TITLE,
                title="Update to v%s now?" % latest, ok="Update now"):
            return

        self._update_busy = True
        try:
            self.btn_update.configure(state="disabled", text="Updating...")
        except Exception:                                  # noqa: BLE001
            pass
        self._activity("[..] Downloading v%s..." % latest)

        def work():
            err = None
            try:
                api = sync_agent.build_api(self.cfg, self.logger)
                # forced=True: the user asked for it, so this ignores the
                # auto-update toggle and the confirm prompt (we just confirmed).
                sync_agent.maybe_self_update(self.cfg, self.logger, api, forced=True)
            except SystemExit:
                raise           # the swap is happening — let the process go.
            except Exception as exc:                       # noqa: BLE001
                err = str(exc)

            def done():
                # Still here => the swap did not happen (see docstring).
                self._update_busy = False
                try:
                    self.btn_update.configure(state="normal", text="Update Now")
                except Exception:                          # noqa: BLE001
                    pass
                if err:
                    self._activity("[x] Update failed: " + err, error=True)
                    ui_signin.alert(self.app.root, err, title="Update failed")
                else:
                    self._activity("[x] Update did not complete — still on v%s."
                                   % (self.cfg.agent_version or "?"), error=True)
                    ui_signin.alert(
                        self.app.root,
                        "The agent is still running v%s and syncing normally. "
                        "Check the logs, then try again."
                        % (self.cfg.agent_version or "?"),
                        kind="warning", title="The update could not be applied")
            self.app.root.after(0, done)

        threading.Thread(target=work, name="self-update", daemon=True).start()

    # -- in-process fallback (service mode, service not running) ----------- #
    def _start_inprocess_fallback(self) -> None:
        """Run the syncer inside the app because the Windows service is down.

        Keeps the agent Connected + streaming logs + pushing cloud heartbeats
        instead of a dead Disconnected screen. No-op while the user has paused it
        (clicked Stop) or the controller is already running.
        """
        if self._fallback_paused:
            return
        if self.controller.is_running():
            self._fallback_active = True
            return
        cfg = load_config_safe()
        self.cfg = cfg
        if self.controller.start(cfg, self.logger):
            self._fallback_active = True
            self._activity("[fallback] Windows service not running - syncing "
                           "in-process from the app.")

    def _stop_inprocess_fallback(self, user: bool = False) -> None:
        """Hand syncing back to the service (it came up), or stop on user request."""
        if not self._fallback_active and not self.controller.is_running():
            self._fallback_active = False
            return
        self._fallback_active = False
        try:
            self.controller.stop(timeout=4.0)
        except Exception:
            pass
        if user:
            self._activity("[OK] In-process sync stopped.")
        else:
            self._activity("[fallback] Windows service is running again - "
                           "handed sync back to it.")

    def on_sync_now(self) -> None:
        """Force an immediate cycle.

        Service mode: drop the ``.sync_now`` trigger file the running service's
        loop watches (it wakes and runs a cycle immediately) - NO second syncer
        is created. If the service is stopped, start it instead. Portable mode:
        (re)start the in-process loop, whose first cycle runs immediately.
        """
        if self.service_mode:
            alive = service_state() == "running"
            if not alive:
                # A NON-ADMIN GUI cannot query the SCM (reads not-running even
                # while the service is happily syncing). Trust a FRESH
                # .status.json (running + recent ts) as the reliable "alive"
                # signal so Sync Now just NUDGES the running service instead of
                # trying to (re)start it — which would pop a UAC prompt that then
                # reads "cancelled or failed".
                snap = self._read_status_file()
                if snap:
                    try:
                        alive = bool(snap.get("running")) and (
                            time.time() - float(snap.get("ts") or 0)) <= 150.0
                    except Exception:
                        alive = False
            if not alive:
                # Service genuinely down: sync IN-PROCESS right now (immediate
                # first cycle, Connected + logs) instead of a UAC prompt to
                # (re)start the Windows service.
                self._fallback_paused = False
                self._activity("[..] Sync Now: service is down - syncing "
                               "in-process from the app.")
                self._start_inprocess_fallback()
                return
            try:
                path = sync_agent.sync_now_path(self.cfg)
                with open(path, "w", encoding="ascii") as fh:
                    fh.write(str(time.time()))
                self._activity("[..] Sync Now: asked the service to run a cycle "
                               "immediately.")
            except Exception as exc:
                self._activity("[x] Could not trigger Sync Now: " + str(exc))
            return
        if not self.controller.is_running():
            self.on_start()
        else:
            self._activity("[..] A sync cycle will run on the next interval; "
                           "use Stop then Start to force one now.")

    # -- service control + status (Phase 2 G) ------------------------------ #
    def _service_action(self, verb: str, msg: str) -> None:
        """Control the service off-thread, then refresh status.

        For start/stop we FIRST try IN-PROCESS (the installer granted this
        account start/stop rights) - NO UAC, instant. Only if that is denied (an
        older install without the grant) do we fall back to the elevated
        re-launch. install/remove always elevate.
        """
        can_direct = verb in ("start-service", "stop-service")
        self._activity("[..] " + msg
                       + ("" if can_direct else " (a UAC prompt may appear)"))

        def worker():
            ok = False
            try:
                if can_direct and service_direct(verb):
                    ok = True
                else:
                    if can_direct:
                        # In-process denied -> fall back to an elevated re-launch.
                        self.app.root.after(0, lambda: self._activity(
                            "[..] Needs admin - a UAC prompt may appear..."))
                    ok = run_elevated_verb(verb, wait=True, timeout=60)
            except Exception as exc:
                self.logger.error("Service action %s failed: %s", verb, exc)

            def done():
                if ok:
                    self._activity("[OK] Service " + verb.split("-")[0] + " done.")
                else:
                    self._activity("[!] Service " + verb.split("-")[0]
                                   + " was cancelled or failed.")
                self._refresh_service_status()
            self.app.root.after(0, done)
        threading.Thread(target=worker, name="svc-" + verb, daemon=True).start()

    def _refresh_service_status(self) -> None:
        """Query the service state + read .status.json; update the UI (Tk thread)."""
        if not self.service_mode:
            return
        state = service_state()
        running = (state == "running")
        # "Connected" = the agent's last cycle reached the cloud recently. The
        # service's OWN .status.json (running + ok + a fresh timestamp) is the
        # RELIABLE signal and does NOT depend on the SCM query, which can fail for
        # a non-admin GUI and would then falsely read Disconnected even while the
        # service is happily syncing. Fall back to the SCM 'running' state only
        # when there is no fresh status file.
        snap = self._read_status_file()
        status_fresh = False
        status_alive = False  # running + fresh ts even if ok is briefly false.
        if snap:
            try:
                import time as _t
                age = _t.time() - float(snap.get("ts") or 0)
                fresh_ts = age <= 150.0
                status_fresh = (bool(snap.get("running")) and bool(snap.get("ok"))
                                and fresh_ts)
                status_alive = bool(snap.get("running")) and fresh_ts
            except Exception:
                status_fresh = False
                status_alive = False
        if status_fresh:
            connected = True
        elif snap:
            connected = running and bool(snap.get("ok"))
        else:
            connected = running
        # Start/Stop reflect the EFFECTIVE running state, not the raw SCM query.
        # The SCM query fails for a NON-ADMIN GUI and would falsely read
        # not-running, wrongly enabling Start on a happily-syncing service. A
        # fresh .status.json (running, with a recent ts - even if ok briefly
        # false) is the reliable "the service is alive" signal, so OR it in.
        service_up = running or status_fresh or status_alive
        # In-process fallback: if the Windows service is genuinely down, sync
        # from the app (Connected + logs + cloud heartbeats) instead of a dead
        # Disconnected screen, and hand back the moment the service is alive
        # again. Safe to key both edges off `service_up`: the in-process syncer
        # only enqueues status (it never writes .status.json), so a fresh status
        # file always means the SERVICE is alive -> no start/stop flip-flop.
        if self._fallback_active:
            if service_up:
                self._stop_inprocess_fallback()
        elif not service_up:
            self._start_inprocess_fallback()
        elif self._fallback_paused:
            # Service is alive again; a leftover user-pause is moot. Clear it so
            # the Stop button controls the service, not the (gone) fallback.
            self._fallback_paused = False

        if self._fallback_active:
            # The fallback's own cycle events drive the Connected dot (via
            # _drain_status); don't stomp it here with the service's Disconnected.
            self.btn_start.configure(state="disabled")
            self.btn_stop.configure(state="normal")
        else:
            self._set_status(connected)
            self._connected = connected
            if service_up:
                self.btn_start.configure(state="disabled")
                self.btn_stop.configure(state="normal")
            else:
                self.btn_start.configure(state="normal")
                self.btn_stop.configure(state="disabled")
        if snap:
            ls = snap.get("last_sync")
            if ls:
                self._last_sync_ts = ls
                self.lbl_last_sync.configure(
                    text="Last sync: " + self._fmt_ts(ls))
            ver = snap.get("version")
            if ver:
                self.lbl_version.configure(text="Version: " + str(ver))
            # REAL progress bar in SERVICE mode: the service writes the latest
            # push/pull tick into .status.json; reflect it here. When there's no
            # active push but we're connected, show a calm 100% "Up to date".
            # (When the in-process fallback drives sync, its own progress events
            # update the bar via _drain_status, so don't stomp it here.)
            if not self._fallback_active:
                prog = snap.get("progress")
                if isinstance(prog, dict) and prog.get("total"):
                    self._set_progress(prog.get("done"), prog.get("total"),
                                       prog.get("phase"))
                elif connected:
                    self._show_idle_ok()

    def _read_status_file(self) -> dict:
        """Read + parse the service's .status.json (best-effort; {} on any error)."""
        try:
            import json
            path = sync_agent.status_path(self.cfg)
            if not os.path.isfile(path):
                return {}
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    # -- live log tail (service mode) ------------------------------------- #
    # Max lines kept in the Activity widget so a long-running tail never grows
    # memory unbounded; the oldest lines are trimmed as new ones arrive.
    _ACTIVITY_MAX_LINES = 600

    def _tail_service_log(self) -> None:
        """Stream new bytes of the service's agent.log into the Activity console.

        Opens <install_dir>/logs/agent.log, seeks to the END on the first read
        (so only NEW activity shows), then on each tick reads appended bytes and
        appends whole new lines. Handles the file not existing yet and rotation /
        truncation (size shrank or file replaced) by re-seeking to the start.
        Best-effort: any error is swallowed and the tail simply retries next tick.
        Re-arms itself via root.after while in service mode.
        """
        if not self.service_mode:
            return
        try:
            self._read_log_appended()
        except Exception:
            pass
        try:
            self.app.root.after(1500, self._tail_service_log)
        except Exception:
            pass

    def _read_log_appended(self) -> None:
        """Read newly appended log bytes and append complete lines to Activity."""
        path = self._logtail_path
        try:
            size = os.path.getsize(path)
        except OSError:
            # File not there yet (logs/ created on first service log) - wait.
            return
        if not self._logtail_inited:
            # First read: skip existing history, start at the END (only new lines).
            self._logtail_pos = size
            self._logtail_buf = ""
            self._logtail_inited = True
        elif size < self._logtail_size:
            # Rotation / truncation: the live file shrank or was replaced -> read
            # it from the beginning so we do not skip the fresh content.
            self._logtail_pos = 0
            self._logtail_buf = ""
        self._logtail_size = size
        if size <= self._logtail_pos:
            return  # nothing new.
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                fh.seek(self._logtail_pos)
                chunk = fh.read()
                self._logtail_pos = fh.tell()
        except OSError:
            return
        if not chunk:
            return
        data = self._logtail_buf + chunk
        # Keep a trailing partial line (no newline yet) for the next read.
        if data.endswith("\n"):
            self._logtail_buf = ""
            lines = data.splitlines()
        else:
            parts = data.splitlines()
            self._logtail_buf = parts[-1] if parts else ""
            lines = parts[:-1]
        if not lines:
            return
        for line in lines:
            self._activity(line, scroll=False)
        self._trim_activity()
        try:
            self.activity.see("end")
        except Exception:
            pass

    def _trim_activity(self) -> None:
        """Cap the Activity widget to the last N lines to bound memory."""
        try:
            # Text index "end-1c" is the last char; line count is its line number.
            total = int(self.activity.index("end-1c").split(".")[0])
            if total > self._ACTIVITY_MAX_LINES:
                drop = total - self._ACTIVITY_MAX_LINES
                self.activity.configure(state="normal")
                self.activity.delete("1.0", "%d.0" % (drop + 1))
                self.activity.configure(state="disabled")
        except Exception:
            pass

    def on_open_logs(self) -> None:
        logs = os.path.join(app_dir(), "logs")
        try:
            os.makedirs(logs, exist_ok=True)
            if os.name == "nt":
                os.startfile(logs)  # type: ignore[attr-defined]
            else:
                subprocess.Popen(["xdg-open", logs])
        except Exception as exc:
            ui_signin.alert(self.app.root, str(exc),
                            title="Could not open the logs folder")

    def on_save(self) -> None:
        """Persist the NON-SECRET settings only.

        Save NEVER touches the license key: the key is not shown on the
        Dashboard and a normal Save must not need or display it. Changing the
        key is an explicit action (the "Re-activate with new key..." button),
        which prompts for a fresh key in a blank, masked entry. Here we load the
        stored config (preserving its already-stored, encrypted key untouched)
        and write back only the interval, tally path and toggles.
        """
        # THE INTERVAL IS VALIDATED, NOT SILENTLY CORRECTED. It used to fall
        # back to 60 on anything odd, so typing "10" and pressing Save left the
        # field reading 10 while the agent ran on 60 — a setting that appears to
        # work and does not.
        #
        # The floor is real, not tidiness: every cycle makes TallyPrime compile
        # and evaluate TDL for a dozen reports, and it is a DESKTOP app the
        # customer is also typing into. Asking it for everything every few
        # seconds is how it ends up wedged behind an "Internal Error" box.
        raw = self.s_interval.get().strip()
        try:
            interval = int(raw or "0")
        except ValueError:
            ui_signin.alert(self.app.root,
                            "Sync interval must be a whole number of seconds.",
                            title="Check the sync interval")
            self._focus_interval()
            return
        if interval < MIN_SYNC_INTERVAL:
            ui_signin.alert(
                self.app.root,
                "The shortest sync interval is %d seconds. Anything faster "
                "keeps TallyPrime busy answering the agent while somebody is "
                "trying to use it." % MIN_SYNC_INTERVAL,
                title="Sync interval is too short")
            self._focus_interval()
            return
        if interval > MAX_SYNC_INTERVAL:
            ui_signin.alert(
                self.app.root,
                "The longest sync interval is %d seconds (%d hours)."
                % (MAX_SYNC_INTERVAL, MAX_SYNC_INTERVAL // 3600),
                title="Sync interval is too long")
            self._focus_interval()
            return

        # Load the stored config so the existing (encrypted) token is
        # carried through unchanged; we only overwrite non-secret settings.
        cfg = load_config_safe()
        cfg.tally_exe = self.s_tally.get().strip()
        cfg.sync_interval = interval
        cfg.auto_update = bool(self.s_autoupdate.get())

        try:
            cfg.save()
        except Exception as exc:
            ui_signin.alert(self.app.root, str(exc),
                            title="Could not save settings")
            return

        # Auto-start toggle -> add/remove the Startup launcher.
        if bool(self.s_autostart.get()):
            installed_exe = os.path.join(app_dir(), INSTALLED_EXE_NAME)
            if not os.path.isfile(installed_exe):
                installed_exe = exe_path()
            write_startup_vbs(installed_exe)
        else:
            remove_startup_vbs()

        self.cfg = cfg
        self.s_msg.configure(text="Saved.", foreground="#0a7d28")
        self._activity("[OK] Settings saved.")
        self.lbl_version.configure(text="Version: " + (cfg.agent_version or "?"))

    def on_reactivate_prompt(self) -> None:
        """Sign this computer in again — to a different account, or after it
        was disconnected from the web.

        There is no dialog any more. Sign-in needs a password AND a code
        emailed to the account, which is two screens; re-implementing them in a
        Toplevel would mean two copies of the same flow drifting apart. This
        clears the stored token and hands the customer back to the wizard,
        which is the one place that flow lives.

        The token is cleared FIRST. If it were left in place and the customer
        closed the wizard, the agent would keep syncing under the old account
        while the UI implied it had been signed out.
        """
        if not ui_signin.confirm(
                self.app.root, "Syncing stops until you finish signing in.",
                title="Sign this computer in again?", ok="Sign in again"):
            return

        try:
            cfg = load_config_safe()
            cfg.clear_token()
            cfg.save()
        except Exception as exc:
            self.s_msg.configure(text="Could not sign out: " + str(exc),
                                 foreground="#b00020")
            return

        # Stop the service before the wizard reinstalls it; a running service
        # holds the exe open and the install step would fail on the file copy.
        try:
            if self.service_mode and service_state() == "running":
                self._service_action("stop-service", "Stopping the agent...")
        except Exception:
            pass

        self._activity("[..] Signed out. Sign in to reconnect this computer.")
        self.app.show_setup(load_config_safe())


    def on_uninstall(self) -> None:
        """Fully uninstall: stop+remove the service, remove launcher + shortcuts,
        and delete the agent's files - but KEEP the logs/ folder (via a detached
        cleanup batch).

        Best-effort throughout with clear messages. The service stop/remove needs
        admin (one UAC prompt via the elevated verb). The running exe lives INSIDE
        the install folder, so it cannot delete itself; instead a DETACHED batch
        is dropped that waits for this process to exit, removes every file +
        subfolder EXCEPT logs/, then deletes itself. After spawning it we close
        the GUI so the exe is released and the batch can finish.
        """
        # WHAT GETS DELETED IS THE INSTALL FOLDER, not "wherever this exe is".
        # Those are the same thing only when the customer opened the installed
        # copy. Open the downloaded exe instead — which is exactly what somebody
        # does when they go looking for the app they just installed — and the
        # old code aimed the uninstall at the Downloads folder it happened to be
        # sitting in.
        install_dir = installed_root()
        can_purge = bool(install_dir)
        inside = bool(install_dir) and (
            os.path.normcase(install_dir) == os.path.normcase(app_dir()))
        if can_purge:
            prompt = (f"Uninstall {APP_TITLE}?\n\nThis stops syncing, removes "
                      "the background service / auto-start launcher and shortcuts, "
                      "and deletes the agent's files from:\n\n  " + install_dir +
                      "\n\nThe logs\\ folder is KEPT for your reference. This "
                      "window will close to finish. This cannot be undone.")
        else:
            prompt = (f"Uninstall {APP_TITLE}?\n\nThis stops syncing and "
                      "removes the background service / auto-start launcher and "
                      "shortcuts. The install folder will be LEFT in place (it "
                      "does not look like a real install folder, so it is not "
                      "auto-deleted); you can remove it manually.")
        if not ui_signin.confirm(self.app.root, prompt, title="Uninstall %s?" % APP_TITLE,
                                 ok="Uninstall"):
            return
        self._activity("[..] Uninstalling...")
        had_service = self.service_mode

        def worker():
            # Best-effort GRACEFUL go-offline FIRST, so the cloud flips to
            # Disconnected at once even if the service / loop was already stopped
            # (a stopped service never sent its own offline signal). Fully
            # non-blocking: a short timeout + swallowed errors mean an unreachable
            # cloud never delays or blocks the uninstall.
            try:
                cfg = load_config_safe()
                token = cfg.get_token()
                if token:
                    api = sync_agent.build_api(cfg, self.logger)
                    api.go_offline(token)
            except Exception as exc:
                self.logger.debug("Uninstall go-offline failed (ignored): %s", exc)

            removed_service = False
            if had_service:
                # Stop + remove the Windows service (elevated; one UAC prompt).
                try:
                    removed_service = run_elevated_verb(
                        "remove-service", wait=True, timeout=60)
                except Exception as exc:
                    self.logger.error("Service remove failed: %s", exc)
            # Always clean up the in-process loop + fallback launcher + shortcuts.
            try:
                self.controller.stop(timeout=6.0)
            except Exception:
                pass
            remove_startup_vbs()
            remove_shortcuts()
            # Drop the install pointer too: a later exe must offer a FRESH
            # install, not try to update a folder that is being deleted.
            forget_install_dir()
            self.app.root.after(
                0, lambda: self._after_uninstall(
                    had_service, removed_service, install_dir, can_purge))
        threading.Thread(target=worker, name="uninstall", daemon=True).start()

    @staticmethod
    def _install_dir_needs_elevation(install_dir: str) -> bool:
        """True when deleting ``install_dir`` likely needs admin (not under the
        current user's profile / temp - e.g. it lives under C:\\ or Program Files)."""
        try:
            d = os.path.normcase(os.path.abspath(install_dir))
            safe_roots = []
            for env in ("USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"):
                val = os.environ.get(env, "")
                if val:
                    safe_roots.append(os.path.normcase(os.path.abspath(val)))
            for root in safe_roots:
                if d == root or d.startswith(root + os.sep):
                    return False  # under the user's own space -> no admin needed.
            return True  # anywhere else (C:\..., Program Files) -> assume elevated.
        except Exception:
            return True

    def _after_uninstall(self, had_service: bool, removed_service: bool,
                         install_dir: str, can_purge: bool) -> None:
        self.service_mode = service_installed()  # re-check (may now be gone)
        self._set_status(False)
        if had_service and not removed_service:
            # The service is still installed; do NOT delete the folder (its exe is
            # still referenced by the SCM). Let the operator retry.
            self._activity("[!] Could not remove the service (UAC declined?). "
                           "Auto-start launcher + shortcuts were removed; the "
                           "install folder was NOT deleted.")
            ui_signin.alert(
                self.app.root,
                "Re-run Uninstall and accept the prompt. The auto-start launcher "
                "and shortcuts were removed; the install folder was kept.",
                kind="warning",
                title="The background service could not be removed")
            self.btn_start.configure(state="normal")
            self.btn_stop.configure(state="disabled")
            return

        if not can_purge:
            self._activity("[OK] Uninstalled (service / auto-start + shortcuts "
                           "removed). Install folder left in place.")
            ui_signin.alert(
                self.app.root,
                "The background service / auto-start launcher and shortcuts were "
                "removed; syncing stopped. The install folder was left in place; "
                "you can delete it manually.",
                kind="success", title="Uninstalled")
            self.btn_start.configure(state="normal")
            self.btn_stop.configure(state="disabled")
            return

        # Spawn the detached cleanup batch, then close the GUI so this exe is
        # released and the batch can delete the folder.
        elevate = self._install_dir_needs_elevation(install_dir)
        launched = False
        try:
            launched = spawn_folder_cleanup(install_dir, elevated=elevate)
        except Exception as exc:
            self.logger.error("Folder cleanup spawn failed: %s", exc)
        if launched and inside:
            # We are running FROM the folder being deleted, so the exe has to be
            # released before the batch can finish — that is the only reason
            # this closes the window.
            self._activity("[OK] Uninstalled. Closing now so the agent files can "
                           "be removed (logs\\ is kept).")
            ui_signin.alert(
                self.app.root,
                "This window will now close; the agent files are removed in the "
                "background and the logs folder is kept for your reference.",
                kind="success", title=f"{APP_TITLE} has been uninstalled")
            try:
                self.app.root.after(200, self._force_quit)
            except Exception:
                self._force_quit()
        elif launched:
            # Driven from a copy of the exe that lives somewhere else. The
            # install folder goes; THIS exe stays exactly where the customer put
            # it, and the window stays open to say so.
            self._activity("[OK] Uninstalled. Removed: " + install_dir)
            ui_signin.alert(
                self.app.root,
                "The install folder was removed (its logs folder is kept). This "
                "copy of the app is untouched — you can close it, or sign in "
                "again to set the computer up from scratch.",
                kind="success", title=f"{APP_TITLE} has been uninstalled")
            self.btn_start.configure(state="disabled")
            self.btn_stop.configure(state="disabled")
        else:
            self._activity("[!] Uninstalled the service / launcher, but could not "
                           "start the folder cleanup. Delete the folder manually.")
            ui_signin.alert(
                self.app.root,
                "The service / auto-start launcher and shortcuts were removed, but "
                "the install folder could not be auto-deleted. You can close this "
                "window and delete:\n" + install_dir,
                kind="warning", title="Uninstalled, with one thing left")
            self.btn_start.configure(state="normal")
            self.btn_stop.configure(state="disabled")

    def _force_quit(self) -> None:
        """Tear down the window + process so the install dir is unlocked.

        Releases the single-instance lock (its lock file lives in the install dir,
        which the cleanup batch is about to delete), stops the tray + loop, then
        hard-exits so the exe is fully released for the detached rmdir.
        """
        try:
            self.app.quit_app()
        except Exception:
            pass
        try:
            os._exit(0)
        except Exception:
            pass

    # -- live pump --------------------------------------------------------- #
    def _poll(self) -> None:
        """Drain the status + log queues on the Tk thread (root.after loop).

        Portable mode drains the in-process status/log queues. Service mode has
        no in-process thread, so it polls the service state + .status.json
        snapshot the service writes (still draining the log tap for any lines).
        """
        try:
            if self.service_mode:
                self._poll_service()
                # When the in-process fallback is driving the sync, its status
                # events set the Connected dot + Last-sync just like portable mode.
                if self._fallback_active:
                    self._drain_status()
            else:
                self._drain_status()
            self._drain_logs()
            self._refresh_system_box()
        except Exception:
            pass
        # Version check: once shortly after the window opens, then hourly. Not
        # every tick — POLL_MS is 500ms, and the cloud does not publish a release
        # twice a second.
        try:
            self._update_ticks = getattr(self, "_update_ticks", 0) + 1
            if self._update_ticks in (20,) or self._update_ticks % self.UPDATE_CHECK_TICKS == 0:
                self._check_for_update()
        except Exception:
            pass
        # Reschedule.
        try:
            self.app.root.after(self.POLL_MS, self._poll)
        except Exception:
            pass

    def _poll_service(self) -> None:
        """Service mode: refresh the UI from the SCM state + .status.json.

        Only re-renders when the status file actually changed (mtime) or on the
        coarse service state, to keep this cheap on the 500ms tick.
        """
        try:
            path = sync_agent.status_path(self.cfg)
            mtime = os.path.getmtime(path) if os.path.isfile(path) else 0.0
        except Exception:
            mtime = 0.0
        if mtime != self._status_mtime:
            self._status_mtime = mtime
        # Always refresh the coarse state (cheap SCM query) so Start/Stop buttons
        # and the Connected dot track the service even with no new status file.
        self._refresh_service_status()

    def _drain_status(self) -> None:
        q = self.controller.status_q
        while True:
            try:
                payload = q.get_nowait()
            except queue.Empty:
                break
            event = payload.get("event")
            if event == "started":
                self._connected = True
                self._set_status(True)
                self._begin_working("Starting sync…")
            elif event == "progress":
                # Live per-record / per-company tick — drive the REAL % bar.
                self._connected = True
                self._set_status(True)
                self._set_progress(payload.get("done"), payload.get("total"),
                                   payload.get("phase"))
            elif event == "cycle":
                # A cycle with ok=True means the heartbeat reached the cloud, so
                # we are Connected; ok=False means it failed (server down / no
                # network), so reflect Disconnected rather than a false "Connected".
                ok = bool(payload.get("ok"))
                self._connected = ok
                self._set_status(ok)
                if ok:
                    self._finish_cycle_ok(payload.get("ts", time.time()))
            elif event == "stopped":
                self._connected = False
                self._set_status(False)
                self.btn_start.configure(state="normal")
                self.btn_stop.configure(state="disabled")
            elif event == "updating":
                self._activity("[update] Updating the agent; it will restart...")
            elif event == "error":
                self._connected = False
                self._set_status(False)
                self._activity("[x] Sync error: " + str(payload.get("message", "?")))
                self.btn_start.configure(state="normal")
                self.btn_stop.configure(state="disabled")

    def _drain_logs(self) -> None:
        q = self.controller.log_q
        appended = False
        count = 0
        while count < 200:  # cap per tick so a burst never freezes the UI.
            try:
                line = q.get_nowait()
            except queue.Empty:
                break
            self._activity(line, scroll=False)
            appended = True
            count += 1
        if appended:
            try:
                self.activity.see("end")
            except Exception:
                pass

    # -- helpers ----------------------------------------------------------- #
    def _set_status(self, connected: bool) -> None:
        """Set only the connection DOT (+ reset the bar when disconnected). The
        progress bar itself is driven by _begin_working / _set_progress /
        _finish_cycle_ok so it shows a REAL percentage, not a fake 0->100 sweep."""
        self._connected = bool(connected)
        if connected:
            # "Connected" MEANS BOTH ENDS. The cloud being reachable is half the
            # sentence; with Tally shut nothing can sync, and a green
            # "Connected" over a closed Tally is the single most misleading
            # thing this window could say. Until the probe has confirmed Tally
            # is up, the header says what it is doing — never "Connected".
            tally = getattr(self, "_tally_up", None)
            if tally is True:
                self.ui.set_connection("Connected", "Cloud and Tally are up",
                                       ui_dashboard.GREEN, "#eef7f1")
            elif tally is False:
                self.ui.set_connection("Tally is not running",
                                       "Cloud is connected — open TallyPrime",
                                       ui_dashboard.AMBER, "#fdf5e7")
            else:
                self.ui.set_connection("Checking Tally…", "Cloud is connected",
                                       ui_dashboard.MUTED, "#f1f4f9")
            self.ui.set_system("connection", "Connected", ui_dashboard.GREEN)
        else:
            self.ui.set_connection("Disconnected", "Not reaching the cloud",
                                   ui_dashboard.RED, "#fdeeee")
            self.ui.set_system("connection", "Offline", ui_dashboard.RED)
            try:
                self.progress.stop()
                self.progress.configure(mode="determinate", value=0)
            except Exception:
                pass
            try:
                self.lbl_sync_state.configure(text="Not connected", fg=BAD_RED)
                self.lbl_sync_title.configure(text="Not connected")
                self.lbl_sync_sub.configure(text="Waiting for the cloud.")
                self._steps({})
                self.rail.set("status", "Offline")
            except Exception:
                pass
            try:
                self.lbl_update.configure(text="")
            except Exception:
                pass

    def _refresh_system_box(self) -> None:
        """Keep the sidebar's System Status honest, once per poll tick.

        Every row is read from what is TRUE RIGHT NOW rather than remembered:
        a service that died shows as stopped, and Tally shows as closed the
        moment it closes. The header used to say "Connected" on the strength of
        the cloud alone, which read as "everything is working" while Tally was
        shut and nothing could sync at all.
        """
        running = False
        try:
            if self.service_mode and not self._fallback_active:
                running = (service_state() or "").lower().startswith("running")
            else:
                running = self.controller.is_running()
        except Exception:
            running = False
        self.ui.set_system("agent", "Running" if running else "Stopped",
                           ui_dashboard.GREEN if running else ui_dashboard.MUTED)

        if self.service_mode:
            svc = (service_state() or "unknown").capitalize()
            self.ui.set_system(
                "service", svc,
                ui_dashboard.GREEN if svc.lower().startswith("running")
                else ui_dashboard.MUTED)
        else:
            self.ui.set_system("service", "Not installed", ui_dashboard.MUTED)

        # Tally is probed on a slow beat of its own: it is an HTTP round-trip to
        # another process, and doing it at the 500ms poll rate would be a probe
        # storm for a fact that changes when somebody opens or closes an app.
        # First probe on the FIRST tick, then every ~10s. Waiting ten seconds
        # for the first answer is ten seconds of the window not knowing whether
        # Tally is there — which is exactly when somebody is looking at it.
        self._tally_ticks = getattr(self, "_tally_ticks", 0) + 1
        if self._tally_ticks == 1 or self._tally_ticks % 20 == 1:
            threading.Thread(target=self._probe_tally, name="tally-probe",
                             daemon=True).start()
        try:
            if running and self._last_sync_ts:
                due = self._last_sync_ts + float(self.cfg.sync_interval or 60)
                left = max(0, int(due - time.time()))
                self.ui.set_system(
                    "next", "in %dm" % (left // 60) if left >= 60
                    else "in %ds" % left, ui_dashboard.BODY)
            elif not running:
                self.ui.set_system("next", "paused", ui_dashboard.MUTED)
        except Exception:
            pass

    def _probe_tally(self) -> None:
        """Ask Tally's own gateway whether it is up. Off the Tk thread.

        The engine already does this inside a cycle, but a cycle can be a minute
        away and the customer is looking at the window NOW. Same probe the
        engine uses, so the two can never disagree about what "Tally is up"
        means.
        """
        up = False
        try:
            from tally_connector import TallyConnector          # noqa: PLC0415
            up = bool(TallyConnector(sync_agent._tally_url(self.cfg),
                                     self.logger).is_available())
        except Exception:
            up = False

        def apply() -> None:
            self._tally_up = up
            self.ui.set_system("tally", "Running" if up else "Not running",
                               ui_dashboard.GREEN if up else ui_dashboard.AMBER)
            # The header states the WHOLE truth, not just the cloud's half.
            if not self._connected:
                return
            self._set_status(True)      # one place decides what the header says
        try:
            self.app.root.after(0, apply)
        except Exception:
            pass

    # -- the five-step strip ------------------------------------------------ #
    def _steps(self, states: dict) -> None:
        """Push a {step: state} map at the stepper. Never raises."""
        try:
            self.stepper.apply(states)
        except Exception:
            pass

    def _step_upto(self, active: str) -> dict:
        """Everything before ``active`` is done, ``active`` runs, the rest pend.

        Derived rather than tracked, because the engine reports WHERE it is, not
        what it has finished - and a map rebuilt from the current position
        cannot drift out of step with it.
        """
        out, seen = {}, False
        for key, _ in ui_dashboard.STEPS:
            if key == active:
                out[key] = "active"
                seen = True
            elif not seen:
                out[key] = "done"
            else:
                out[key] = "pending"
        return out

    def _act(self, status: str, detail: str, tag: str = "") -> None:
        """One row in Sync Activity."""
        try:
            self.acts.add(time.strftime("%H:%M:%S"), status, _ascii(detail), tag)
        except Exception:
            pass

    # -- live progress bar (real %) --------------------------------------- #
    def _begin_working(self, text: str = "Syncing with Tally…") -> None:
        """Show the indeterminate 'working' animation until real progress lands."""
        self._cycle_started = time.time()
        try:
            self.progress.configure(mode="indeterminate")
            self.progress.start(18)
        except Exception:
            pass
        try:
            self.lbl_sync_state.configure(text=text, fg=BRAND)
            self.lbl_sync_title.configure(text="Sync in progress")
            self.lbl_sync_sub.configure(
                text="Please leave this window open while it runs.")
            self.lbl_step.configure(text="Current step:  Checking Tally and the "
                                         "cloud connection")
            self._reached = {"prepare", "check"}
            self._steps(self._step_upto("check"))
            self.rail.set("status", "In progress")
            self.rail.set("start", time.strftime("%d %b %Y %H:%M:%S"))
            self._act("Started", "Sync cycle started", "run")
            self._tick_elapsed()
        except Exception:
            pass
        try:
            self.lbl_update.configure(text="")
        except Exception:
            pass

    def _tick_elapsed(self) -> None:
        """Count up while a cycle runs, and stop by itself when it ends - so it
        never becomes a timer nobody remembered to cancel."""
        started = getattr(self, "_cycle_started", 0)
        if not started:
            return
        try:
            secs = int(time.time() - started)
            self.lbl_elapsed.configure(
                text="Elapsed  %02d:%02d:%02d" % (secs // 3600, secs // 60 % 60,
                                                  secs % 60))
            self.app.root.after(1000, self._tick_elapsed)
        except Exception:
            pass

    def _set_progress(self, done, total, phase) -> None:
        """Drive the DETERMINATE bar to the real percentage (done / total)."""
        try:
            total = int(total or 0)
            done = int(done or 0)
        except Exception:
            return
        if total <= 0:
            return
        pct = max(0, min(100, round(done * 100.0 / total)))
        try:
            self.progress.stop()
            self.progress.configure(mode="determinate", maximum=100, value=pct)
        except Exception:
            pass
        # The engine names its own direction, and that name IS the step.
        step = "upload" if "Tally ->" in str(phase or "") else "download"
        human = ("Uploading to the cloud" if step == "upload"
                 else "Downloading from the cloud")
        try:
            self.lbl_sync_state.configure(text="%s — %d%%" % (human, pct),
                                          fg=BRAND)
            self.lbl_sync_title.configure(text="Sync in progress")
            self.lbl_step.configure(text="Current step:  %s" % human)
            self._reached = getattr(self, "_reached", set()) | {step}
            self._steps(self._step_upto(step))
            self.rail.set("records", "%s of %s" % (format(done, ","),
                                                   format(total, ",")))
            if step != getattr(self, "_last_step", ""):
                self._act(human, "%s records" % format(total, ","), "run")
                self._last_step = step
        except Exception:
            pass
        try:
            self.lbl_update.configure(
                text="%s / %s records" % (format(done, ","), format(total, ",")),
                fg=SUB)
        except Exception:
            pass

    def _finish_cycle_ok(self, ts) -> None:
        """Cycle complete: fill the bar to 100% green + 'Up to date'."""
        self._last_sync_ts = ts
        try:
            self.progress.stop()
            self.progress.configure(mode="determinate", maximum=100, value=100)
        except Exception:
            pass
        try:
            self.lbl_sync_state.configure(text="Up to date", fg=OK_GREEN)
            self.lbl_sync_title.configure(text="Sync complete")
            self.lbl_sync_sub.configure(text="Everything is up to date.")
            self.lbl_step.configure(text="Current step:  Finished")
            # ONLY the steps that actually ran are marked done. A cycle that
            # never reached Tally sends no upload/download progress at all, and
            # ticking those green anyway told the customer their data had gone
            # to the cloud when nothing had moved.
            reached = getattr(self, "_reached", set()) | {"prepare", "check",
                                                          "finalize"}
            self._steps({k: ("done" if k in reached else "pending")
                         for k, _ in ui_dashboard.STEPS})
            self.rail.set("status", "Completed")
            self._act("Completed", "Sync finished successfully", "ok")
            self.history.add(self._fmt_ts(ts), "Completed",
                             "Cycle finished successfully", "ok")
            self.ui.set_system("last", time.strftime("%H:%M", time.localtime(ts)),
                               ui_dashboard.BODY)
            self._cycle_started = 0
            self._last_step = ""
        except Exception:
            pass
        try:
            self.lbl_update.configure(text="✓ Synced", fg=OK_GREEN)
        except Exception:
            pass
        try:
            self.lbl_last_sync.configure(text="Last sync: " + self._fmt_ts(ts))
        except Exception:
            pass

    def _show_idle_ok(self) -> None:
        """Nothing is running right now. Say only that.

        THE BAR REPORTS A CYCLE, NOT A MOOD. This used to park it at 100% on
        every idle tick, so a machine that had never synced once — Tally closed,
        syncer stopped, every step Pending — still showed a full bar reading
        100%. There was nothing for that number to be a percentage OF.

        Now the bar only holds 100% when a cycle actually finished, and the
        wording says which of the three situations this is: never synced yet,
        waiting for Tally, or up to date and waiting for the next run. Service
        mode polls this on every tick, so it must never touch last-sync.
        """
        synced = bool(self._last_sync_ts)
        try:
            self.progress.stop()
            self.progress.configure(mode="determinate", maximum=100,
                                    value=100 if synced else 0)
        except Exception:
            pass
        if synced:
            title, sub, state, tone = (
                "Up to date", "Waiting for the next scheduled sync.",
                "Up to date", OK_GREEN)
        elif getattr(self, "_tally_up", None) is False:
            title, sub, state, tone = (
                "Waiting for TallyPrime",
                "Open TallyPrime and load a company — the sync starts on its own.",
                "Waiting for Tally", WARN_AMBER)
        else:
            title, sub, state, tone = (
                "Waiting for the first sync",
                "Nothing has synced yet on this computer.",
                "Not synced yet", SUB)
        try:
            self.lbl_sync_state.configure(text=state, fg=tone)
            self.lbl_sync_title.configure(text=title)
            self.lbl_sync_sub.configure(text=sub)
            self.lbl_step.configure(
                text="Current step:  —" if not synced
                else "Current step:  Finished")
            # Idle is not "everything completed" — it is "nothing is running".
            # The last cycle's own result is what filled the strip; leave it
            # alone here rather than painting a full row of green ticks for a
            # cycle that has not happened yet.
            self.rail.set("status", "Idle" if synced else "Not synced yet")
        except Exception:
            pass

    @staticmethod
    def _fmt_ts(ts: Optional[float]) -> str:
        if not ts:
            return "never"
        try:
            return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))
        except Exception:
            return "?"

    # Markers the app puts on its OWN messages, mapped to how a row should read.
    _MARKERS = {"[..]": ("Working", "run"), "[OK]": ("Done", "ok"),
                "[x]": ("Failed", "err"), "[!]": ("Attention", "warn"),
                "[i]": ("Info", "")}

    def _activity(self, line: str, scroll: bool = True) -> None:
        """Write one line to the Logs console, and mirror the app's OWN messages
        into Sync Activity.

        Pressing Sync Now DID work before this; its only answer was a line on
        the Logs page, which is not the page the button is on. From the
        customer's seat a button that says nothing did nothing, so every message
        the app writes about an action now lands where the action was taken.
        Raw log lines from the engine are NOT mirrored — they start with a
        timestamp, they arrive by the hundred, and the console is where they
        belong.
        """
        text = _ascii(line)
        try:
            self.activity.configure(state="normal")
            self.activity.insert("end", text + "\n")
            if scroll:
                self.activity.see("end")
            self.activity.configure(state="disabled")
        except Exception:
            pass
        head = text.strip()[:4].strip()
        for mark, (status, tag) in self._MARKERS.items():
            if head.startswith(mark):
                detail = text.strip()[len(mark):].strip()
                if detail:
                    self._act(status, detail, tag)
                return


def _ascii(s: str) -> str:
    """Coerce a log line to ASCII so the Text widget never raises on odd bytes."""
    try:
        return str(s).encode("ascii", "replace").decode("ascii")
    except Exception:
        return "?"


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def _route_service_argv(argv: list[str]) -> Optional[int]:
    """Handle the service-related argv branches WITHOUT a GUI / instance lock.

    Returns a process exit code when this call OWNED the branch (the caller must
    return it immediately), or ``None`` when there is nothing service-related to
    do (fall through to the GUI). NEVER acquires the single-instance lock - only
    the GUI branch does, so the service / verb runs never collide with a running
    Dashboard.

    Branches:
      * ``--run-service``                 -> host the service (SCM invokes this).
      * install/remove/start/stop-service -> perform that SCM action + exit.
    """
    args = [a.strip().lower() for a in argv]

    # 1) The SCM-invoked hosting branch. This process BECOMES the service.
    if "--run-service" in args:
        svc = service_module()
        if svc is None:
            # No pywin32 -> cannot host. Exit non-zero so SCM marks it failed.
            return 1
        return svc.run_service_dispatch()

    # 2) Programmatic SCM management verbs (run elevated by the GUI). ``argv`` is
    #    already ``sys.argv[1:]``, so the verb is simply the first verb-looking
    #    token present (scanned rather than fixed-index, so it also works when a
    #    script path precedes it in the source-run case).
    verb = next((a for a in args if a in SERVICE_VERBS), "")
    if verb in SERVICE_VERBS:
        svc = service_module()
        if svc is None:
            print("pywin32 not available; service control is unavailable.")
            return 1
        if verb == "install-service":
            # OPTIONAL trailing token = the absolute STABLE installed-exe path the
            # service must be registered to (<install_dir>\TallyCloudSync.exe).
            # We use the ORIGINAL argv (not the lower-cased copy) so the path
            # keeps its real casing. The token right AFTER 'install-service' is
            # the exe path; absent -> install_service() falls back to the running
            # frozen exe (a manual elevated install from the install dir).
            exe_arg = None
            for i, a in enumerate(args):
                if a == "install-service" and i + 1 < len(argv):
                    candidate = argv[i + 1].strip().strip('"')
                    if candidate and candidate.lower() not in SERVICE_VERBS:
                        exe_arg = candidate
                    break
            return svc.install_service(exe_arg)
        if verb == "remove-service":
            return svc.remove_service()
        if verb == "start-service":
            return svc.start_service()
        if verb == "stop-service":
            return svc.stop_service()

    return None


def _run_web_ui() -> "int | None":
    """Open the SERVED window: a shell around the cloud-hosted agent UI.

    Returns an exit code when the window ran, or None when it could not start —
    the caller then falls back to the tkinter build, because "no window at all"
    is the one outcome worth avoiding.

    The sync loop runs in a background thread exactly as it does under tkinter.
    The window is a viewer onto it, not its owner: closing the window leaves the
    service syncing, which is what a background agent is for.
    """
    try:
        from shell import AgentShell
        import bridge_handlers
        import logger as logger_mod
    except Exception as exc:               # noqa: BLE001
        print(f"Served UI unavailable ({exc}); using the built-in window.")
        return None

    cfg = load_config_safe()
    log = get_logger("gui-agent", cfg.log_level)

    # SyncState is what the window renders. The sync loop already reports its
    # progress through SyncController.status_q, so a small pump copies those
    # events into the state rather than the engine learning about the UI.
    state = bridge_handlers.SyncState()
    controller = SyncController()

    def pump() -> None:
        """Drain status events into SyncState until the process ends.

        Runs on its own thread because SyncController's queue is the only place
        progress appears, and nothing else is draining it in this UI — an
        undrained queue would grow for as long as the agent runs.
        """
        while True:
            try:
                event = controller.status_q.get(timeout=1.0)
            except Exception:
                continue
            try:
                _apply_status(state, event)
            except Exception:               # noqa: BLE001 - a bad event must
                pass                        # never kill the pump

    threading.Thread(target=pump, name="status-pump", daemon=True).start()

    def sync_now() -> None:
        """Force a cycle by restarting the loop.

        The engine has no "run now" signal, and inventing one would mean
        touching the shared loop for a UI affordance. A restart reaches the
        first cycle immediately, which is what the button promises.
        """
        controller.stop(timeout=3.0)
        controller.start(load_config_safe(), log)

    handlers = bridge_handlers.build(
        cfg_loader=load_config_safe,
        state=state,
        logger=log,
        log_path=getattr(logger_mod, "_LOG_FILE", None),
        on_sync_now=sync_now,
        on_sign_out=lambda: controller.stop(timeout=3.0),
    )

    shell = AgentShell(AGENT_UI_URL, handlers, logger=log, title=APP_TITLE)
    try:
        # Only start syncing if this machine is already signed in. A fresh
        # install opens on the sign-in screen with no loop running.
        if cfg.get_token():
            controller.start(cfg, log)
        host = shell.run("auto")
        log.info("Served UI closed (host=%s).", host)
        return 0
    except Exception as exc:               # noqa: BLE001
        log.warning("Served UI failed to start: %s", exc)
        return None
    finally:
        shell.stop()
        controller.stop(timeout=3.0)


def _apply_status(state, event: dict) -> None:
    """Translate one engine status event into the window's progress model.

    The engine speaks in its own events; the window speaks in modules and a
    percentage. Keeping the translation here means neither side has to know the
    other's vocabulary, and an unrecognised event is ignored rather than
    rendered as a wrong number.
    """
    kind = str(event.get("event") or "")
    if kind in ("cycle_start", "pull_start"):
        state.begin(str(event.get("company") or ""))
        return
    if kind == "error":
        state.finish(_now_hm(), ok=False)
        return
    if kind in ("cycle_end", "idle"):
        state.finish(_now_hm(), ok=True)
        return

    # Progress events name a module and, usually, how many records it moved.
    key = str(event.get("module") or event.get("step") or "")
    if not key:
        return
    count = event.get("count")
    state.step(key,
               count=int(count) if isinstance(count, (int, float)) else None,
               state=str(event.get("state") or "synced"),
               percent=event.get("percent"))


def _now_hm() -> str:
    import datetime
    return datetime.datetime.now().strftime("%H:%M")


def main() -> int:
    """Launch the GUI (or route a service branch). Returns a process exit code."""
    # CLOSE THE BOOTLOADER SPLASH BEFORE ANYTHING ELSE, and unconditionally.
    #
    # Two separate bugs live here, and both were fixed by moving this one line to
    # the top of the function:
    #
    # 1) DEADLOCK. PyInstaller's splash is not a picture the C loader blits and
    #    forgets — it is a full Tcl/Tk interpreter running on a SECOND THREAD of
    #    this same process. Creating our own Tk root while that thread is alive
    #    deadlocks on Tcl's global lock: the window still gets painted once, and
    #    then the event loop never runs again. The title bar reads
    #    "(Not Responding)" and not one keystroke reaches the email field. It
    #    reproduces ONLY in the frozen build, which is why running from source
    #    always looked healthy.
    #
    # 2) ORPHANED SPLASH. Several branches below return without opening a
    #    window at all (already running, a service verb). Each one used to leave
    #    the splash on screen forever — a picture that never becomes an app.
    #
    # The visible cost is a few hundred milliseconds between this splash going
    # and ui_splash's taking over. That is the right trade against a window that
    # never accepts input.
    _close_splash()

    # Route service branches FIRST, before any GUI / single-instance lock. The
    # SCM hosting branch (--run-service) and the elevated management verbs must
    # never create a window or take the GUI lock.
    rc = _route_service_argv(list(sys.argv[1:]))
    if rc is not None:
        return rc

    # The SERVED window. The interface lives in the web tier, so it changes on
    # deploy instead of in a new exe — which is the whole reason this path
    # exists. The tkinter build below stays as the fallback: WebView2 is an Edge
    # component and is genuinely missing on some of the older back-office PCs
    # this agent gets installed on, and an app that will not open at all is a
    # much worse failure than one that looks dated.
    if "--ui=web" in sys.argv[1:] or "--web" in sys.argv[1:]:
        rc = _run_web_ui()
        if rc is not None:
            return rc
        # _run_web_ui returning None means it could not start; fall through to
        # tkinter rather than leaving the customer with no window at all.

    instance = SingleInstance()
    if not instance.acquire():
        # Another instance owns the lock. Tell it to focus (best-effort) and
        # exit quietly so we never double-sync.
        try:
            import socket
            with socket.create_connection(("127.0.0.1", SingleInstance._PORT),
                                          timeout=2) as s:
                s.sendall(b"focus")
        except Exception:
            pass
        # Our own dialog, which needs a root — so one is made, hidden, used and
        # destroyed. It is a few milliseconds, and it is the difference between
        # "the app told me" and "Windows told me".
        try:
            hidden = tk.Tk()
            hidden.withdraw()
            ui_theme.apply(hidden)
            ui_signin.apply_icon(hidden)
            ui_signin.alert(hidden,
                            "It is already open — look for it on the taskbar or "
                            "beside the clock.",
                            kind="info", title=f"{APP_TITLE} is already running")
            hidden.destroy()
        except Exception:
            pass
        return 0

    try:
        root = tk.Tk()
    except Exception as exc:
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                0, "Could not start the window: " + str(exc), APP_TITLE, 0x10)
        except Exception:
            pass
        instance.release()
        return 1

    # Hide the (empty) main window until its first view is built; the animated
    # splash stands in for it meanwhile. The bootloader's splash is already gone
    # by now — see the top of this function for why it has to be.
    try:
        root.withdraw()
    except Exception:
        pass

    # THE SPLASH IS FOR THE FIRST RUN ONLY.
    #
    # It exists to hold the screen while a brand-new install works out what to
    # show — sign in, or update an older copy — which is the one launch where
    # there is a real wait and nothing else to look at. Every launch after that
    # opens straight into the Dashboard, which reports its own state in its own
    # window; putting a full-screen splash in front of it just delays a window
    # that was ready anyway, and makes a daily action feel like an installation.
    #
    # Anything the customer STARTS from inside the app — sign in, verify, sync,
    # update — reports on the button they pressed. That is where they are
    # looking, and it does not cover the screen they are working in.
    try:
        first_run = not is_activated(load_config_safe())
    except Exception:                                       # noqa: BLE001
        first_run = True          # unreadable config -> treat as a fresh start
    splash = ui_splash.show(root) if first_run else None
    if splash is not None:
        splash.pump()

    app = AgentApp(root, instance, splash=splash)

    # A background acceptor so a second-launch "focus" message restores us.
    _start_focus_listener(instance, app)

    # The first view is chosen and built from INSIDE the event loop, not before
    # it: the choice needs a filesystem scan, and the splash can only animate
    # while that loop is running. AgentApp.boot closes the splash and reveals
    # the window when it is done — including if it fails, so a crash there
    # cannot leave the customer with a splash and nothing behind it.
    def _boot_now() -> None:
        try:
            app.boot()
        except Exception as exc:                            # noqa: BLE001
            app.logger.error("Startup failed: %s", exc)
            if app.splash is not None:
                app.splash.close()
                app.splash = None
            try:
                root.deiconify()
            except Exception:
                pass
            ui_signin.alert(root, str(exc), title="Could not start")

    root.after(60, _boot_now)

    try:
        root.mainloop()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            instance.release()
        except Exception:
            pass
    return 0


def _start_focus_listener(instance: SingleInstance, app: AgentApp) -> None:
    """Accept connections on the single-instance socket; restore on 'focus'.

    A second launch connects to the port and sends 'focus'; this daemon thread
    accepts it and asks the Tk thread (via after) to re-show the window. Wrapped
    so a missing/failed socket never affects the GUI.
    """
    sock = instance._sock
    if sock is None:
        return

    def serve():
        while True:
            try:
                conn, _ = sock.accept()
            except OSError:
                break
            except Exception:
                break
            try:
                conn.settimeout(1.0)
                _ = conn.recv(16)
            except Exception:
                pass
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
            try:
                app.root.after(0, app.restore_window)
            except Exception:
                pass

    threading.Thread(target=serve, name="focus-listener", daemon=True).start()


if __name__ == "__main__":
    sys.exit(main())
