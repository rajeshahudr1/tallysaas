"""Windows Service wrapper for the Tally Cloud Sync Agent (Phase 2).

This module turns the SAME one-file exe into a professional background Windows
service - the equivalent of TallyPrime's "Tally Scheduler" service - so the
sync runs even when no user is logged in, started automatically during the GUI
install. It is intentionally tiny and HEADLESS: it never imports tkinter and
never duplicates the sync logic; it just loads :class:`config.Config` from the
install directory and drives the SHARED engine entry :func:`sync_agent.run_sync_loop`
with a stop :class:`threading.Event` and a ``.status.json`` writer so the
Dashboard can observe + control it.

The service is hosted by the frozen exe via the ``--run-service`` argv branch in
:mod:`gui_agent` (``servicemanager.PrepareToHostSingle`` ->
``StartServiceCtrlDispatcher``). Install / remove / start / stop are performed
through the same exe's ``install-service`` / ``remove-service`` / ... verbs,
which call into the ``win32serviceutil`` helpers here.

Dependencies: pywin32 (win32serviceutil / win32service / win32event /
servicemanager) + the agent's own stdlib + requests engine. pywin32 is imported
lazily inside the functions/methods so that importing this module on a machine
WITHOUT pywin32 (e.g. a dev box building the console exe) does not hard-fail at
import time; the GUI only routes here when the service verbs are used.
"""

from __future__ import annotations

import os
import sys
import threading


# Service identity. _svc_name_ is the SCM key; the display name + description are
# what the operator sees in services.msc (mirrors "Tally Scheduler").
SERVICE_NAME = "TallyCloudSync"
SERVICE_DISPLAY_NAME = "Tally Cloud Sync"
SERVICE_DESCRIPTION = "Background sync between TallyPrime and Tally Cloud."


def get_version() -> str:
    """Best-effort agent version stamped into the build (config._DEFAULT_AGENT_VERSION).

    Used to put the version in the services.msc display name + description so the
    operator can tell which build the service is at a glance. Falls back to an
    empty string when config cannot be imported (then callers use the bare name).
    """
    try:
        from config import _DEFAULT_AGENT_VERSION  # type: ignore
        return str(_DEFAULT_AGENT_VERSION).strip()
    except Exception:
        return ""


def _versioned_display_name(version: "str | None" = None) -> str:
    """``"Tally Cloud Sync <version>"`` (or the bare name when no version)."""
    v = (version if version is not None else get_version()).strip()
    return (SERVICE_DISPLAY_NAME + " " + v) if v else SERVICE_DISPLAY_NAME


def _versioned_description(version: "str | None" = None) -> str:
    """Description text carrying the version, e.g. ``"... Version: 1.2.1."``."""
    v = (version if version is not None else get_version()).strip()
    if v:
        return SERVICE_DESCRIPTION + " Version: " + v + "."
    return SERVICE_DESCRIPTION


def _install_dir() -> str:
    """Directory the service should treat as home (config.ini + logs/ live here).

    Frozen: the folder of the running exe (``sys.executable``) - the install
    folder the GUI copied the exe into. From source: this file's directory.
    """
    if bool(getattr(sys, "frozen", False)):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


# win32serviceutil.ServiceFramework is the base class; import lazily + guard so
# this module still imports where pywin32 is absent (only the verbs need it).
try:  # pragma: no cover - environment dependent.
    import win32serviceutil  # type: ignore
    import win32service  # type: ignore
    import win32event  # type: ignore
    import servicemanager  # type: ignore
    _HAVE_PYWIN32 = True
    _ServiceBase = win32serviceutil.ServiceFramework
except Exception:  # pragma: no cover - dev box without pywin32.
    win32serviceutil = None  # type: ignore
    win32service = None  # type: ignore
    win32event = None  # type: ignore
    servicemanager = None  # type: ignore
    _HAVE_PYWIN32 = False
    _ServiceBase = object  # type: ignore


