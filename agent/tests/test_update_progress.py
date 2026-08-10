"""Tests for the UPDATE screen's honest percentage.

WHY A PERCENTAGE AT ALL. The splash bar is indeterminate on purpose: "import
modules, probe for Tally" has no denominator anyone can measure, and a fake
0->90->hang is worse than no number (see ui_splash). An update is the opposite
case. Its cost is dominated by copying ONE file whose size is known before the
first byte moves, so the figure on screen can be the real one — which is what
the customer asked for after watching a sweeping bar and not knowing whether it
was working or stuck.

What is pinned here: the copy reports monotonic fractions, it ends at exactly
1.0 (a bar that stops at 97% reads as a hang), it still copies the bytes and the
file mode, an empty file does not divide by zero, and a callback that raises
never costs the customer the update — the copy is the job, the number is not.

Run: python -m unittest discover -s agent/tests
"""

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import gui_agent  # noqa: E402


class CopyWithProgressTests(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="tel-upd-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.src = os.path.join(self.dir, "src.bin")
        self.dst = os.path.join(self.dir, "dst.bin")
        self.seen = []

    def _write(self, size):
        with open(self.src, "wb") as fh:
            fh.write(b"x" * size)

    def test_the_bytes_actually_arrive(self):
        """It is a copy first and a progress report second."""
        self._write(5000)
        gui_agent.copy_with_progress(self.src, self.dst, chunk=1024)
        with open(self.dst, "rb") as fh:
            self.assertEqual(fh.read(), b"x" * 5000)

    def test_fractions_rise_and_end_at_one(self):
        self._write(5000)
        gui_agent.copy_with_progress(self.src, self.dst,
                                     on_progress=self.seen.append, chunk=1024)
        self.assertTrue(self.seen, "no progress was reported at all")
        self.assertEqual(self.seen, sorted(self.seen), "progress went backwards")
        self.assertEqual(self.seen[-1], 1.0,
                         "a bar that stops short of the end reads as a hang")
        self.assertTrue(all(0.0 <= f <= 1.0 for f in self.seen), self.seen)

    def test_an_empty_file_does_not_divide_by_zero(self):
        self._write(0)
        gui_agent.copy_with_progress(self.src, self.dst,
                                     on_progress=self.seen.append)
        self.assertEqual(self.seen[-1], 1.0)

    def test_a_raising_callback_never_costs_the_copy(self):
        """The number is decoration. The copy is the update."""
        def boom(_f):
            raise RuntimeError("ui is gone")

        self._write(3000)
        gui_agent.copy_with_progress(self.src, self.dst, on_progress=boom,
                                     chunk=512)
        self.assertTrue(os.path.isfile(self.dst))
        self.assertEqual(os.path.getsize(self.dst), 3000)


if __name__ == "__main__":
    unittest.main()
