"""Professional tkinter GUI for the Tally Cloud Sync Agent (the windowed exe).

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
            "Tally Cloud Sync", 0x10)
    except Exception:
        pass
    raise

# Engine + helpers - REUSED, never re-implemented.
from config import Config, machine_fingerprint
from logger import get_logger
import sync_agent


APP_TITLE = "Tally Cloud Sync"
INSTALLED_EXE_NAME = "TallyCloudSync.exe"
STARTUP_VBS_NAME = "TallyCloudSync.vbs"
SHORTCUT_NAME = "Tally Cloud Sync.lnk"
DEFAULT_INSTALL_DIR = r"C:\TallyCloudSync"
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
            'lnk.Description = "Tally Cloud Sync"\r\n'
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
    exe = exe_path()
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

    def __init__(self, root: tk.Tk, instance: SingleInstance) -> None:
        self.root = root
        self.instance = instance
        self.logger = get_logger("gui-agent")
        self.controller = SyncController()
        self.tray = None  # set when a tray icon is created
        self._tray_log_tap_installed = False

        root.title(APP_TITLE)
        root.geometry("720x560")
        root.minsize(640, 480)
        try:
            root.protocol("WM_DELETE_WINDOW", self.on_close)
        except Exception:
            pass

        # Pick the initial view.
        cfg = load_config_safe()
        if running_frozen() and is_activated(cfg):
            self.show_dashboard(cfg)
        elif (not running_frozen()) and is_activated(cfg):
            # From source with an activated config -> still useful to show the
            # dashboard for manual testing.
            self.show_dashboard(cfg)
        else:
            self.show_setup(cfg)

    # -- view switching ---------------------------------------------------- #
    def _clear(self) -> None:
        for child in self.root.winfo_children():
            child.destroy()

    def show_setup(self, cfg: Config) -> None:
        """Render the first-run Setup wizard."""
        self._clear()
        SetupView(self.root, self, cfg)

    def show_dashboard(self, cfg: Config) -> None:
        """Render the installed/activated Dashboard."""
        self._clear()
        DashboardView(self.root, self, cfg)

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
        """Re-show + focus the main window (from tray or a second launch)."""
        try:
            self.root.deiconify()
            self.root.lift()
            self.root.focus_force()
        except Exception:
            pass

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
    """First-run wizard: collect settings, verify the key, self-install."""

    def __init__(self, parent: tk.Tk, app: AgentApp, cfg: Config) -> None:
        self.app = app
        self.cfg = cfg
        self.logger = app.logger
        self._installing = False
        self._installed_exe: Optional[str] = None

        frame = ttk.Frame(parent, padding=16)
        frame.pack(fill="both", expand=True)

        ttk.Label(frame, text="Tally Cloud Sync - Setup",
                  font=("Segoe UI", 15, "bold")).pack(anchor="w")
        ttk.Label(frame,
                  text="Enter your license key and choose where to install. "
                       "The agent installs itself and starts in the background.",
                  wraplength=660, foreground="#444").pack(anchor="w", pady=(2, 12))

        form = ttk.Frame(frame)
        form.pack(fill="x")
        form.columnconfigure(1, weight=1)

        # Sensible defaults from any existing config. NOTE: the server URL is
        # BAKED into the exe (config.API_BASE_URL) and is NOT asked here.
        # The license key is NEVER pre-filled from the stored config (it must
        # not be displayed in the GUI); the operator types/pastes it once, into
        # a MASKED field, on first-run install.
        self.var_key = tk.StringVar(value="")
        self.var_dir = tk.StringVar(value=DEFAULT_INSTALL_DIR)
        self.var_tally = tk.StringVar(value=self._detect_tally(cfg))
        self.var_interval = tk.StringVar(value=str(cfg.sync_interval or 60))
        self.var_autoupdate = tk.BooleanVar(value=bool(cfg.auto_update))
        self.var_autostart = tk.BooleanVar(value=True)
        self.var_desktop = tk.BooleanVar(value=True)

        r = 0
        self._row_secret(form, r, "License key:", self.var_key); r += 1
        self._row_browse(form, r, "Install folder:", self.var_dir,
                         self._browse_dir); r += 1
        self._row_browse(form, r, "Tally exe:", self.var_tally,
                         self._browse_tally); r += 1
        self._row(form, r, "Sync interval (s):", self.var_interval); r += 1

        checks = ttk.Frame(frame)
        checks.pack(fill="x", pady=(10, 6))
        ttk.Checkbutton(checks, text="Auto-update the agent",
                        variable=self.var_autoupdate).pack(anchor="w")
        ttk.Checkbutton(checks, text="Start automatically at logon",
                        variable=self.var_autostart).pack(anchor="w")
        ttk.Checkbutton(checks, text="Create a Desktop shortcut",
                        variable=self.var_desktop).pack(anchor="w")

        btns = ttk.Frame(frame)
        btns.pack(fill="x", pady=(6, 6))
        self.install_btn = ttk.Button(btns, text="Install",
                                      command=self.on_install)
        self.install_btn.pack(side="left")
        self.open_btn = ttk.Button(btns, text="Open Dashboard",
                                   command=self.on_open_dashboard, state="disabled")
        self.open_btn.pack(side="left", padx=(8, 0))
        ttk.Button(btns, text="Quit", command=app.quit_app).pack(side="right")

        ttk.Label(frame, text="Progress:").pack(anchor="w", pady=(6, 0))
        self.log = tk.Text(frame, height=10, wrap="word", state="disabled",
                           background="#101418", foreground="#d6e2ea",
                           insertbackground="#d6e2ea", relief="flat")
        self.log.pack(fill="both", expand=True, pady=(2, 0))

        if not running_frozen():
            self._append("Note: running from source (not frozen). The install "
                         "step will COPY this script's exe only when frozen; "
                         "from source it writes config + auto-start so you can "
                         "test the Dashboard.")

    # -- small form builders ---------------------------------------------- #
    def _row(self, form, r, label, var) -> None:
        ttk.Label(form, text=label).grid(row=r, column=0, sticky="w",
                                         padx=(0, 8), pady=4)
        ttk.Entry(form, textvariable=var).grid(row=r, column=1, sticky="ew", pady=4)

    def _row_secret(self, form, r, label, var) -> None:
        """A masked (password-style) entry with a Show/Hide eye toggle.

        Defaults to HIDDEN (show="*"), so the key the operator types/pastes is
        not left visible on screen; the toggle flips show between "*" (hidden)
        and "" (shown) so they can verify what they typed, then re-hide it.
        """
        ttk.Label(form, text=label).grid(row=r, column=0, sticky="w",
                                         padx=(0, 8), pady=4)
        entry = ttk.Entry(form, textvariable=var, show="*")
        entry.grid(row=r, column=1, sticky="ew", pady=4)

        def _toggle():
            if entry.cget("show") == "":
                entry.configure(show="*")
                toggle_btn.configure(text="Show")
            else:
                entry.configure(show="")
                toggle_btn.configure(text="Hide")

        toggle_btn = ttk.Button(form, text="Show", width=6, command=_toggle)
        toggle_btn.grid(row=r, column=2, padx=(8, 0), pady=4)

    def _row_browse(self, form, r, label, var, cmd) -> None:
        ttk.Label(form, text=label).grid(row=r, column=0, sticky="w",
                                         padx=(0, 8), pady=4)
        ttk.Entry(form, textvariable=var).grid(row=r, column=1, sticky="ew", pady=4)
        ttk.Button(form, text="Browse", command=cmd).grid(row=r, column=2,
                                                          padx=(8, 0), pady=4)

    def _detect_tally(self, cfg: Config) -> str:
        """Auto-detect tally.exe using the engine's finder (editable later)."""
        try:
            found = sync_agent._find_tally_exe(cfg)
            return found or (cfg.tally_exe or "")
        except Exception:
            return cfg.tally_exe or ""

    def _browse_dir(self) -> None:
        chosen = filedialog.askdirectory(title="Choose the install folder")
        if chosen:
            # Install INTO a TallyCloudSync subfolder when they pick a parent.
            self.var_dir.set(os.path.join(chosen, "TallyCloudSync")
                             if os.path.basename(chosen).lower() != "tallycloudsync"
                             else chosen)

    def _browse_tally(self) -> None:
        chosen = filedialog.askopenfilename(
            title="Locate tally.exe",
            filetypes=[("Tally executable", "tally.exe"), ("All files", "*.*")])
        if chosen:
            self.var_tally.set(chosen)

    def _append(self, line: str) -> None:
        """Append a line to the progress log (must run on the Tk thread)."""
        try:
            self.log.configure(state="normal")
            self.log.insert("end", line + "\n")
            self.log.see("end")
            self.log.configure(state="disabled")
        except Exception:
            pass

    # -- install flow ------------------------------------------------------ #
    def on_install(self) -> None:
        """Validate -> verify key -> install. Runs the network call off-thread."""
        if self._installing:
            return
        key = self.var_key.get().strip()
        install_dir = self.var_dir.get().strip()
        if not key:
            messagebox.showerror(APP_TITLE, "Please enter your license key.")
            return
        if not install_dir:
            messagebox.showerror(APP_TITLE, "Please choose an install folder.")
            return
        try:
            interval = int(self.var_interval.get().strip() or "60")
            if interval <= 0:
                interval = 60
        except ValueError:
            interval = 60

        self._installing = True
        self.install_btn.configure(state="disabled")
        self._append("[..] Verifying license key with the cloud...")

        # Verify the key off the Tk thread (network); report back via after().
        threading.Thread(
            target=self._verify_then_install,
            args=(key, install_dir, self.var_tally.get().strip(),
                  interval, bool(self.var_autoupdate.get()),
                  bool(self.var_autostart.get()), bool(self.var_desktop.get())),
            name="setup-install", daemon=True,
        ).start()

    def _verify_then_install(self, key, install_dir, tally_exe, interval,
                             auto_update, auto_start, desktop) -> None:
        """Worker thread: activate against the cloud, then do the file install.

        All UI updates are marshalled back with ``root.after`` so this thread
        never touches a widget directly.
        """
        machine_id = ""
        token = ""
        err = None
        try:
            cfg = Config.load(config_path())
        except Exception:
            cfg = Config(config_path())
        # The server URL is baked into cfg.api_url (constants.API_BASE_URL).
        machine_id = cfg.machine_id or machine_fingerprint()
        try:
            api = sync_agent.build_api(cfg, self.logger)
            data = api.activate(key, machine_id, cfg.agent_version)
            token = (data or {}).get("agent_token") or ""
            if not token:
                err = "Activation succeeded but returned no agent token."
        except Exception as exc:
            err = str(exc)

        def done():
            if err or not token:
                self._append("[x] " + (err or "Activation failed."))
                messagebox.showerror(
                    APP_TITLE,
                    "Could not activate this license key:\n\n" + (err or "Unknown error")
                    + "\n\nCheck the key and your internet connection, then try again.")
                self._installing = False
                self.install_btn.configure(state="normal")
                return
            self._append("[OK] License verified.")
            self._do_install(key, install_dir, tally_exe, interval,
                             auto_update, auto_start, desktop, machine_id, token)
        self.app.root.after(0, done)

    def _do_install(self, key, install_dir, tally_exe, interval,
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
                    shutil.copy2(src, installed_exe)
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
            #    .API_BASE_URL) so it is NOT written here; license_key + token are
            #    stored ENCRYPTED by Config.
            self._append("[..] Writing configuration...")
            inst_cfg = Config(os.path.join(install_dir, "config.ini"))
            inst_cfg.license_key = key
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

            self._append("")
            self._append("[OK] Installation complete!")
            self._append("     Installed to: " + install_dir)
            self._installed_exe = installed_exe
            self.open_btn.configure(state="normal")
            self.install_btn.configure(state="normal")
            self._installing = False
            messagebox.showinfo(
                APP_TITLE,
                "Tally Cloud Sync is installed.\n\nClick 'Open Dashboard' to "
                "launch it. It will also start automatically at logon"
                + (" in the background." if auto_start else "."))
        except Exception as exc:
            self.logger.error("Install failed: %s", exc)
            self._append("[x] Install failed: " + str(exc))
            messagebox.showerror(APP_TITLE, "Install failed:\n\n" + str(exc))
            self._installing = False
            self.install_btn.configure(state="normal")

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
            if relaunch_installed(exe):
                self.app.quit_app()
                return
            messagebox.showerror(APP_TITLE,
                                 "Could not launch the installed application.")
            return
        # Source run (or no copied exe): switch this window to the Dashboard,
        # reading the just-written install-folder config.
        try:
            inst_dir = os.path.dirname(exe) if exe else self.var_dir.get().strip()
            cfg = Config.load(os.path.join(inst_dir, "config.ini"))
        except Exception:
            cfg = load_config_safe()
        self.app.show_dashboard(cfg)


# --------------------------------------------------------------------------- #
# Dashboard view
# --------------------------------------------------------------------------- #
class DashboardView:
    """Installed/activated dashboard: live status, settings, controls."""

    POLL_MS = 500

    def __init__(self, parent: tk.Tk, app: AgentApp, cfg: Config) -> None:
        self.app = app
        self.cfg = cfg
        self.logger = app.logger
        self.controller = app.controller
        self._last_sync_ts: Optional[float] = None
        self._connected = False
        self._update_available = ""

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

        root = parent
        outer = ttk.Frame(root, padding=14)
        outer.pack(fill="both", expand=True)

        # Header / status strip.
        header = ttk.Frame(outer)
        header.pack(fill="x")
        ttk.Label(header, text="Tally Cloud Sync",
                  font=("Segoe UI", 14, "bold")).pack(side="left")
        self.status_dot = ttk.Label(header, text="  Disconnected",
                                    foreground="#b00020", font=("Segoe UI", 10, "bold"))
        self.status_dot.pack(side="right")

        info = ttk.Frame(outer)
        info.pack(fill="x", pady=(6, 8))
        self.lbl_last_sync = ttk.Label(info, text="Last sync: never")
        self.lbl_last_sync.grid(row=0, column=0, sticky="w", padx=(0, 24))
        self.lbl_version = ttk.Label(
            info, text="Version: " + (cfg.agent_version or "?"))
        self.lbl_version.grid(row=0, column=1, sticky="w", padx=(0, 24))
        self.lbl_update = ttk.Label(info, text="", foreground="#0a7d28")
        self.lbl_update.grid(row=0, column=2, sticky="w")

        # Controls.
        ctrl = ttk.Frame(outer)
        ctrl.pack(fill="x", pady=(0, 8))
        self.btn_start = ttk.Button(ctrl, text="Start", command=self.on_start)
        self.btn_start.pack(side="left")
        self.btn_stop = ttk.Button(ctrl, text="Stop", command=self.on_stop,
                                   state="disabled")
        self.btn_stop.pack(side="left", padx=(6, 0))
        ttk.Button(ctrl, text="Sync Now", command=self.on_sync_now).pack(
            side="left", padx=(6, 0))
        ttk.Button(ctrl, text="Open Logs", command=self.on_open_logs).pack(
            side="left", padx=(6, 0))
        ttk.Button(ctrl, text="Uninstall", command=self.on_uninstall).pack(
            side="right")

        # A notebook: Activity tail + Settings.
        nb = ttk.Notebook(outer)
        nb.pack(fill="both", expand=True, pady=(4, 0))

        # Activity tab.
        act = ttk.Frame(nb, padding=6)
        nb.add(act, text="Activity")
        self.activity = tk.Text(act, height=12, wrap="word", state="disabled",
                                background="#101418", foreground="#d6e2ea",
                                insertbackground="#d6e2ea", relief="flat")
        self.activity.pack(fill="both", expand=True)

        # Settings tab.
        st = ttk.Frame(nb, padding=10)
        nb.add(st, text="Settings")
        self._build_settings(st)

        # Live update pump.
        self._poll()

        if self.service_mode:
            # Service mode: do NOT spin up an in-process syncer (the service is
            # the one syncer). Just reflect the service's state + last status.
            self._activity("[i] Background service mode: the Windows service "
                           "'Tally Cloud Sync' performs the sync. This window "
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
            ttk.Entry(st, textvariable=var).grid(row=r, column=1, sticky="ew", pady=4)
            if browse:
                ttk.Button(st, text="Browse", command=browse).grid(
                    row=r, column=2, padx=(8, 0), pady=4)

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
        ttk.Button(st, text="Re-activate with new key...",
                   command=self.on_reactivate_prompt).grid(
            row=0, column=2, padx=(8, 0), pady=4)

        row(1, "Tally exe:", self.s_tally, self._browse_tally)
        row(2, "Sync interval (s):", self.s_interval)
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
    def on_start(self) -> None:
        """Start syncing. Service mode -> start the service (elevated); portable
        mode -> start the in-process daemon thread."""
        if self.service_mode:
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
        mode -> signal the in-process loop to stop."""
        if self.service_mode:
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
                # Genuinely stopped - bring the service up (first cycle is immediate).
                self.on_start()
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
        self._set_status(connected)
        self._connected = connected
        # Start/Stop reflect the EFFECTIVE running state, not the raw SCM query.
        # The SCM query fails for a NON-ADMIN GUI and would falsely read
        # not-running, wrongly enabling Start on a happily-syncing service. A
        # fresh .status.json (running, with a recent ts - even if ok briefly
        # false) is the reliable "the service is alive" signal, so OR it in.
        running_eff = running or status_fresh or status_alive
        if running_eff:
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
            messagebox.showerror(APP_TITLE, "Could not open the logs folder:\n" + str(exc))

    def on_save(self) -> None:
        """Persist the NON-SECRET settings only.

        Save NEVER touches the license key: the key is not shown on the
        Dashboard and a normal Save must not need or display it. Changing the
        key is an explicit action (the "Re-activate with new key..." button),
        which prompts for a fresh key in a blank, masked entry. Here we load the
        stored config (preserving its already-stored, encrypted key untouched)
        and write back only the interval, tally path and toggles.
        """
        try:
            interval = int(self.s_interval.get().strip() or "60")
            if interval <= 0:
                interval = 60
        except ValueError:
            interval = 60

        # Load the stored config so the existing (encrypted) license_key is
        # carried through unchanged; we only overwrite non-secret settings.
        cfg = load_config_safe()
        cfg.tally_exe = self.s_tally.get().strip()
        cfg.sync_interval = interval
        cfg.auto_update = bool(self.s_autoupdate.get())

        try:
            cfg.save()
        except Exception as exc:
            messagebox.showerror(APP_TITLE, "Could not save settings:\n" + str(exc))
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
        """Open a small modal with a BLANK, MASKED entry to re-activate.

        The prompt is NEVER pre-filled with the stored key (the key is never
        read back into a widget). On submit it activates with the entered key
        and saves it ENCRYPTED, without ever echoing the old/stored key.
        """
        top = tk.Toplevel(self.app.root)
        top.title("Re-activate with new key")
        top.transient(self.app.root)
        top.resizable(False, False)
        frm = ttk.Frame(top, padding=14)
        frm.pack(fill="both", expand=True)

        ttk.Label(frm,
                  text="Enter a new license key to re-activate this agent.",
                  wraplength=360, foreground="#444").grid(
            row=0, column=0, columnspan=3, sticky="w", pady=(0, 10))

        ttk.Label(frm, text="License key:").grid(
            row=1, column=0, sticky="w", padx=(0, 8), pady=4)
        var_newkey = tk.StringVar(value="")  # ALWAYS blank, never pre-filled.
        entry = ttk.Entry(frm, textvariable=var_newkey, show="*", width=34)
        entry.grid(row=1, column=1, sticky="ew", pady=4)
        frm.columnconfigure(1, weight=1)

        def _toggle():
            if entry.cget("show") == "":
                entry.configure(show="*")
                eye.configure(text="Show")
            else:
                entry.configure(show="")
                eye.configure(text="Hide")

        eye = ttk.Button(frm, text="Show", width=6, command=_toggle)
        eye.grid(row=1, column=2, padx=(8, 0), pady=4)

        msg = ttk.Label(frm, text="", foreground="#b00020", wraplength=360)
        msg.grid(row=2, column=0, columnspan=3, sticky="w", pady=(6, 0))

        btns = ttk.Frame(frm)
        btns.grid(row=3, column=0, columnspan=3, sticky="e", pady=(10, 0))

        def submit():
            new_key = var_newkey.get().strip()
            if not new_key:
                msg.configure(text="Please enter a license key.")
                return
            # Load the stored config and apply ONLY the new key in memory; the
            # worker activates + persists it (encrypted) via set_token/save.
            cfg = load_config_safe()
            cfg.license_key = new_key
            try:
                cfg.save()
            except Exception as exc:
                msg.configure(text="Could not save: " + str(exc))
                return
            self.s_msg.configure(text="Re-activating...", foreground="#444")
            self._reactivate(cfg, new_key)
            try:
                top.destroy()
            except Exception:
                pass

        ttk.Button(btns, text="Re-activate", command=submit).pack(side="left")
        ttk.Button(btns, text="Cancel",
                   command=top.destroy).pack(side="left", padx=(8, 0))

        try:
            entry.focus_set()
            top.grab_set()
        except Exception:
            pass

    def _reactivate(self, cfg: Config, key: str) -> None:
        """Re-activate with a changed key/URL on a worker thread."""
        def worker():
            err = None
            token = ""
            try:
                api = sync_agent.build_api(cfg, self.logger)
                data = api.activate(key, cfg.machine_id, cfg.agent_version)
                token = (data or {}).get("agent_token") or ""
                if not token:
                    err = "No token returned."
            except Exception as exc:
                err = str(exc)

            def done():
                if err or not token:
                    self.s_msg.configure(
                        text="Re-activation failed: " + (err or "?"),
                        foreground="#b00020")
                    self._activity("[x] Re-activation failed: " + (err or "?"))
                    return
                try:
                    cfg.set_token(token)
                except Exception as exc:
                    self.s_msg.configure(text="Saved key but token write failed.",
                                         foreground="#b00020")
                    self._activity("[x] Token write failed: " + str(exc))
                    return
                self.cfg = cfg
                self.s_msg.configure(text="Re-activated + saved.",
                                     foreground="#0a7d28")
                try:
                    self.lbl_license.configure(text="Activated",
                                               foreground="#0a7d28")
                except Exception:
                    pass
                self._activity("[OK] Re-activated with the new license key.")
                # Apply the new token: service mode restarts the service so it
                # reloads config (one UAC prompt); portable mode bounces the
                # in-process loop.
                if self.service_mode:
                    if service_state() == "running":
                        self._service_action(
                            "stop-service", "Restarting the service to apply...")
                        self.app.root.after(
                            1500, lambda: self._service_action(
                                "start-service", "Starting the service..."))
                elif self.controller.is_running():
                    self.on_stop()
                    self.app.root.after(800, self.on_start)
            self.app.root.after(0, done)
        threading.Thread(target=worker, name="reactivate", daemon=True).start()

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
        install_dir = app_dir()
        can_purge = _is_real_install_dir(install_dir)
        if can_purge:
            prompt = ("Uninstall Tally Cloud Sync?\n\nThis stops syncing, removes "
                      "the background service / auto-start launcher and shortcuts, "
                      "and deletes the agent's files from:\n\n  " + install_dir +
                      "\n\nThe logs\\ folder is KEPT for your reference. This "
                      "window will close to finish. This cannot be undone.")
        else:
            prompt = ("Uninstall Tally Cloud Sync?\n\nThis stops syncing and "
                      "removes the background service / auto-start launcher and "
                      "shortcuts. The install folder will be LEFT in place (it "
                      "does not look like a real install folder, so it is not "
                      "auto-deleted); you can remove it manually.")
        if not messagebox.askyesno(APP_TITLE, prompt):
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
            messagebox.showinfo(
                APP_TITLE,
                "The background service could not be removed (admin was declined). "
                "Re-run Uninstall and accept the prompt. The auto-start launcher "
                "and shortcuts were removed; the install folder was kept.")
            self.btn_start.configure(state="normal")
            self.btn_stop.configure(state="disabled")
            return

        if not can_purge:
            self._activity("[OK] Uninstalled (service / auto-start + shortcuts "
                           "removed). Install folder left in place.")
            messagebox.showinfo(
                APP_TITLE,
                "The background service / auto-start launcher and shortcuts were "
                "removed; syncing stopped. The install folder was left in place; "
                "you can delete it manually.")
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
        if launched:
            self._activity("[OK] Uninstalled. Closing now so the agent files can "
                           "be removed (logs\\ is kept).")
            messagebox.showinfo(
                APP_TITLE,
                "Tally Cloud Sync has been uninstalled. This window will now close; "
                "the agent files are removed in the background and the logs\\ "
                "folder is kept for your reference.")
            try:
                self.app.root.after(200, self._force_quit)
            except Exception:
                self._force_quit()
        else:
            self._activity("[!] Uninstalled the service / launcher, but could not "
                           "start the folder cleanup. Delete the folder manually.")
            messagebox.showinfo(
                APP_TITLE,
                "The service / auto-start launcher and shortcuts were removed, but "
                "the install folder could not be auto-deleted. You can close this "
                "window and delete:\n\n  " + install_dir)
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
            else:
                self._drain_status()
            self._drain_logs()
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
            elif event == "cycle":
                # A cycle with ok=True means the heartbeat reached the cloud, so
                # we are Connected; ok=False means it failed (server down / no
                # network), so reflect Disconnected rather than a false "Connected".
                ok = bool(payload.get("ok"))
                self._connected = ok
                self._set_status(ok)
                if ok:
                    self._last_sync_ts = payload.get("ts", time.time())
                    self.lbl_last_sync.configure(
                        text="Last sync: " + self._fmt_ts(self._last_sync_ts))
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
        if connected:
            self.status_dot.configure(text="  Connected", foreground="#0a7d28")
        else:
            self.status_dot.configure(text="  Disconnected", foreground="#b00020")

    @staticmethod
    def _fmt_ts(ts: Optional[float]) -> str:
        if not ts:
            return "never"
        try:
            return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))
        except Exception:
            return "?"

    def _activity(self, line: str, scroll: bool = True) -> None:
        try:
            self.activity.configure(state="normal")
            self.activity.insert("end", _ascii(line) + "\n")
            if scroll:
                self.activity.see("end")
            self.activity.configure(state="disabled")
        except Exception:
            pass


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


def main() -> int:
    """Launch the GUI (or route a service branch). Returns a process exit code."""
    # Route service branches FIRST, before any GUI / single-instance lock. The
    # SCM hosting branch (--run-service) and the elevated management verbs must
    # never create a window or take the GUI lock.
    rc = _route_service_argv(list(sys.argv[1:]))
    if rc is not None:
        return rc

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
        try:
            messagebox.showinfo(APP_TITLE, "Tally Cloud Sync is already running.")
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

    app = AgentApp(root, instance)

    # A background acceptor so a second-launch "focus" message restores us.
    _start_focus_listener(instance, app)

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
