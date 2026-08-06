"""Tests for Stop meaning STOP — including after a reboot.

WHY THIS EXISTS
---------------
The Windows service is registered auto-start, so before this the Stop button
lasted exactly until the next boot: someone who deliberately stopped syncing on
Friday found it running again on Monday. Worse, nothing said so — the agent came
back quietly, and the only evidence was data appearing in the cloud from a
machine whose owner believed the agent was off.

So the intent is persisted to config.ini, and the sync loop re-reads it EVERY
cycle. Two things follow, and both are pinned here:

  * A BOOT INTO A STOPPED AGENT STAYS STOPPED. The service still starts (it is
    auto-start and we do not fight the SCM for that), but the loop idles instead
    of syncing.

  * START TAKES EFFECT WITHOUT A RESTART. The Dashboard and the service are
    DIFFERENT PROCESSES: pressing Start changes the file, not the service's cfg
    object. Re-reading per cycle is what makes the button work at all in service
    mode — using the in-memory cfg would look correct in the GUI and do nothing.

The failure direction that matters is asymmetric, which is why the fallbacks all
lean one way: an agent that syncs when you asked it not to is a visible
annoyance; an agent that silently stops syncing is a customer whose books are
quietly going stale. Every unreadable-config path therefore answers "enabled".

Run: python -m unittest discover -s agent/tests
"""

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sync_agent  # noqa: E402
from config import Config  # noqa: E402


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="lk-stopflag-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.ini = os.path.join(self.tmp, "config.ini")

    def _write(self, body):
        with open(self.ini, "w", encoding="utf-8") as fh:
            fh.write(body)
        return Config.load(self.ini)


class PersistenceTests(_Base):

    def test_default_is_enabled(self):
        """A fresh install must sync — nobody has pressed Stop yet."""
        cfg = self._write("[state]\nmachine_id = abc\n")
        self.assertTrue(cfg.sync_enabled)

    def test_stop_is_written_and_read_back(self):
        cfg = self._write("[state]\nmachine_id = abc\n")
        cfg.sync_enabled = False
        cfg.save()
        self.assertFalse(Config.load(self.ini).sync_enabled)

    def test_start_is_written_and_read_back(self):
        cfg = self._write("[state]\nmachine_id = abc\nsync_enabled = false\n")
        self.assertFalse(cfg.sync_enabled)
        cfg.sync_enabled = True
        cfg.save()
        self.assertTrue(Config.load(self.ini).sync_enabled)

    def test_the_flag_survives_a_reload(self):
        """This IS the reboot case: a new process reading the same file."""
        cfg = self._write("[state]\nmachine_id = abc\n")
        cfg.sync_enabled = False
        cfg.save()
        for _ in range(3):                      # several "boots"
            self.assertFalse(Config.load(self.ini).sync_enabled)

    def test_saving_other_settings_does_not_lose_the_flag(self):
        cfg = self._write("[state]\nmachine_id = abc\n")
        cfg.sync_enabled = False
        cfg.save()
        again = Config.load(self.ini)
        again.sync_interval = 300               # unrelated change
        again.save()
        self.assertFalse(Config.load(self.ini).sync_enabled)

    def test_a_garbled_value_reads_as_enabled(self):
        """Never leave a customer silently un-synced because of a bad string."""
        for junk in ("banana", "", "2", "yes-ish"):
            cfg = self._write(f"[state]\nmachine_id = abc\nsync_enabled = {junk}\n")
            self.assertTrue(cfg.sync_enabled, f"{junk!r} should read as enabled")

    def test_common_truthy_and_falsy_spellings(self):
        for val, expected in (("true", True), ("false", False),
                              ("True", True), ("False", False),
                              ("1", True), ("0", False),
                              ("yes", True), ("no", False),
                              ("on", True), ("off", False)):
            cfg = self._write(f"[state]\nmachine_id = abc\nsync_enabled = {val}\n")
            self.assertEqual(cfg.sync_enabled, expected, f"{val!r}")


class LoopGateTests(_Base):
    """_sync_is_enabled is what the running loop actually calls."""

    def test_reads_the_file_not_the_object(self):
        """The service cannot see a Start pressed in the Dashboard any other
        way — its cfg object is a different process's copy."""
        cfg = self._write("[state]\nmachine_id = abc\n")
        # Simulate the Dashboard pressing Stop in another process.
        other = Config.load(self.ini)
        other.sync_enabled = False
        other.save()
        # The loop's own cfg still says enabled...
        self.assertTrue(cfg.sync_enabled)
        # ...but the gate must see the truth on disk.
        self.assertFalse(sync_agent._sync_is_enabled(cfg))

    def test_resume_is_seen_without_reloading_the_loops_cfg(self):
        cfg = self._write("[state]\nmachine_id = abc\nsync_enabled = false\n")
        self.assertFalse(sync_agent._sync_is_enabled(cfg))
        other = Config.load(self.ini)
        other.sync_enabled = True
        other.save()
        self.assertTrue(sync_agent._sync_is_enabled(cfg))

    def test_missing_file_answers_enabled(self):
        cfg = self._write("[state]\nmachine_id = abc\n")
        os.remove(self.ini)
        self.assertTrue(sync_agent._sync_is_enabled(cfg))

    def test_unreadable_file_answers_enabled(self):
        cfg = self._write("[state]\nmachine_id = abc\nsync_enabled = false\n")
        with open(self.ini, "w", encoding="utf-8") as fh:
            fh.write("this is not ini [[[\n")
        self.assertTrue(sync_agent._sync_is_enabled(cfg))

    def test_cfg_without_a_path_falls_back_to_its_own_value(self):
        class _Bare:
            sync_enabled = False
        self.assertFalse(sync_agent._sync_is_enabled(_Bare()))

    def test_cfg_with_nothing_useful_answers_enabled(self):
        class _Empty:
            pass
        self.assertTrue(sync_agent._sync_is_enabled(_Empty()))


if __name__ == "__main__":
    unittest.main()
