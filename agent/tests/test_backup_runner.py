"""Tests for agent/backup_runner.py — the agent-side data backup.

A backup that quietly missed files is worse than no backup at all, because the
customer relies on it. These tests exist to make it impossible for a run with
an unreadable file to be reported as anything but 'partial', and to make sure
an old copy is never lost before the new one is fully written.

Run: python -m pytest agent/tests/test_backup_runner.py -q
     (or: python -m unittest discover -s agent/tests)
"""

import datetime
import os
import stat
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import backup_runner as br  # noqa: E402


class _Log:
    """A logger stub — record what would be logged, never raise, never print."""

    def __init__(self):
        self.lines = []

    def _rec(self, level, msg, *args):
        try:
            self.lines.append((level, msg % args if args else msg))
        except Exception:
            self.lines.append((level, msg))

    def debug(self, msg, *a): self._rec("debug", msg, *a)
    def info(self, msg, *a): self._rec("info", msg, *a)
    def warning(self, msg, *a): self._rec("warning", msg, *a)
    def error(self, msg, *a): self._rec("error", msg, *a)


def _make_data_dir(tmp_path, files):
    """Create tmp_path/data with the given {relpath: content} files."""
    data = os.path.join(tmp_path, "data")
    os.makedirs(data, exist_ok=True)
    for rel, content in files.items():
        p = os.path.join(data, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as fh:
            fh.write(content.encode() if isinstance(content, str) else content)
    return data


class TestRunBackup(unittest.TestCase):
    def test_a_locked_file_makes_the_run_partial(self):
        tmp_path = _tmp()
        data_path = _make_data_dir(tmp_path, {"a.900": "hello", "locked.900": "secret"})
        dest = os.path.join(tmp_path, "dest")
        locked_path = os.path.join(data_path, "locked.900")

        # shutil.copy2 can take a native fastcopy path on Windows that bypasses
        # the builtin open() entirely, so a locked/in-use Tally file is
        # simulated at the copy layer itself — the same failure mode a real
        # PermissionError from a held-open .900 file would produce.
        real_copy2 = br.shutil.copy2

        def fake_copy2(src, dst, *a, **kw):
            if os.path.abspath(src) == os.path.abspath(locked_path):
                raise PermissionError("file is in use by another process")
            return real_copy2(src, dst, *a, **kw)

        br.shutil.copy2 = fake_copy2
        try:
            result = br.run_backup(data_path, dest, 7, _Log())
        finally:
            br.shutil.copy2 = real_copy2

        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["files_copied"], 1)
        self.assertEqual(result["files_skipped"], 1)

    def test_skipped_files_are_named_not_just_counted(self):
        tmp_path = _tmp()
        data_path = _make_data_dir(tmp_path, {"a.900": "hello", "sub/locked.900": "secret"})
        dest = os.path.join(tmp_path, "dest")
        locked_path = os.path.join(data_path, "sub", "locked.900")

        real_copy2 = br.shutil.copy2

        def fake_copy2(src, dst, *a, **kw):
            if os.path.abspath(src) == os.path.abspath(locked_path):
                raise OSError("locked")
            return real_copy2(src, dst, *a, **kw)

        br.shutil.copy2 = fake_copy2
        try:
            result = br.run_backup(data_path, dest, 7, _Log())
        finally:
            br.shutil.copy2 = real_copy2

        self.assertEqual(result["status"], "partial")
        self.assertEqual(len(result["skipped"]), 1)
        self.assertIn("locked.900", result["skipped"][0])

    def test_a_clean_copy_reports_success_with_real_counts(self):
        tmp_path = _tmp()
        data_path = _make_data_dir(tmp_path, {"a.900": "hello", "b/c.900": "world!!"})
        dest = os.path.join(tmp_path, "dest")

        result = br.run_backup(data_path, dest, 7, _Log())

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["files_copied"], 2)
        self.assertEqual(result["files_skipped"], 0)
        self.assertEqual(result["skipped"], [])
        self.assertEqual(result["bytes_copied"], len(b"hello") + len(b"world!!"))
        self.assertTrue(os.path.isdir(result["destination"]))
        self.assertTrue(os.path.isfile(os.path.join(result["destination"], "a.900")))
        self.assertTrue(os.path.isfile(os.path.join(result["destination"], "b", "c.900")))

    def test_old_copies_are_removed_only_after_the_new_one_is_written(self):
        tmp_path = _tmp()
        data_path = _make_data_dir(tmp_path, {"a.900": "hello", "locked.900": "x"})
        dest = os.path.join(tmp_path, "dest")
        os.makedirs(dest)
        old1 = os.path.join(dest, "tallysaas-backup-20260101-000000")
        old2 = os.path.join(dest, "tallysaas-backup-20260102-000000")
        os.makedirs(old1)
        os.makedirs(old2)

        locked_path = os.path.join(data_path, "locked.900")
        real_copy2 = br.shutil.copy2

        def fake_copy2(src, dst, *a, **kw):
            if os.path.abspath(src) == os.path.abspath(locked_path):
                raise PermissionError("locked")
            return real_copy2(src, dst, *a, **kw)

        br.shutil.copy2 = fake_copy2
        try:
            result = br.run_backup(data_path, dest, 1, _Log())
        finally:
            br.shutil.copy2 = real_copy2

        # keep_copies=1 with the fresh one now written makes 3 total -> 2 removed.
        self.assertTrue(os.path.isdir(result["destination"]))
        self.assertFalse(os.path.isdir(old1))
        self.assertFalse(os.path.isdir(old2))

    def test_copies_to_delete_matches_the_cloud_rule(self):
        existing = ["a", "b", "c", "d"]
        self.assertEqual(br.copies_to_delete(existing, 2), ["a", "b"])
        self.assertEqual(br.copies_to_delete(existing, 10), [])
        self.assertEqual(br.copies_to_delete(existing, 0), [])
        self.assertEqual(br.copies_to_delete(existing, -1), [])
        self.assertEqual(br.copies_to_delete([], 2), [])

    def test_a_missing_or_unwritable_destination_fails_cleanly(self):
        tmp_path = _tmp()
        data_path = _make_data_dir(tmp_path, {"a.900": "hello"})
        # Destination is a FILE, not a directory -> cannot become a backup root.
        dest = os.path.join(tmp_path, "not_a_dir")
        with open(dest, "w") as fh:
            fh.write("x")

        result = br.run_backup(data_path, dest, 7, _Log())

        self.assertEqual(result["status"], "failed")
        self.assertTrue(result["error"])
        self.assertEqual(result["files_copied"], 0)

    def test_a_missing_data_path_fails_cleanly(self):
        tmp_path = _tmp()
        dest = os.path.join(tmp_path, "dest")
        result = br.run_backup(os.path.join(tmp_path, "no-such-data"), dest, 7, _Log())
        self.assertEqual(result["status"], "failed")
        self.assertTrue(result["error"])