class TallyCloudSyncService(_ServiceBase):
    """The background sync service. Loads config from the install dir + runs the
    shared :func:`sync_agent.run_sync_loop` headless until stopped."""

    _svc_name_ = SERVICE_NAME
    _svc_display_name_ = SERVICE_DISPLAY_NAME
    _svc_description_ = SERVICE_DESCRIPTION

    def __init__(self, args):
        # ServiceFramework.__init__ must run so SCM can talk to us.
        win32serviceutil.ServiceFramework.__init__(self, args)
        # A Win32 event SCM can wait on, plus a threading.Event the engine honours.
        self._hwait = win32event.CreateEvent(None, 0, 0, None)
        self._stop = threading.Event()

    # -- SCM control entry points ----------------------------------------- #
    def SvcStop(self):
        """Asked to stop: flag STOP_PENDING, set the stop event, wake the wait.

        The engine's interruptible sleep honours ``self._stop`` so the loop
        returns promptly; we report STOP_PENDING first so SCM does not time us
        out while a cycle finishes.
        """
        try:
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        except Exception:
            pass
        self._stop.set()
        try:
            win32event.SetEvent(self._hwait)
        except Exception:
            pass

    def SvcDoRun(self):
        """Service main: report RUNNING, then run the sync loop until stopped."""
        try:
            servicemanager.LogInfoMsg("Tally Cloud Sync service starting.")
        except Exception:
            pass
        try:
            self.ReportServiceStatus(win32service.SERVICE_RUNNING)
        except Exception:
            pass
        try:
            self._main()
        except Exception as exc:  # never let a crash leave SCM hanging.
            try:
                servicemanager.LogErrorMsg(
                    "Tally Cloud Sync service error: " + str(exc))
            except Exception:
                pass
        try:
            servicemanager.LogInfoMsg("Tally Cloud Sync service stopped.")
        except Exception:
            pass

    # -- actual work (headless; no tkinter) ------------------------------- #
    def _main(self) -> None:
        """Load config from the install dir + drive the shared engine loop.

        Runs with cwd set to the install dir so the engine's relative ``logs/``
        and the ``.status.json`` / ``.sync_now`` interop files land beside
        config.ini. All imports are local so importing this module is cheap and
        tkinter is never touched.
        """
        install_dir = _install_dir()
        # Make logs/ + the interop files resolve under the install folder.
        try:
            os.chdir(install_dir)
        except Exception:
            pass

        from config import Config
        from logger import get_logger
        import sync_agent

        cfg = Config.load(os.path.join(install_dir, "config.ini"))
        logger = get_logger("service", cfg.log_level)
        logger.info("Service: loaded config from %s", install_dir)

        # Best-effort: keep the services.msc display name + description in sync
        # with the RUNNING build's version. After an auto-update swaps the exe in
        # place (no reinstall), the SCM-stored name would otherwise show the old
        # version; the service runs as LocalSystem (admin) so it can rename
        # itself here. Never let a rename failure stop the service.
        try:
            version = (getattr(cfg, "agent_version", "") or "").strip()
            win32serviceutil.ChangeServiceConfig(
                None,
                SERVICE_NAME,
                displayName=_versioned_display_name(version),
                description=_versioned_description(version),
            )
            logger.info("Service: display name set to '%s'.",
                        _versioned_display_name(version))
        except Exception as exc:
            logger.debug("Service: display-name self-refresh skipped: %s", exc)

        api = sync_agent.build_api(cfg, logger)
        # The headless service has no GUI queue, so it publishes status to
        # .status.json for the Dashboard to poll.
        on_status = sync_agent.make_status_writer(cfg, logger)

        # run_sync_loop honours stop_event via its interruptible sleep, so SvcStop
        # ends it promptly. It also consumes any .sync_now trigger each iteration.
        sync_agent.run_sync_loop(
            cfg, logger, api, on_status=on_status, stop_event=self._stop)


# --------------------------------------------------------------------------- #
# Service management helpers (called by gui_agent's argv verbs)
# --------------------------------------------------------------------------- #
def _service_binary(exe_path: "str | None" = None) -> "tuple[str, str]":
    """Return ``(exeName, exeArgs)`` SCM should launch for the service.

    ``exeName`` is the program path and ``exeArgs`` is the rest of the command
    line. They are kept SEPARATE because pywin32 stores them in distinct SCM
    fields - embedding the args inside ``exeName`` makes SCM treat the whole
    string as the binary path.

    * ``exe_path`` given (an absolute, STABLE installed-exe path): register the
      service to exactly THAT exe with ``--run-service``. This is the production
      path - the GUI install flow passes ``<install_dir>\\TallyCloudSync.exe`` so
      the binPath is the install-dir exe regardless of where the launcher /
      release / temp exe that ran ``install-service`` lives. The service then
      reads ``<install_dir>\\config.ini`` (the token) and writes logs +
      ``.status.json`` into ``<install_dir>`` (its own folder).
    * Frozen, no ``exe_path`` : ``(<this exe>, "--run-service")`` - fall back to
      the running exe (the legacy behaviour) so a manual elevated
      ``TallyCloudSync.exe install-service`` from the install dir still works.
    * Source : ``(python.exe, '"<gui_agent.py>" --run-service')`` so the service
      can still be registered while developing.
    """
    if exe_path:
        # Explicit, stable installed-exe path wins (production install flow).
        return os.path.abspath(exe_path), "--run-service"
    exe = os.path.abspath(sys.executable)
    if bool(getattr(sys, "frozen", False)):
        return exe, "--run-service"
    gui = os.path.join(_install_dir(), "gui_agent.py")
    return exe, '"%s" --run-service' % gui


