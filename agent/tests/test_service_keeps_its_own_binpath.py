"""Tests that the service's display-name refresh cannot erase its own binPath.

THE ROOT CAUSE THIS FIXES — the origin of every START_PENDING hang seen today.

On start, the service renames itself in services.msc so the version shown there
follows an in-place auto-update. Harmless-looking, and it used to be written as:

    win32serviceutil.ChangeServiceConfig(None, SERVICE_NAME,
                                         displayName=..., description=...)

But that pywin32 wrapper does not change only what it is given. It ALWAYS
rebuilds the command line:

    exeName = '"%s"' % LocatePythonServiceExe(exeName)   # exeName is None here
    commandLine = _GetCommandLine(exeName, exeArgs)      # exeArgs is None too

so the registration lost its `--run-service` argument every single time the
service started. Windows then launched the exe with no arguments on the next
start; with no arguments the exe opens the GUI instead of calling
StartServiceCtrlDispatcher, never reports SERVICE_RUNNING, and sits in
START_PENDING forever. Observed on the live machine:

    BINARY_PATH_NAME : "C:\\Teloora\\Teloora.exe"     <- argument gone
    DISPLAY_NAME     : Teloora 1.0.4                  <- the rename that did it

It defeated the repair too: the update re-registered the service correctly, the
service started, and renaming itself immediately undid the fix.

The rename now goes through the raw API with lpBinaryPathName = None, which is
Windows' documented "leave the binary path alone".

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import win_service  # noqa: E402


class _Svc:
    """Records what the raw ChangeServiceConfig was asked to change."""

    SERVICE_NO_CHANGE = 0xFFFFFFFF
    SC_MANAGER_ALL_ACCESS = 1
    SERVICE_ALL_ACCESS = 2
    SERVICE_CONFIG_DESCRIPTION = 3

    def __init__(self):
        self.calls = []

    def ChangeServiceConfig(self, handle, service_type, start_type, error_control,
                            binary_path, load_order, tag, deps, user, password,
                            display_name):
        self.calls.append({"binary_path": binary_path,
                           "display_name": display_name,
                           "start_type": start_type})

    def ChangeServiceConfig2(self, handle, kind, value):
        self.calls.append({"description": value})

    def OpenSCManager(self, *a):
        return "scm"

    def OpenService(self, *a):
        return "svc"

    def CloseServiceHandle(self, *a):
        pass


class RenameKeepsBinPathTests(unittest.TestCase):

    def setUp(self):
        self.svc = _Svc()
        self._real = getattr(win_service, "win32service", None)
        win_service.win32service = self.svc
        self.addCleanup(setattr, win_service, "win32service", self._real)
        self._had = win_service._HAVE_PYWIN32
        win_service._HAVE_PYWIN32 = True
        self.addCleanup(setattr, win_service, "_HAVE_PYWIN32", self._had)

    def test_the_rename_leaves_the_binary_path_alone(self):
        """The whole bug in one assertion."""
        win_service.set_service_display_name("Teloora 1.0.11", "desc")

        cfg = [c for c in self.svc.calls if "binary_path" in c]
        self.assertTrue(cfg, "no config change was attempted at all")
        self.assertIsNone(cfg[0]["binary_path"],
                          "passing anything but None here rewrites binPath and "
                          "drops --run-service")

    def test_the_name_and_description_still_get_through(self):
        win_service.set_service_display_name("Teloora 1.0.11", "the description")

        names = [c.get("display_name") for c in self.svc.calls if "display_name" in c]
        descs = [c.get("description") for c in self.svc.calls if "description" in c]
        self.assertIn("Teloora 1.0.11", names)
        self.assertIn("the description", descs)

    def test_start_type_is_not_disturbed_either(self):
        """Auto-start must survive a rename as surely as the arguments do."""
        win_service.set_service_display_name("Teloora 1.0.11", "d")
        cfg = [c for c in self.svc.calls if "binary_path" in c][0]
        self.assertEqual(cfg["start_type"], _Svc.SERVICE_NO_CHANGE)

    def test_a_failure_is_swallowed(self):
        """A cosmetic rename must never stop the service from running."""
        def boom(*a, **kw):
            raise OSError("access denied")

        self.svc.ChangeServiceConfig = boom
        win_service.set_service_display_name("x", "y")      # must not raise


if __name__ == "__main__":
    unittest.main()
