"""Tests for how many financial years of reports get pulled.

WHY THIS EXISTS
---------------
``report_years`` was a constant 2. Balance Sheet, P&L, Trial Balance, the sales
and purchase registers, stock summary and group summary were therefore pulled
for "this year and last" for every customer — no matter how much history their
Tally held. A book that opened in 2016 synced 2 of its 10 years.

That failure is invisible, which is what makes it worth pinning. The eight
missing years look exactly like eight years with no transactions: the reports
table simply has no row under those labels, nothing logs a warning, and the
reconciliation only ever compares the years it did fetch. Nobody finds out until
a customer opens FY 2019-20 and sees an empty Balance Sheet for a year they
certainly traded in.

So the default is now derived from the company's own BOOKSFROM. The tests below
pin the derivation AND its defensive edges, because the input is a date string
from Tally and Tally will hand back 1900 dates, blanks and future dates without
apology — and each of those, handled naively, breaks in a different direction:
0 years (sync nothing), a negative count, or hundreds of round trips per cycle.

Run: python -m unittest discover -s agent/tests
"""

import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sync_agent  # noqa: E402
from config import _MAX_REPORT_YEARS  # noqa: E402


class _Cfg:
    def __init__(self, report_years=0):
        self.report_years = report_years


class _Logger:
    def __init__(self):
        self.lines = []

    def debug(self, msg, *a):
        self.lines.append(("debug", msg % a if a else msg))

    def warning(self, msg, *a):
        self.lines.append(("warning", msg % a if a else msg))


def _current_fy() -> int:
    """The FY this test run sits in, so expectations are not frozen to a date."""
    t = datetime.date.today()
    return t.year if t.month >= 4 else t.year - 1


class ReportYearsTests(unittest.TestCase):

    def _years(self, books_from, cfg=None, logger=None):
        return sync_agent._report_years_for(
            cfg or _Cfg(), {"books_from": books_from}, logger)

    # ── the point of the change ──────────────────────────────────────────
    def test_full_history_is_the_default(self):
        """A book opened 9 FYs ago pulls 10 years, not 2."""
        fy = _current_fy()
        self.assertEqual(self._years("%d-04-01" % (fy - 9)), 10)

    def test_single_year_book(self):
        fy = _current_fy()
        self.assertEqual(self._years("%d-04-01" % fy), 1)

    def test_two_year_book_still_gets_two(self):
        fy = _current_fy()
        self.assertEqual(self._years("%d-04-01" % (fy - 1)), 2)

    def test_books_opened_before_april_belong_to_the_previous_fy(self):
        """Jan 2016 is FY 2015-16 — off by one here loses a whole year."""
        fy = _current_fy()
        jan = self._years("%d-01-15" % (fy - 4))      # FY (fy-5)
        apr = self._years("%d-04-01" % (fy - 5))      # FY (fy-5)
        self.assertEqual(jan, apr)
        self.assertEqual(jan, 6)

    def test_march_is_the_previous_fy(self):
        fy = _current_fy()
        self.assertEqual(self._years("%d-03-31" % (fy - 2)), 4)   # FY (fy-3)

    # ── manual pin still wins ────────────────────────────────────────────
    def test_explicit_setting_overrides_the_books(self):
        fy = _current_fy()
        self.assertEqual(self._years("%d-04-01" % (fy - 9), _Cfg(report_years=3)), 3)

    def test_pin_of_one_disables_the_comparative(self):
        fy = _current_fy()
        self.assertEqual(self._years("%d-04-01" % (fy - 9), _Cfg(report_years=1)), 1)

    # ── defensive edges: every one of these used to be a different bug ───
    def test_missing_company_master_falls_back(self):
        self.assertEqual(sync_agent._report_years_for(_Cfg(), None, None), 2)

    def test_empty_books_from_falls_back(self):
        self.assertEqual(self._years(""), 2)
        self.assertEqual(self._years(None), 2)

    def test_unparseable_books_from_falls_back_and_says_so(self):
        log = _Logger()
        self.assertEqual(self._years("01/04/2016", logger=log), 2)
        self.assertTrue(any("unparseable" in m for _lvl, m in log.lines))

    def test_future_books_from_yields_one_year_not_zero_or_negative(self):
        fy = _current_fy()
        self.assertEqual(self._years("%d-04-01" % (fy + 3)), 1)

    def test_absurdly_old_books_from_is_capped(self):
        """Tally hands back 1900 dates; uncapped that is 125 report pulls a cycle."""
        log = _Logger()
        self.assertEqual(self._years("1900-04-01", logger=log), _MAX_REPORT_YEARS)
        self.assertTrue(any(lvl == "warning" for lvl, _m in log.lines))

    def test_cap_is_not_applied_to_a_realistic_book(self):
        fy = _current_fy()
        self.assertLess(self._years("%d-04-01" % (fy - 6)), _MAX_REPORT_YEARS)

    def test_negative_pin_is_treated_as_auto(self):
        """A negative in config.ini is a typo for 0, not a request for -3 years."""
        fy = _current_fy()
        self.assertEqual(self._years("%d-04-01" % (fy - 4), _Cfg(report_years=-3)), 5)

    def test_non_dict_company_master_does_not_raise(self):
        for junk in ("", [], 0, object()):
            self.assertEqual(sync_agent._report_years_for(_Cfg(), junk, None), 2)


class ConfigClampTests(unittest.TestCase):
    """The clamp used to force `max(1, min(v, 5))`, which made 0 mean 1 and
    silently threw away any request for more than five years."""

    def test_zero_survives_the_clamp(self):
        from config import _DEFAULT_REPORT_YEARS
        self.assertEqual(_DEFAULT_REPORT_YEARS, 0,
                         "the default must stay 'auto' — a positive default "
                         "re-caps every customer regardless of their books")

    def test_max_allows_a_long_book(self):
        self.assertGreaterEqual(_MAX_REPORT_YEARS, 10)


if __name__ == "__main__":
    unittest.main()
