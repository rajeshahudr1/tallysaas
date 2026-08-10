"""Tests for the Dashboard's "an update is available" banner.

WHY THIS EXISTS
---------------
The engine has updated itself for a long time (sync_agent.maybe_self_update),
but nothing in the window ever said so: `_update_available` was assigned once in
__init__ and never read again. A customer with auto-update off — or one who just
wanted the new build now — had no signal and no button, so shipping a release
meant mailing an exe to every customer.

The banner closes that. Two of its behaviours are easy to get wrong and are the
reason for this file:

  1. A FAILED CHECK MUST BE SILENT. The version check runs on a timer against a
     cloud the agent may not currently reach. If a transport error, an expired
     token or a malformed body could surface "Update available: v" or an error
     dialog, a customer whose internet blipped would be told their agent is
     broken while it is syncing perfectly well.

  2. "STILL RUNNING" MEANS THE UPDATE FAILED. maybe_self_update ends by
     launching the detached updater batch and calling sys.exit(0) — the exe
     cannot overwrite itself while it is open. So RETURNING NORMALLY is not
     success, it is the failure path, and the button must come back enabled with
     an honest message. Treating a normal return as success would leave the user
     staring at "Updating..." forever on the old version.

Kept as plain unit tests on the unbound methods with a stub `self`, so they need
no display (CI has no interactive desktop session) — the same approach as
test_setup_widget_lifetime.py.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import gui_agent  # noqa: E402


# ── Stubs ────────────────────────────────────────────────────────────────
class _Widget:
    """Records .configure() kwargs and pack/pack_forget calls."""

    def __init__(self):
        self.cfg = {}
        self.packed = False
        self.pack_kw = {}

    def configure(self, **kw):
        self.cfg.update(kw)

    def pack(self, **kw):
        self.packed = True
        self.pack_kw = kw

    def pack_forget(self):
        self.packed = False


class _Root:
    """Tk root stand-in: `after(0, fn)` runs fn immediately so the worker's
    hand-back to the Tk thread is exercised in-line."""

    def after(self, _ms, fn=None):
        if fn is not None:
            fn()


class _App:
    def __init__(self):
        self.root = _Root()


class _Cfg:
    def __init__(self, version="1.0.0", token="tok"):
        self.agent_version = version
        self._token = token

    def get_token(self):
        return self._token


class _Logger:
    def debug(self, *_a, **_k):
        pass

    def info(self, *_a, **_k):
        pass

    def warning(self, *_a, **_k):
        pass


class _Dash:
    """Just enough of DashboardView for the update methods to run.

    The four methods under test are borrowed from the real class, so these are
    tests of the shipped code and not of a re-implementation; everything they
    touch (widgets, cfg, root.after) is stubbed above.
    """

    _check_for_update = gui_agent.DashboardView._check_for_update
    _show_update_bar = gui_agent.DashboardView._show_update_bar
    _hide_update_bar = gui_agent.DashboardView._hide_update_bar
    on_update_now = gui_agent.DashboardView.on_update_now

    def __init__(self, cfg=None):
        self.cfg = cfg or _Cfg()
        self.app = _App()
        self.logger = _Logger()
        self._update_available = ""
        self._update_info = {}
        self._update_busy = False
        self.update_bar = _Widget()
        self.lbl_update_msg = _Widget()
        self.btn_update = _Widget()
        self.btn_update_later = _Widget()
        self._ctrl_frame = object()
        self.activity = []

    def _activity(self, msg, error=False):
        self.activity.append((msg, error))


def _run_check(dash, monkey):
    """Call _check_for_update with threading patched to run inline."""
    real_thread = gui_agent.threading.Thread
    try:
        gui_agent.threading.Thread = monkey
        gui_agent.DashboardView._check_for_update(dash)
    finally:
        gui_agent.threading.Thread = real_thread


class _InlineThread:
    """Runs the target immediately on .start() — no real thread in tests."""

    def __init__(self, target=None, name=None, daemon=None, args=()):
        self._target = target
        self._args = args

    def start(self):
        self._target(*self._args)


# ── Tests ────────────────────────────────────────────────────────────────
class UpdateCheckTests(unittest.TestCase):

    def setUp(self):
        self._orig_build_api = gui_agent.sync_agent.build_api

    def tearDown(self):
        gui_agent.sync_agent.build_api = self._orig_build_api

    def _fake_cloud(self, payload, boom=False):
        class _Api:
            def get_latest_version(_s, _tok, installed_version=None):
                if boom:
                    raise RuntimeError("connection reset")
                return payload
        gui_agent.sync_agent.build_api = lambda *_a, **_k: _Api()

    def test_newer_version_shows_the_banner(self):
        dash = _Dash(_Cfg(version="1.0.0"))
        self._fake_cloud({"latest_version": "1.4.0"})
        _run_check(dash, _InlineThread)

        self.assertEqual(dash._update_available, "1.4.0")
        self.assertTrue(dash.update_bar.packed)
        text = dash.lbl_update_msg.cfg.get("text", "")
        self.assertIn("1.4.0", text)
        self.assertIn("1.0.0", text)          # installed version is shown too
        # Placed above the buttons, not appended under them.
        self.assertIs(dash.update_bar.pack_kw.get("before"), dash._ctrl_frame)

    def test_same_version_shows_nothing(self):
        dash = _Dash(_Cfg(version="1.4.0"))
        self._fake_cloud({"latest_version": "1.4.0"})
        _run_check(dash, _InlineThread)

        self.assertEqual(dash._update_available, "")
        self.assertFalse(dash.update_bar.packed)

    def test_older_published_version_shows_nothing(self):
        """A rollback on the server must not offer a 'downgrade'."""
        dash = _Dash(_Cfg(version="2.0.0"))
        self._fake_cloud({"latest_version": "1.9.9"})
        _run_check(dash, _InlineThread)

        self.assertEqual(dash._update_available, "")
        self.assertFalse(dash.update_bar.packed)

    def test_cloud_failure_is_silent(self):
        """Reason 1 in the module docstring: offline must look like normal."""
        dash = _Dash()
        self._fake_cloud(None, boom=True)
        _run_check(dash, _InlineThread)

        self.assertEqual(dash._update_available, "")
        self.assertFalse(dash.update_bar.packed)
        self.assertEqual(dash.activity, [])   # nothing written to the console

    def test_empty_body_is_silent(self):
        dash = _Dash()
        self._fake_cloud({})
        _run_check(dash, _InlineThread)
        self.assertEqual(dash._update_available, "")
        self.assertFalse(dash.update_bar.packed)

    def test_no_token_does_not_call_the_cloud(self):
        """A machine that never signed in has no token; asking would 401."""
        dash = _Dash(_Cfg(token=""))
        called = {"n": 0}

        class _Api:
            def get_latest_version(_s, *_a, **_k):
                called["n"] += 1
                return {"latest_version": "9.9.9"}
        gui_agent.sync_agent.build_api = lambda *_a, **_k: _Api()

        _run_check(dash, _InlineThread)
        self.assertEqual(called["n"], 0)
        self.assertFalse(dash.update_bar.packed)

    def test_mandatory_release_hides_later(self):
        dash = _Dash(_Cfg(version="1.0.0"))
        self._fake_cloud({"latest_version": "1.5.0", "mandatory": True})
        _run_check(dash, _InlineThread)

        self.assertTrue(dash.update_bar.packed)
        self.assertFalse(dash.btn_update_later.packed)
        self.assertIn("Required", dash.lbl_update_msg.cfg.get("text", ""))

    def test_check_is_skipped_while_banner_is_up(self):
        """No point re-asking (or re-packing) once we are already showing it."""
        dash = _Dash(_Cfg(version="1.0.0"))
        dash._update_available = "1.4.0"
        called = {"n": 0}

        class _Api:
            def get_latest_version(_s, *_a, **_k):
                called["n"] += 1
                return {"latest_version": "1.4.0"}
        gui_agent.sync_agent.build_api = lambda *_a, **_k: _Api()

        _run_check(dash, _InlineThread)
        self.assertEqual(called["n"], 0)

    def test_later_hides_without_clearing_the_known_version(self):
        dash = _Dash(_Cfg(version="1.0.0"))
        self._fake_cloud({"latest_version": "1.4.0"})
        _run_check(dash, _InlineThread)

        gui_agent.DashboardView._hide_update_bar(dash)
        self.assertFalse(dash.update_bar.packed)
        self.assertEqual(dash._update_available, "1.4.0")


class UpdateApplyTests(unittest.TestCase):
    """Reason 2 in the module docstring."""

    # The dialogs are ui_signin's, not tkinter's messagebox. The app moved to
    # its own drawn dialogs (see ui_signin.Dialog) and this harness kept faking
    # messagebox, so on_update_now's real confirm() ran unpatched, returned
    # None, and every test here failed on the button state instead of on
    # anything it meant to check.
    def setUp(self):
        self._orig_build_api = gui_agent.sync_agent.build_api
        self._orig_update = gui_agent.sync_agent.maybe_self_update
        self._orig_confirm = gui_agent.ui_signin.confirm
        self._orig_alert = gui_agent.ui_signin.alert
        gui_agent.sync_agent.build_api = lambda *_a, **_k: object()

    def tearDown(self):
        gui_agent.sync_agent.build_api = self._orig_build_api
        gui_agent.sync_agent.maybe_self_update = self._orig_update
        gui_agent.ui_signin.confirm = self._orig_confirm
        gui_agent.ui_signin.alert = self._orig_alert

    class _Box:
        """Stands in for ui_signin.confirm + ui_signin.alert.

        ``warnings`` collects the kind="warning" alerts and ``errors`` the rest,
        which is the distinction the assertions below care about: a failed
        update and an update that simply did not happen are different things to
        tell somebody.
        """

        def __init__(self, answer=True):
            self.answer = answer
            self.errors = []
            self.warnings = []
            self.asked = 0

        def confirm(self, *_a, **_k):
            self.asked += 1
            return self.answer

        def alert(self, _parent, msg, *, kind="error", title=""):
            (self.warnings if kind == "warning" else self.errors).append(msg)

    def _apply(self, dash, box):
        gui_agent.ui_signin.confirm = box.confirm
        gui_agent.ui_signin.alert = box.alert
        real_thread = gui_agent.threading.Thread
        try:
            gui_agent.threading.Thread = _InlineThread
            gui_agent.DashboardView.on_update_now(dash)
        finally:
            gui_agent.threading.Thread = real_thread

    def test_declining_the_prompt_does_nothing(self):
        dash = _Dash()
        dash._update_available = "1.4.0"
        ran = {"n": 0}
        gui_agent.sync_agent.maybe_self_update = lambda *_a, **_k: ran.__setitem__("n", ran["n"] + 1)

        box = self._Box(answer=False)
        self._apply(dash, box)

        self.assertEqual(ran["n"], 0)
        self.assertFalse(dash._update_busy)
        self.assertEqual(box.asked, 1)

    def test_normal_return_is_reported_as_failure(self):
        """maybe_self_update returning = the swap did NOT happen."""
        dash = _Dash()
        dash._update_available = "1.4.0"
        gui_agent.sync_agent.maybe_self_update = lambda *_a, **_k: None

        box = self._Box()
        self._apply(dash, box)

        self.assertFalse(dash._update_busy)
        self.assertEqual(dash.btn_update.cfg.get("state"), "normal")
        self.assertEqual(dash.btn_update.cfg.get("text"), "Update Now")
        self.assertEqual(len(box.warnings), 1)
        self.assertIn("still running", box.warnings[0].lower())

    def test_exception_surfaces_the_reason(self):
        dash = _Dash()
        dash._update_available = "1.4.0"

        def _boom(*_a, **_k):
            raise RuntimeError("checksum mismatch")
        gui_agent.sync_agent.maybe_self_update = _boom

        box = self._Box()
        self._apply(dash, box)

        self.assertFalse(dash._update_busy)
        self.assertEqual(dash.btn_update.cfg.get("state"), "normal")
        self.assertEqual(len(box.errors), 1)
        self.assertIn("checksum mismatch", box.errors[0])

    def test_sysexit_is_not_swallowed(self):
        """The successful path: the process must be allowed to exit so the
        detached batch can replace the running exe."""
        dash = _Dash()
        dash._update_available = "1.4.0"

        def _exits(*_a, **_k):
            raise SystemExit(0)
        gui_agent.sync_agent.maybe_self_update = _exits

        box = self._Box()
        with self.assertRaises(SystemExit):
            self._apply(dash, box)
        # Never told the user it failed — it did not.
        self.assertEqual(box.errors, [])
        self.assertEqual(box.warnings, [])

    def test_double_click_runs_once(self):
        dash = _Dash()
        dash._update_available = "1.4.0"
        dash._update_busy = True          # a run is already in flight
        ran = {"n": 0}
        gui_agent.sync_agent.maybe_self_update = lambda *_a, **_k: ran.__setitem__("n", ran["n"] + 1)

        box = self._Box()
        self._apply(dash, box)
        self.assertEqual(ran["n"], 0)
        self.assertEqual(box.asked, 0)


if __name__ == "__main__":
    unittest.main()