class TestDueNow(unittest.TestCase):
    def test_disabled_is_never_due(self):
        settings = {"enabled": False, "frequency": "daily", "run_at": "02:00:00"}
        now = datetime.datetime(2026, 8, 6, 3, 0, 0)
        self.assertFalse(br.due_now(settings, None, now))

    def test_first_run_is_due_once_past_scheduled_time(self):
        settings = {"enabled": True, "frequency": "daily", "run_at": "02:00:00"}
        before = datetime.datetime(2026, 8, 6, 1, 0, 0)
        after = datetime.datetime(2026, 8, 6, 3, 0, 0)
        self.assertFalse(br.due_now(settings, None, before))
        self.assertTrue(br.due_now(settings, None, after))

    def test_daily_is_due_once_per_day_past_the_scheduled_time(self):
        settings = {"enabled": True, "frequency": "daily", "run_at": "02:00:00"}
        last_run = datetime.datetime(2026, 8, 5, 2, 5, 0)
        same_day_later = datetime.datetime(2026, 8, 5, 10, 0, 0)
        next_day_before_time = datetime.datetime(2026, 8, 6, 1, 0, 0)
        next_day_after_time = datetime.datetime(2026, 8, 6, 2, 30, 0)
        self.assertFalse(br.due_now(settings, last_run, same_day_later))
        self.assertFalse(br.due_now(settings, last_run, next_day_before_time))
        self.assertTrue(br.due_now(settings, last_run, next_day_after_time))

    def test_weekly_waits_a_full_week(self):
        settings = {"enabled": True, "frequency": "weekly", "run_at": "02:00:00"}
        last_run = datetime.datetime(2026, 8, 1, 2, 5, 0)
        five_days_later = datetime.datetime(2026, 8, 6, 3, 0, 0)
        eight_days_later = datetime.datetime(2026, 8, 9, 3, 0, 0)
        self.assertFalse(br.due_now(settings, last_run, five_days_later))
        self.assertTrue(br.due_now(settings, last_run, eight_days_later))


_tmp_dirs = []


def _tmp():
    import tempfile
    d = tempfile.mkdtemp(prefix="tallysaas-backup-test-")
    _tmp_dirs.append(d)
    return d


def tearDownModule():
    import shutil
    for d in _tmp_dirs:
        shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
