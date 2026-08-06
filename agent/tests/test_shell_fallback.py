"""The window must open on EVERY customer PC, including old ones.

pywebview draws its window with WebView2, which is an Edge component. It ships
with Windows 11 and reaches most updated Windows 10 machines through Edge — but
not all of them: LTSC images, machines where Edge was removed or blocked by
policy, and PCs that have not been updated in years can lack it entirely. Those
are exactly the back-office machines this agent gets installed on.

An app that refuses to open is a far worse outcome than one that opens somewhere
less pretty, so the host degrades: real window -> default browser -> print the
URL and keep syncing headless. These tests pin that chain, because it is only
exercised on machines we do not have.

Run: python -m unittest discover -s agent/tests
"""

import logging
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import shell as shell_mod  # noqa: E402
from shell import AgentShell  # noqa: E402


class OriginTests(unittest.TestCase):

    def test_the_bridge_origin_is_derived_from_the_ui_url(self):
        # Two settings that must agree are one settings bug waiting to happen,
        # so the CORS allow-list is computed, never configured separately.
        s = AgentShell("https://app.example.test/agent-app", {},
                       logger=logging.getLogger("test"))
        self.assertEqual(s.bridge._origin, "https://app.example.test")

    def test_a_port_in_the_url_is_kept(self):
        # A LAN build points at http://192.168.x.x:4600 — dropping the port
        # would make every bridge call fail the origin check.
        s = AgentShell("http://192.168.4.28:4600/agent-app", {})
        self.assertEqual(s.bridge._origin, "http://192.168.4.28:4600")

    def test_a_malformed_url_yields_no_origin_rather_than_a_wrong_one(self):
        # An empty allow-list refuses every cross-origin call. That is the safe
        # direction: a guessed origin would ACCEPT calls it should not.
        self.assertEqual(AgentShell("not-a-url", {}).bridge._origin, "")


class HostFallbackTests(unittest.TestCase):
    """The chain: webview -> browser -> headless."""

    def setUp(self):
        self.opened = []
        self._real_open = shell_mod.webbrowser.open
        self._real_avail = AgentShell.webview_available
        shell_mod.webbrowser.open = lambda url, new=0: self.opened.append(url) or True

    def tearDown(self):
        shell_mod.webbrowser.open = self._real_open
        AgentShell.webview_available = self._real_avail

    def _shell(self):
        s = AgentShell("http://127.0.0.1:9/agent-app", {},
                       logger=logging.getLogger("test"))
        self.addCleanup(s.stop)
        return s

    def test_without_webview_the_browser_is_used(self):
        # The common case on an older back-office PC.
        AgentShell.webview_available = staticmethod(lambda: False)
        s = self._shell()
        self.assertEqual(s.run("auto"), "browser")
        self.assertEqual(len(self.opened), 1)

    def test_the_browser_receives_the_port_and_token(self):
        # Without them the page loads and reports "not connected" — it cannot
        # reach this machine at all.
        AgentShell.webview_available = staticmethod(lambda: False)
        s = self._shell()
        s.run("auto")
        url = self.opened[0]
        self.assertIn(f"port={s.bridge.port}", url)
        self.assertIn(f"token={s.bridge.token}", url)

    def test_a_webview_that_fails_at_runtime_falls_back_to_the_browser(self):
        # Importing pywebview succeeds on a PC with no WebView2 runtime; the
        # failure only appears when a window is actually created. Catching it at
        # import time is not enough.
        AgentShell.webview_available = staticmethod(lambda: True)
        s = self._shell()
        sys.modules["webview"] = _BrokenWebview()
        try:
            self.assertEqual(s.run("auto"), "browser")
            self.assertEqual(len(self.opened), 1)
        finally:
            sys.modules.pop("webview", None)

    def test_with_no_browser_either_it_still_starts_the_bridge(self):
        # A service account with no default browser must still SYNC. The window
        # is a convenience; the agent's job is not.
        AgentShell.webview_available = staticmethod(lambda: False)
        shell_mod.webbrowser.open = lambda url, new=0: (_ for _ in ()).throw(RuntimeError("no browser"))
        s = self._shell()
        self.assertEqual(s.run("auto"), "none")
        self.assertGreater(s.bridge.port, 0)

    def test_prefer_none_never_opens_anything(self):
        # Headless/service runs must not try to pop a window onto a session
        # that has no desktop.
        s = self._shell()
        self.assertEqual(s.run("none"), "none")
        self.assertEqual(self.opened, [])

    def test_the_bridge_is_listening_before_the_ui_opens(self):
        # The page's first call happens immediately on load; a bridge started
        # afterwards would lose it.
        AgentShell.webview_available = staticmethod(lambda: False)
        s = self._shell()
        s.run("auto")
        import urllib.request
        with urllib.request.urlopen(
                f"http://127.0.0.1:{s.bridge.port}/ping", timeout=5) as resp:
            self.assertEqual(resp.status, 200)


class _BrokenWebview:
    """pywebview on a PC with no WebView2 runtime: imports, then fails."""

    @staticmethod
    def create_window(*a, **k):
        raise RuntimeError("WebView2 runtime is not installed")

    @staticmethod
    def start(*a, **k):
        raise RuntimeError("WebView2 runtime is not installed")


class DefaultPathTests(unittest.TestCase):

    def test_the_served_ui_is_opt_in_not_the_default(self):
        # The decisive fact for "will it run on every PC": the served window is
        # reached only via --ui=web. Every normal launch uses the built-in
        # tkinter window, which needs nothing beyond Python itself.
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(here, "gui_agent.py"), encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn('"--ui=web" in sys.argv', source)
        self.assertNotIn("_run_web_ui()\n    instance", source)


if __name__ == "__main__":
    unittest.main()
