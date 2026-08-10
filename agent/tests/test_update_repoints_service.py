"""Tests for the service step of an in-place UPDATE.

THE BUG THIS PINS. An installed machine had its service registered by an older
build, whose binPath was the bare exe:

    BINARY_PATH_NAME : "C:\\Teloora\\Teloora.exe"      <- no --run-service
    DISPLAY_NAME     : Teloora 1.0.4                   <- stale version

SCM therefore launched the GUI, which never calls StartServiceCtrlDispatcher,
so the service sat in START_PENDING forever. The update screen hung on
"Restarting the background service..." and the Dashboard read "Service:
Unknown" — on a machine where the sync was in fact running in-process.

The update only ever ran ``start-service``, which starts whatever is registered
and cannot repair a wrong registration. It now runs ``install-service`` with the
install-dir exe, whose already-installed branch re-points binPath + args + the
versioned display name (win_service.install_service) and then starts it. An
update is the one moment we know the correct path, so it is the moment to
assert it.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import gui_agent  # noqa: E402


class RepointServiceTests(unittest.TestCase):

    def setUp(self):
        self.said = []
        self.calls = []

    def _append(self, text):
        self.said.append(text)

    def _verb(self, verb, **kw):
        self.calls.append((verb, kw))
        return True

    def test_registers_rather_than_merely_starting(self):
        """The whole point: repair the registration, do not just start it."""
        ok = gui_agent.repoint_and_start_service(
            r"C:\Teloora\Teloora.exe", append=self._append,
            verb_fn=self._verb, installed_fn=lambda: True)

        self.assertTrue(ok)
        self.assertEqual(len(self.calls), 1)
        verb, kw = self.calls[0]
        self.assertEqual(verb, "install-service")
        # The STABLE install-dir exe, so binPath can never end up as the
        # temp/download exe that happens to be running this update.
        self.assertEqual(kw.get("extra"), os.path.abspath(r"C:\Teloora\Teloora.exe"))
        self.assertTrue(kw.get("wait"))

    def test_no_service_installed_is_a_no_op(self):
        """A logon-autostart install has no service; do not summon a UAC prompt."""
        ok = gui_agent.repoint_and_start_service(
            r"C:\Teloora\Teloora.exe", append=self._append,
            verb_fn=self._verb, installed_fn=lambda: False)

        self.assertFalse(ok)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.said, [])

    def test_failure_tells_the_customer_what_to_do(self):
        """UAC declined: the update still succeeded, so say the next step."""
        ok = gui_agent.repoint_and_start_service(
            r"C:\Teloora\Teloora.exe", append=self._append,
            verb_fn=lambda *_a, **_kw: False, installed_fn=lambda: True)

        self.assertFalse(ok)
        self.assertTrue(any("Dashboard" in s for s in self.said),
                        "the failure line must name the way out: " + repr(self.said))

    def test_a_raising_verb_never_fails_the_update(self):
        """The exe is already copied. Nothing here may turn that into a failure."""
        def boom(*_a, **_kw):
            raise OSError("ShellExecute failed")

        ok = gui_agent.repoint_and_start_service(
            r"C:\Teloora\Teloora.exe", append=self._append,
            verb_fn=boom, installed_fn=lambda: True)
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
