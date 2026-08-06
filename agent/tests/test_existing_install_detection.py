"""Tests for finding an EXISTING install so a downloaded exe updates it.

WHY THIS EXISTS
---------------
The exe chose its screen from where IT was running: next to an activated
config.ini -> Dashboard, anywhere else -> the full Setup wizard. Correct for the
first install and wrong for every one after it. A customer who downloaded a new
build got the wizard — asked for a licence key the machine already held, for an
install that was working — so shipping a release meant walking each customer
through a re-activation they should never have seen.

Now the install records where it went and a later exe looks it up. The lookup is
the risky half, in BOTH directions:

  * TOO EAGER sends a first-time customer into "updating your existing
    installation" for something that is not there. A stale registry value left
    by an uninstall, or an install folder whose exe was deleted, must not count.

  * TOO SHY is the bug we started with: a custom install folder (the registry
    value is the only record of it) falls back to the wizard again.

So a candidate counts only when the exe AND an activated config are both present,
and the running exe never matches itself. Those are the rules pinned here.

Registry access is stubbed — these tests must not read or write the real HKCU,
and must pass on a machine that has no install at all.

Run: python -m unittest discover -s agent/tests
"""

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import gui_agent  # noqa: E402


class _Tmp(unittest.TestCase):
    """Base: a scratch dir plus helpers that build fake install folders."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="lk-install-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        # Neutralise the real registry + the real default folder for every test.
        self._orig_read = gui_agent._read_remembered_install_dir
        self._orig_default = gui_agent.DEFAULT_INSTALL_DIR
        gui_agent._read_remembered_install_dir = lambda: ""
        gui_agent.DEFAULT_INSTALL_DIR = os.path.join(self.tmp, "__no_such_default__")

    def tearDown(self):
        gui_agent._read_remembered_install_dir = self._orig_read
        gui_agent.DEFAULT_INSTALL_DIR = self._orig_default

    # -- builders ---------------------------------------------------------- #
    def _dir(self, name):
        d = os.path.join(self.tmp, name)
        os.makedirs(d, exist_ok=True)
        return d

    def _exe(self, d):
        with open(os.path.join(d, gui_agent.INSTALLED_EXE_NAME), "wb") as fh:
            fh.write(b"MZ")

    def _config(self, d, token="tok-123"):
        with open(os.path.join(d, "config.ini"), "w", encoding="utf-8") as fh:
            fh.write("[state]\nagent_token = %s\n" % token)

    def _full_install(self, name="install"):
        d = self._dir(name)
        self._exe(d)
        self._config(d)
        return d

    def _pretend_activated(self, activated_dirs):
        """Config.load is real INI parsing; stub is_activated on the paths."""
        wanted = {os.path.normcase(os.path.abspath(p)) for p in activated_dirs}
        orig = gui_agent.Config.load

        def _load(path):
            cfg = orig(path)
            cfg._test_dir = os.path.normcase(os.path.abspath(os.path.dirname(path)))
            return cfg
        gui_agent.Config.load = staticmethod(_load)
        self.addCleanup(setattr, gui_agent.Config, "load", orig)

        orig_act = gui_agent.is_activated
        gui_agent.is_activated = lambda cfg: getattr(cfg, "_test_dir", None) in wanted
        self.addCleanup(setattr, gui_agent, "is_activated", orig_act)


class ActivatedInstallTests(_Tmp):

    def test_exe_plus_activated_config_counts(self):
        d = self._full_install()
        self._pretend_activated([d])
        self.assertTrue(gui_agent._is_activated_install(d))

    def test_config_without_exe_does_not_count(self):
        """An uninstall that removed the binary leaves the ini behind."""
        d = self._dir("leftover")
        self._config(d)
        self._pretend_activated([d])
        self.assertFalse(gui_agent._is_activated_install(d))

    def test_exe_without_config_does_not_count(self):
        """A copy someone pasted into a folder is not an install."""
        d = self._dir("copied")
        self._exe(d)
        self._pretend_activated([d])
        self.assertFalse(gui_agent._is_activated_install(d))

    def test_unactivated_config_does_not_count(self):
        d = self._full_install("halfway")
        self._pretend_activated([])           # config present but no token
        self.assertFalse(gui_agent._is_activated_install(d))

    def test_missing_folder_does_not_raise(self):
        self.assertFalse(gui_agent._is_activated_install(
            os.path.join(self.tmp, "nope")))

    def test_empty_input_does_not_raise(self):
        self.assertFalse(gui_agent._is_activated_install(""))
        self.assertFalse(gui_agent._is_activated_install(None))


class FindExistingInstallTests(_Tmp):

    def test_registry_pointer_is_used(self):
        """The custom-folder case: only the registry knows where it went."""
        d = self._full_install("D_Apps_Tally")
        self._pretend_activated([d])
        gui_agent._read_remembered_install_dir = lambda: d
        self.assertEqual(gui_agent.find_existing_install(), os.path.abspath(d))

    def test_default_folder_is_the_fallback(self):
        """An install made before the pointer existed still gets found."""
        d = self._full_install("default")
        self._pretend_activated([d])
        gui_agent.DEFAULT_INSTALL_DIR = d
        self.assertEqual(gui_agent.find_existing_install(), os.path.abspath(d))

    def test_registry_wins_over_the_default(self):
        custom = self._full_install("custom")
        default = self._full_install("default")
        self._pretend_activated([custom, default])
        gui_agent._read_remembered_install_dir = lambda: custom
        gui_agent.DEFAULT_INSTALL_DIR = default
        self.assertEqual(gui_agent.find_existing_install(), os.path.abspath(custom))

    def test_stale_registry_falls_through_to_the_default(self):
        """Uninstalled, but the value survived: must not stop the search."""
        gone = os.path.join(self.tmp, "deleted")
        default = self._full_install("default")
        self._pretend_activated([default])
        gui_agent._read_remembered_install_dir = lambda: gone
        gui_agent.DEFAULT_INSTALL_DIR = default
        self.assertEqual(gui_agent.find_existing_install(), os.path.abspath(default))

    def test_nothing_installed_returns_empty(self):
        """The first-time customer — must reach the wizard, not an update."""
        self._pretend_activated([])
        self.assertEqual(gui_agent.find_existing_install(), "")

    def test_running_exe_does_not_find_itself(self):
        """Without skip_dir the installed exe would 'update' itself from itself."""
        d = self._full_install("install")
        self._pretend_activated([d])
        gui_agent._read_remembered_install_dir = lambda: d
        self.assertEqual(gui_agent.find_existing_install(skip_dir=d), "")

    def test_skip_dir_is_case_and_separator_insensitive(self):
        d = self._full_install("install")
        self._pretend_activated([d])
        gui_agent._read_remembered_install_dir = lambda: d
        weird = d.upper() + os.sep
        self.assertEqual(gui_agent.find_existing_install(skip_dir=weird), "")

    def test_a_different_install_is_still_found_when_skipping(self):
        here = self._full_install("downloaded_copy")
        there = self._full_install("real_install")
        self._pretend_activated([here, there])
        gui_agent._read_remembered_install_dir = lambda: there
        self.assertEqual(gui_agent.find_existing_install(skip_dir=here),
                         os.path.abspath(there))

    def test_registry_read_failure_still_finds_the_default(self):
        """This runs while the startup window is being chosen: a throwing
        registry must degrade to the default probe, never stop the app opening."""
        d = self._full_install("default")
        self._pretend_activated([d])

        def _boom():
            raise OSError("registry unavailable")
        gui_agent._read_remembered_install_dir = _boom
        gui_agent.DEFAULT_INSTALL_DIR = d
        self.assertEqual(gui_agent.find_existing_install(), os.path.abspath(d))

    def test_broken_candidate_never_raises(self):
        """A junk registry value must not take the app down with it."""
        self._pretend_activated([])
        gui_agent._read_remembered_install_dir = lambda: "\x00::not-a-path::"
        self.assertEqual(gui_agent.find_existing_install(), "")

    def test_real_reader_swallows_registry_errors(self):
        """The shipped reader must return "" rather than raise, on any platform."""
        gui_agent._read_remembered_install_dir = self._orig_read
        self.assertIsInstance(gui_agent._read_remembered_install_dir(), str)


class RegistryWriteTests(unittest.TestCase):
    """The writers must be no-ops off Windows, never exceptions.

    THESE MUST NOT TOUCH THE REAL REGISTRY. The first version of this file called
    ``remember_install_dir(tempfile.gettempdir())`` for real, and running the
    suite on a developer's own machine wrote a scratch path into
    HKCU\\Software\\TallyCloudSync — pointing the install-detection at a temp
    folder on the very machine being used to test the agent. A test that changes
    the machine it runs on is worse than no test.

    So winreg is stubbed: what is under test is that the helpers call it
    correctly and swallow failures, not that Windows can write a registry value.
    """

    def _fake_winreg(self, fail=False):
        calls = {"set": [], "deleted": 0}

        class _Key:
            def __enter__(_s):
                return _s

            def __exit__(_s, *_a):
                return False

        class _Winreg:
            HKEY_CURRENT_USER = object()
            KEY_WRITE = 0
            REG_SZ = 1

            def CreateKeyEx(_s, *_a, **_k):
                if fail:
                    raise OSError("access denied")
                return _Key()

            def OpenKey(_s, *_a, **_k):
                if fail:
                    raise OSError("access denied")
                return _Key()

            def SetValueEx(_s, _key, name, _r, _t, value):
                calls["set"].append((name, value))

            def DeleteValue(_s, _key, _name):
                calls["deleted"] += 1

        fake = _Winreg()
        real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) \
            else __builtins__.__import__

        def _imp(name, *a, **k):
            if name == "winreg":
                return fake
            return real_import(name, *a, **k)

        import builtins
        self._orig_import = builtins.__import__
        builtins.__import__ = _imp
        self.addCleanup(setattr, builtins, "__import__", self._orig_import)
        return calls

    def test_remember_writes_the_path(self):
        calls = self._fake_winreg()
        self.assertTrue(gui_agent.remember_install_dir(r"C:\TallyCloudSync"))
        self.assertEqual(len(calls["set"]), 1)
        name, value = calls["set"][0]
        self.assertEqual(name, gui_agent.REG_VALUE_INSTALL_DIR)
        self.assertTrue(value.lower().endswith("tallycloudsync"))

    def test_remember_reports_failure_without_raising(self):
        self._fake_winreg(fail=True)
        self.assertFalse(gui_agent.remember_install_dir(r"C:\TallyCloudSync"))

    def test_forget_deletes_the_value(self):
        calls = self._fake_winreg()
        gui_agent.forget_install_dir()
        self.assertEqual(calls["deleted"], 1)

    def test_forget_does_not_raise_when_it_cannot(self):
        self._fake_winreg(fail=True)
        gui_agent.forget_install_dir()      # not raising IS the test


if __name__ == "__main__":
    unittest.main()