def install_service(exe_path: "str | None" = None) -> int:
    """Register the service (auto-start) and (best-effort) start it.

    Uses ``win32serviceutil.InstallService`` with an explicit binary path,
    ``startType=auto`` so it comes up at boot, and a friendly display name +
    description. Returns a process exit code (0 on success). Run ELEVATED (the
    GUI does this via a UAC re-launch).

    ``exe_path`` is the STABLE installed-exe path the service must be registered
    to (``<install_dir>\\TallyCloudSync.exe``). When given, the binPath is that
    exact file - NEVER whatever exe happened to be running when this verb
    executed (so launching the installer from a download / release / temp folder
    no longer mis-points the service). The already-installed branch ALSO
    re-points the binPath via ``ChangeServiceConfig`` so a re-install / repair
    corrects a previously mis-registered service.
    """
    if not _HAVE_PYWIN32:
        print("pywin32 not available; cannot install the service.")
        return 1
    exe_name, exe_args = _service_binary(exe_path)
    print("Service binPath:", exe_name, exe_args)
    # Stamp the build version into the display name + description so services.msc
    # shows "Tally Cloud Sync <version>" (falls back to the bare name if unknown).
    display_name = _versioned_display_name()
    description = _versioned_description()
    try:
        win32serviceutil.InstallService(
            None,
            SERVICE_NAME,
            display_name,
            startType=win32service.SERVICE_AUTO_START,
            description=description,
            exeName=exe_name,
            exeArgs=exe_args,
        )
        print("Service installed:", SERVICE_NAME)
    except Exception as exc:
        # Already installed -> try to (re)configure the binary path + auto-start.
        try:
            win32serviceutil.ChangeServiceConfig(
                None,
                SERVICE_NAME,
                displayName=display_name,
                startType=win32service.SERVICE_AUTO_START,
                description=description,
                exeName=exe_name,
                exeArgs=exe_args,
            )
            print("Service reconfigured:", SERVICE_NAME)
        except Exception as exc2:
            print("Could not install the service:", exc, "/", exc2)
            return 1
    # Best-effort immediate start (startType=auto also brings it up on reboot).
    try:
        win32serviceutil.StartService(SERVICE_NAME)
        print("Service started.")
    except Exception as exc:
        print("Service installed but could not start now:", exc)
    return 0


def remove_service() -> int:
    """Stop (if running) then remove the service. Best-effort, elevated."""
    if not _HAVE_PYWIN32:
        print("pywin32 not available; cannot remove the service.")
        return 1
    try:
        win32serviceutil.StopService(SERVICE_NAME)
        print("Service stopped.")
    except Exception:
        pass  # not running / already gone is fine.
    try:
        win32serviceutil.RemoveService(SERVICE_NAME)
        print("Service removed:", SERVICE_NAME)
        return 0
    except Exception as exc:
        print("Could not remove the service:", exc)
        return 1


def start_service() -> int:
    """Start the installed service. Elevated."""
    if not _HAVE_PYWIN32:
        print("pywin32 not available; cannot start the service.")
        return 1
    try:
        win32serviceutil.StartService(SERVICE_NAME)
        print("Service started.")
        return 0
    except Exception as exc:
        print("Could not start the service:", exc)
        return 1


def stop_service() -> int:
    """Stop the running service. Elevated."""
    if not _HAVE_PYWIN32:
        print("pywin32 not available; cannot stop the service.")
        return 1
    try:
        win32serviceutil.StopService(SERVICE_NAME)
        print("Service stopped.")
        return 0
    except Exception as exc:
        print("Could not stop the service:", exc)
        return 1


def service_status() -> "str | None":
    """Return a coarse service state string, or None if not installed.

    One of: ``running`` / ``stopped`` / ``start_pending`` / ``stop_pending`` /
    ``paused`` / ``unknown``. ``None`` means the service is not registered (so
    the Dashboard should fall back to portable in-process mode). Never raises.
    """
    if not _HAVE_PYWIN32:
        return None
    try:
        status = win32serviceutil.QueryServiceStatus(SERVICE_NAME)
    except Exception:
        return None  # not installed (or query denied) -> treat as absent.
    try:
        state = status[1]
    except Exception:
        return "unknown"
    mapping = {
        win32service.SERVICE_RUNNING: "running",
        win32service.SERVICE_STOPPED: "stopped",
        win32service.SERVICE_START_PENDING: "start_pending",
        win32service.SERVICE_STOP_PENDING: "stop_pending",
        win32service.SERVICE_PAUSED: "paused",
    }
    return mapping.get(state, "unknown")


def is_service_installed() -> bool:
    """True when the service is registered with the SCM (any state)."""
    return service_status() is not None


def run_service_dispatch() -> int:
    """Host the service in this process (the ``--run-service`` branch).

    This is the branch the SCM invokes when it starts the service: it hands the
    process over to ``StartServiceCtrlDispatcher`` via
    ``servicemanager.PrepareToHostSingle``. Blocks until the service stops.
    Returns a process exit code.
    """
    if not _HAVE_PYWIN32:
        print("pywin32 not available; cannot host the service.")
        return 1
    try:
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(TallyCloudSyncService)
        servicemanager.StartServiceCtrlDispatcher()
        return 0
    except Exception as exc:
        try:
            servicemanager.LogErrorMsg("Service dispatch failed: " + str(exc))
        except Exception:
            pass
        return 1
