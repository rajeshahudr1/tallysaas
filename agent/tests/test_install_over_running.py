"""Tests for installing OVER an already-running agent.

Setup can legitimately be re-run: the customer re-connects the machine, changes
a setting, or (as here) the first attempt showed a scary dialog and they simply
tried again. By then the FIRST install has already registered the Windows
service — which is running `C:\\TallyCloudSync\\TallyCloudSync.exe`, the exact
file the copy step wants to overwrite. Windows refuses:

    [WinError 32] The process cannot access the file because it is being
    used by another process

and setup reported "Install failed" for something the customer could not
possibly act on.

What is pinned here: the copy STOPS the background syncer and retries rather
than failing on the first refusal, it does not stop anything when the copy
succeeds outright (the common first-install case), and when the file stays
locked the error names the cause instead of leaking a Windows code.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import gui_agent  # noqa: E402


def _locked(_src, _dst):
    raise PermissionError(13, "The process cannot access the file because it is "
                              "being used by another process")


class CopyOverRunningExeTests(unittest.TestCase):

    def setUp(self):
        self.said = []
        self.stops = []

    def _append(self, text, **_kw):
        self.said.append(text)

    def _stop(self):
        self.stops.append(True)
        return True

    def test_clean_copy_does_not_touch_the_service(self):
        """First install: nothing is running, so nothing must be stopped."""
        copies = []
        gui_agent.copy_over_running_exe(
            "src.exe", "dst.exe", stop_fn=self._stop, append=self._append,
            copy_fn=lambda s, d: copies.append((s, d)), sleep_fn=lambda _s: None)
        self.assertEqual(copies, [("src.exe", "dst.exe")])
        self.assertEqual(self.stops, [])

    def test_locked_file_stops_the_syncer_then_succeeds(self):
        """The reported bug: the service holds the exe. Stop it and retry."""
        calls = []

        def copy_fn(s, d):
            calls.append((s, d))
            if len(calls) == 1:          # locked until the service is stopped
                _locked(s, d)

        gui_agent.copy_over_running_exe(
            "src.exe", "dst.exe", stop_fn=self._stop, append=self._append,
            copy_fn=copy_fn, sleep_fn=lambda _s: None)
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.stops, [True])

    def test_still_locked_raises_an_explainable_error(self):
        """A Windows error code is not something a customer can act on."""
        with self.assertRaises(RuntimeError) as ctx:
            gui_agent.copy_over_running_exe(
                "src.exe", "dst.exe", stop_fn=self._stop, append=self._append,
                copy_fn=_locked, sleep_fn=lambda _s: None, tries=3)
        msg = str(ctx.exception)
        self.assertIn("still running", msg.lower())
        self.assertIn("dst.exe", msg)
        # And it must have actually tried to stop the syncer before giving up.
        self.assertEqual(self.stops, [True])

    def test_a_non_lock_error_is_not_retried(self):
        """Out of disk / bad path must surface at once, not after 6 sleeps."""
        calls = []

        def copy_fn(_s, _d):
            calls.append(1)
            raise OSError(28, "No space left on device")

        with self.assertRaises(OSError):
            gui_agent.copy_over_running_exe(
                "src.exe", "dst.exe", stop_fn=self._stop, append=self._append,
                copy_fn=copy_fn, sleep_fn=lambda _s: None)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.stops, [])


if __name__ == "__main__":
    unittest.main()
