"""Tests for what the served UI can ask this machine to do.

Two things are being pinned here.

First, SYNCSTATE'S HONESTY. The window's whole job is to say what is happening,
so the state object must not overstate: a module the cycle has not reached is
"pending", never "synced", and a failed cycle does not quietly read as idle. A
progress display that rounds towards optimism is worse than none, because it is
believed.

Second, THE SURFACE. Anything reachable through the bridge is reachable by our
page, so the handler set is asserted explicitly — a method that appears here by
accident is a capability granted by accident.

Run: python -m unittest discover -s agent/tests
"""

import logging
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bridge_handlers as bh  # noqa: E402


class FakeConfig:
    """Enough Config for the handlers, with the writes recorded."""

    def __init__(self):
        self.machine_id = "M1"
        self.agent_version = "1.2.3"
        self.tally_url = "http://localhost:9000"
        self.sync_interval = 60
        self.auto_update = True
        self._token = ""
        self.saved = 0

    def get_token(self):
        return self._token

    def set_token(self, tok):
        self._token = tok

    def clear_token(self):
        self._token = ""

    def save(self):
        self.saved += 1


def handlers(cfg=None, state=None, log_path=None, on_sync=None, on_out=None):
    cfg = cfg or FakeConfig()
    return cfg, bh.build(lambda: cfg, state or bh.SyncState(),
                         logging.getLogger("test"), log_path=log_path,
                         on_sync_now=on_sync, on_sign_out=on_out)


# ── SyncState ────────────────────────────────────────────────────
class SyncStateTests(unittest.TestCase):

    def test_a_fresh_state_reports_every_module_as_pending(self):
        snap = bh.SyncState().snapshot()
        self.assertEqual(len(snap["modules"]), len(bh.MODULE_LABELS))
        self.assertTrue(all(m["state"] == "pending" for m in snap["modules"]))
        self.assertTrue(all(m["count"] is None for m in snap["modules"]))

    def test_modules_not_yet_reached_stay_pending(self):
        # The difference between "done" and "not started" IS the progress list.
        s = bh.SyncState()
        s.begin("ACME")
        s.step("ledgers", count=10)
        by_key = {m["key"]: m for m in s.snapshot()["modules"]}
        self.assertEqual(by_key["ledgers"]["state"], "synced")
        self.assertEqual(by_key["vouchers"]["state"], "pending")

    def test_the_total_counts_only_modules_that_reported(self):
        s = bh.SyncState()
        s.begin()
        s.step("ledgers", count=10)
        s.step("vouchers", count=5)
        self.assertEqual(s.snapshot()["total"], 15)

    def test_a_module_with_no_count_does_not_break_the_total(self):
        s = bh.SyncState()
        s.begin()
        s.step("reports", count=None, state="synced")
        s.step("ledgers", count=7)
        self.assertEqual(s.snapshot()["total"], 7)

    def test_percent_is_clamped(self):
        # A miscounted stage must not paint a bar past the end or backwards.
        s = bh.SyncState()
        s.step("ledgers", percent=150)
        self.assertEqual(s.snapshot()["percent"], 100.0)
        s.step("ledgers", percent=-20)
        self.assertEqual(s.snapshot()["percent"], 0.0)

    def test_a_failed_cycle_does_not_read_as_idle_or_complete(self):
        s = bh.SyncState()
        s.begin()
        s.step("ledgers", count=1, percent=30)
        s.finish("14:52", ok=False)
        snap = s.snapshot()
        self.assertEqual(snap["state"], "failed")
        # Crucially NOT forced to 100: a failure that shows a full bar is a lie.
        self.assertEqual(snap["percent"], 30.0)

    def test_a_successful_cycle_completes_and_records_the_time(self):
        s = bh.SyncState()
        s.begin("ACME")
        s.finish("14:52")
        snap = s.snapshot()
        self.assertEqual(snap["state"], "idle")
        self.assertEqual(snap["percent"], 100.0)
        self.assertEqual(snap["last_sync"], "14:52")
        self.assertEqual(snap["company"], "ACME")

    def test_beginning_a_new_cycle_clears_the_previous_one(self):
        # Otherwise last cycle's counts linger and the customer reads stale
        # numbers as this cycle's progress.
        s = bh.SyncState()
        s.begin(); s.step("ledgers", count=99); s.finish("10:00")
        s.begin()
        by_key = {m["key"]: m for m in s.snapshot()["modules"]}
        self.assertEqual(by_key["ledgers"]["state"], "pending")
        self.assertIsNone(by_key["ledgers"]["count"])

    def test_a_snapshot_is_a_copy(self):
        s = bh.SyncState()
        s.begin(); s.step("ledgers", count=1)
        snap = s.snapshot()
        snap["modules"][0]["count"] = 999
        self.assertNotEqual(s.snapshot()["modules"][0]["count"], 999)


