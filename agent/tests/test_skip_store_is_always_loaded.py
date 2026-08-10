"""Tests that the "requests that kill Tally" list is loaded before any cycle.

THE BUG THIS PINS, caught on a live machine. The quarantine is written to
.tally_skip.json precisely so a fatal request is discovered ONCE and never sent
again — "without it every fresh process re-discovers the fatal request by
crashing Tally with it once more" (skip_store_path's own docstring).

But use_skip_store() was called from exactly one place: run_sync_loop. Any other
entry into a cycle — `--once` most obviously — started with an EMPTY quarantine
and cheerfully asked for the request the file already named. Observed at 18:17
on a machine whose store had listed TSSMTDSCategory for over an hour:

    18:17:42  Tally request -> Collection TSSMTDSCategory
    18:19:42  Tally STOPPED ANSWERING (its error box is up)

The customer meets the error box again, and the whole cycle is lost behind a
Tally that no longer answers — from a run whose only job was to prove sync
works.

Loading belongs with the cycle, not with one caller of it. Every path into a
cycle goes through _run_cycle, so that is where it is done.

Run: python -m unittest discover -s agent/tests
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sync_agent          # noqa: E402
import tally_connector     # noqa: E402


class _Cfg:
    sync_interval = 60
    agent_version = "test"

    def __init__(self, path):
        self.path = path

    def get_token(self):
        return ""          # stops the cycle immediately after the load


class _Logger:
    def __getattr__(self, _name):
        return lambda *a, **kw: None


class SkipStoreLoadingTests(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="tel-skip-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.cfg = _Cfg(os.path.join(self.dir, "config.ini"))
        tally_connector._POISON.clear()
        self.addCleanup(tally_connector._POISON.clear)

    def _write_store(self, labels):
        with open(os.path.join(self.dir, ".tally_skip.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(labels, fh)

    def test_a_cycle_loads_what_earlier_runs_learned(self):
        """The reported case: --once ran with an empty quarantine."""
        self._write_store(["Collection TSSMTDSCategory"])

        sync_agent._run_cycle(self.cfg, _Logger(), object())

        self.assertIn("Collection TSSMTDSCategory", tally_connector._POISON,
                      "the cycle asked Tally without reading what it already knew")

    def test_a_missing_store_is_not_an_error(self):
        """A first run has no file. That must be ordinary, not a failure."""
        sync_agent._run_cycle(self.cfg, _Logger(), object())
        self.assertEqual(tally_connector._POISON, set())

    def test_a_corrupt_store_never_stops_the_cycle(self):
        """Re-learning the hard way beats not starting."""
        with open(os.path.join(self.dir, ".tally_skip.json"), "w",
                  encoding="utf-8") as fh:
            fh.write("{not json")
        sync_agent._run_cycle(self.cfg, _Logger(), object())
        self.assertEqual(tally_connector._POISON, set())


if __name__ == "__main__":
    unittest.main()
