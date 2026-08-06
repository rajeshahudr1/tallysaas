"""Tests for widget lifetime across the setup screens.

The setup flow is TWO screens in ONE window: sign-in, then "Check your email".
Building the second one destroys every child of the root — so every widget the
first screen created (notably its "Continue" button) is gone by the time the
install runs. The install nevertheless finished on the first screen's object,
and its last act was to re-enable that button: a `.configure()` on a destroyed
widget, which Tk answers with `TclError: invalid command name ".!frame...."`.

That turned a SUCCESSFUL install into an "Install failed" dialog — the config
was written and the syncer registered, but the customer was told it broke, and
the error handler then repeated the same dead call.

What is pinned here: re-enabling a button the current screen does not have is a
no-op, never an exception. Kept as a plain unit test on the helper so it needs
no display (CI has no X server / no interactive desktop session).

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import gui_agent  # noqa: E402


class _DeadWidget:
    """Stands in for a destroyed ttk widget: any call raises, like Tk's does."""

    def configure(self, **_kw):
        raise gui_agent.tk.TclError('invalid command name ".!frame.!frame3.!button"')


class _LiveWidget:
    def __init__(self):
        self.state = "disabled"

    def configure(self, **kw):
        if "state" in kw:
            self.state = kw["state"]


class EnableTests(unittest.TestCase):

    def setUp(self):
        # A bare instance: the helper must not depend on any Tk construction.
        self.view = gui_agent.SetupView.__new__(gui_agent.SetupView)

    def test_destroyed_widget_is_a_noop(self):
        """The reported crash: the sign-in button is gone by install time."""
        self.view.install_btn = _DeadWidget()
        self.view._enable("install_btn")          # must not raise

    def test_missing_attribute_is_a_noop(self):
        """A screen that never created the widget at all."""
        self.view._enable("install_btn")          # must not raise

    def test_live_widget_is_still_enabled(self):
        """The no-op must not be achieved by simply doing nothing."""
        self.view.open_btn = _LiveWidget()
        self.view._enable("open_btn")
        self.assertEqual(self.view.open_btn.state, "normal")


if __name__ == "__main__":
    unittest.main()