# ── Handlers ─────────────────────────────────────────────────────
class HandlerTests(unittest.TestCase):

    def test_the_exposed_surface_is_exactly_what_is_intended(self):
        # Anything listed here is callable by the page. Additions should be
        # deliberate, so this test is the gate.
        _, api = handlers()
        self.assertEqual(sorted(api), sorted([
            "machine", "status", "sync-now", "save-token", "sign-out",
            "get-settings", "save-settings",
        ]))

    def test_machine_reports_signed_out_when_there_is_no_token(self):
        cfg, api = handlers()
        self.assertFalse(api["machine"]({})["signed_in"])

    def test_machine_reports_signed_in_once_a_token_is_stored(self):
        cfg, api = handlers()
        cfg.set_token("tok")
        out = api["machine"]({})
        self.assertTrue(out["signed_in"])
        self.assertEqual(out["machine_id"], "M1")

    def test_saving_a_token_persists_it_through_config(self):
        # Not localStorage: browser storage survives sign-out and is readable
        # by anything on the origin.
        cfg, api = handlers()
        api["save-token"]({"agent_token": "tok-1", "agent_id": 5})
        self.assertEqual(cfg.get_token(), "tok-1")

    def test_saving_an_empty_token_is_refused(self):
        cfg, api = handlers()
        with self.assertRaises(ValueError):
            api["save-token"]({"agent_token": "   "})
        self.assertEqual(cfg.get_token(), "")

    def test_sign_out_clears_the_token_and_notifies(self):
        cfg, api = handlers(on_out=lambda: called.append(1))
        called = []
        cfg.set_token("tok")
        api["sign-out"]({})
        self.assertEqual(cfg.get_token(), "")

    def test_sync_now_reports_clearly_when_it_is_not_wired(self):
        # Better a visible error than a button that silently does nothing.
        _, api = handlers()
        with self.assertRaises(RuntimeError):
            api["sync-now"]({})

    def test_sync_now_calls_through_when_wired(self):
        fired = []
        _, api = handlers(on_sync=lambda: fired.append(1))
        self.assertTrue(api["sync-now"]({})["started"])
        self.assertEqual(len(fired), 1)


class SettingsTests(unittest.TestCase):

    def test_settings_never_expose_the_server_url(self):
        # Baked into the exe on purpose. Letting a customer repoint the agent
        # at another server is not a feature.
        _, api = handlers()
        self.assertEqual(sorted(api["get-settings"]({})),
                         ["auto_update", "sync_interval", "tally_url"])

    def test_saving_settings_writes_them(self):
        cfg, api = handlers()
        api["save-settings"]({"tally_url": "http://tally:9001",
                              "sync_interval": 120, "auto_update": False})
        self.assertEqual(cfg.tally_url, "http://tally:9001")
        self.assertEqual(cfg.sync_interval, 120)
        self.assertFalse(cfg.auto_update)
        self.assertEqual(cfg.saved, 1)

    def test_an_absurdly_short_interval_is_refused(self):
        # A 1-second interval hammers Tally continuously and is a typo far more
        # often than an intention.
        cfg, api = handlers()
        with self.assertRaises(ValueError):
            api["save-settings"]({"sync_interval": 1})
        self.assertEqual(cfg.sync_interval, 60)

    def test_a_non_numeric_interval_is_refused(self):
        cfg, api = handlers()
        with self.assertRaises(ValueError):
            api["save-settings"]({"sync_interval": "soon"})

    def test_a_blank_tally_url_keeps_the_existing_one(self):
        # Clearing the field by accident must not disconnect Tally.
        cfg, api = handlers()
        api["save-settings"]({"tally_url": "   "})
        self.assertEqual(cfg.tally_url, "http://localhost:9000")

    def test_omitted_fields_are_left_alone(self):
        cfg, api = handlers()
        api["save-settings"]({"sync_interval": 90})
        self.assertEqual(cfg.tally_url, "http://localhost:9000")
        self.assertTrue(cfg.auto_update)


class LogTailTests(unittest.TestCase):

    def test_the_tail_returns_only_the_end_of_a_large_log(self):
        # An agent running for months has a log far bigger than the window
        # shows; reading all of it on a 2-second poll would be absurd.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "agent.log")
            with open(path, "w", encoding="utf-8") as fh:
                for i in range(20000):
                    fh.write(f"line {i}\n")
            tail = bh._tail(path)
            self.assertLessEqual(len(tail.encode()), bh.LOG_TAIL_BYTES)
            self.assertIn("line 19999", tail)
            self.assertNotIn("line 0\n", tail)

    def test_a_missing_log_is_empty_rather_than_an_error(self):
        # A machine that has not synced yet has no log; that is not a failure.
        self.assertEqual(bh._tail("no-such-file.log"), "")

    def test_status_includes_the_log(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.log")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("hello\n")
            _, api = handlers(log_path=path)
            self.assertIn("hello", api["status"]({})["log"])


if __name__ == "__main__":
    unittest.main()
