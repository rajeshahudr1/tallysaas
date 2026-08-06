"""Tests for per-financial-year reports and Tally's own bill-wise outstanding.

Every parser here is pinned against a REAL Tally export kept in tests/fixtures,
not a hand-written sample. That distinction is the point: the first version of
the outstanding parser was written from the usual report shape and was wrong in
four separate ways at once (BILLCL not BILLCLAMT, dates as 'd-Mmm-yy' not
YYYYMMDD, BILLDUE not BILLDUEDATE, and no party name in the payload at all). It
produced zero rows and zero amounts — which reads exactly like "this company has
nothing outstanding".

The same class of defect was already live in _parse_pl: its regex required
DSPDISPNAME to be immediately followed by </DSPACCNAME> and both amount tags to
be present together. Real exports put GUID/ISGROUP in between and carry only ONE
of the two amounts, so it matched nothing and the P&L mirrored as empty with no
error raised anywhere.

Run: python -m unittest discover -s agent/tests
"""

import logging
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tally_connector import TallyConnector  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8-sig") as fh:
        return fh.read()


def parser():
    """A connector with no transport — parsers only."""
    c = TallyConnector.__new__(TallyConnector)
    c.log = logging.getLogger("test")
    return c


class _FakeConn(TallyConnector):
    """Records the request XML and replays a canned reply."""

    def __init__(self, reply=""):
        self.sent = []
        self._reply = reply
        self.log = logging.getLogger("test")

    def send(self, xml, timeout=None):      # noqa: D102 - transport only
        self.sent.append(xml)
        return self._reply


# ── Financial years ──────────────────────────────────────────────────────
class FinancialYearsTests(unittest.TestCase):

    def test_window_is_the_indian_fy_not_the_calendar_year(self):
        for fy in TallyConnector.financial_years(2):
            self.assertRegex(fy["label"], r"^\d{4}-\d{2}$")
            self.assertTrue(fy["from_date"].endswith("0401"), fy)
            self.assertTrue(fy["to_date"].endswith("0331"), fy)

    def test_years_are_newest_first_and_contiguous(self):
        years = TallyConnector.financial_years(3)
        starts = [int(fy["from_date"][:4]) for fy in years]
        self.assertEqual(starts, sorted(starts, reverse=True))
        self.assertEqual([starts[0] - starts[1], starts[1] - starts[2]], [1, 1])

    def test_count_is_clamped_to_at_least_one(self):
        self.assertEqual(len(TallyConnector.financial_years(0)), 1)
        self.assertEqual(len(TallyConnector.financial_years(-5)), 1)


# ── Report requests carry the period ─────────────────────────────────────
class ReportPeriodTests(unittest.TestCase):

    def test_dates_are_sent_as_static_variables(self):
        c = _FakeConn()
        c._report_xml("Balance Sheet", "ACME", "20260401", "20270331")
        xml = c.sent[0]
        self.assertIn("<SVFROMDATE>20260401</SVFROMDATE>", xml)
        self.assertIn("<SVTODATE>20270331</SVTODATE>", xml)
        self.assertIn("<SVCURRENTCOMPANY>ACME</SVCURRENTCOMPANY>", xml)

    def test_omitting_dates_keeps_the_old_undated_request(self):
        # The undated pull is still what the existing screens read.
        c = _FakeConn()
        c._report_xml("Trial Balance", "ACME")
        self.assertNotIn("SVFROMDATE", c.sent[0])
        self.assertNotIn("SVTODATE", c.sent[0])

    def test_company_name_is_escaped(self):
        c = _FakeConn()
        c._report_xml("Balance Sheet", "R&D <Ltd>", "20260401", "20270331")
        self.assertNotIn("<Ltd>", c.sent[0])
        self.assertIn("&amp;", c.sent[0])

    def test_outstanding_request_is_scoped_to_one_ledger(self):
        # Without SVLEDGERNAME Tally answers for whatever ledger is in context,
        # which attributes one party's bills to another.
        c = _FakeConn()
        c._ledger_outstanding_xml("Acme & Co", "ACME", "20260401", "20270331")
        xml = c.sent[0]
        self.assertIn("<ID>Ledger Outstandings</ID>", xml)
        self.assertIn("<SVLEDGERNAME>Acme &amp; Co</SVLEDGERNAME>", xml)
        self.assertIn("<SVFROMDATE>20260401</SVFROMDATE>", xml)


# ── Outstanding, against a real export ───────────────────────────────────
class OutstandingParsingTests(unittest.TestCase):
    """tests/fixtures/outstanding_ledger.xml is one ledger's real export."""

    def setUp(self):
        self.rows = parser()._parse_bills(fixture("outstanding_ledger.xml"),
                                          party="Acme Ltd")

    def test_every_bill_in_the_export_is_returned(self):
        self.assertEqual(len(self.rows), 3)

    def test_amount_comes_from_billcl(self):
        # BILLCL, not BILLCLAMT/DSPCLAMTA — the tag the first version looked for
        # does not exist, so every amount parsed as zero.
        self.assertEqual([r["amount"] for r in self.rows], [18653.0, 1039.0, 881.0])

    def test_opening_is_captured_separately_from_closing(self):
        self.assertEqual(self.rows[0]["opening"], 18653.0)

    def test_report_dates_are_d_mmm_yy_and_normalise_to_iso(self):
        self.assertEqual(self.rows[0]["bill_date"], "2026-06-04")
        self.assertEqual(self.rows[0]["due_date"], "2026-06-04")
        self.assertEqual(self.rows[2]["bill_date"], "2026-07-30")

    def test_bill_reference_is_read(self):
        self.assertEqual(self.rows[0]["bill"], "638/2026-27")

    def test_overdue_days_are_read(self):
        self.assertEqual([r["overdue_days"] for r in self.rows], [300, 275, 244])

    def test_party_comes_from_the_caller_not_the_payload(self):
        # There is no party tag anywhere in the export — the ledger asked for IS
        # the party. A parser that looked for one would return nothing.
        self.assertNotIn("BILLPARTY", fixture("outstanding_ledger.xml"))
        self.assertTrue(all(r["party"] == "Acme Ltd" for r in self.rows))

    def test_side_is_recovered_from_tally_sign_before_the_magnitude(self):
        # Tally stores a debit negative, so these debtor bills are receivable.
        self.assertTrue(all(r["side"] == "receivable" for r in self.rows))
        self.assertTrue(all(r["amount"] > 0 for r in self.rows))

    def test_an_empty_report_yields_no_rows_rather_than_raising(self):
        self.assertEqual(parser()._parse_bills("<ENVELOPE></ENVELOPE>", "X"), [])


class OutstandingAggregateTests(unittest.TestCase):

    def test_a_failing_ledger_does_not_cost_the_others(self):
        class Flaky(_FakeConn):
            def send(self, xml, timeout=None):
                if "Bad" in xml:
                    raise RuntimeError("tally said no")
                return fixture("outstanding_ledger.xml")

        out = Flaky().outstandings("ACME", ledgers=["Good", "Bad", "Also Good"])
        self.assertEqual(out["failed"], ["Bad"])
        self.assertEqual(out["parties"], 2)
        self.assertEqual(len(out["rows"]), 6)

    def test_blank_ledger_names_are_skipped(self):
        c = _FakeConn(fixture("outstanding_ledger.xml"))
        out = c.outstandings("ACME", ledgers=["", "   ", None])
        self.assertEqual(out["rows"], [])
        self.assertEqual(c.sent, [])


class PartyLedgerSelectionTests(unittest.TestCase):

    def test_a_party_nested_under_a_sub_group_is_still_found(self):
        # Matching on the immediate parent would miss "Debtors - North", which
        # is how most real companies organise their parties.
        c = parser()
        c.group_list = lambda company=None: [
            {"name": "Sundry Debtors", "parent": "Current Assets"},
            {"name": "Debtors - North", "parent": "Sundry Debtors"},
            {"name": "Indirect Expenses", "parent": "Primary"},
        ]
        c.ledger_list = lambda company=None: [
            {"name": "Acme", "parent": "Debtors - North"},
            {"name": "Direct Party", "parent": "Sundry Debtors"},
            {"name": "Rent", "parent": "Indirect Expenses"},
        ]
        self.assertEqual(c.party_ledger_names(), ["Acme", "Direct Party"])

    def test_a_circular_group_chain_terminates(self):
        c = parser()
        c.group_list = lambda company=None: [
            {"name": "A", "parent": "B"}, {"name": "B", "parent": "A"},
        ]
        c.ledger_list = lambda company=None: [{"name": "Odd", "parent": "A"}]
        self.assertEqual(c.party_ledger_names(), [])


# ── Reports, against real exports ────────────────────────────────────────
class ProfitLossTests(unittest.TestCase):
    """The regression that motivated the rewrite: this used to return nothing."""

    def setUp(self):
        self.pl = parser()._parse_pl(fixture("profit_loss.xml"))

    def test_a_real_export_is_not_parsed_as_empty(self):
        self.assertTrue(self.pl["income"], "P&L parsed to nothing on real data")
        self.assertTrue(self.pl["expense"])

    def test_main_group_rows_are_split_by_sign(self):
        self.assertEqual([i["name"] for i in self.pl["income"]],
                         ["Sales Accounts", "Indirect Incomes"])
        self.assertEqual([e["name"] for e in self.pl["expense"]],
                         ["Cost of Sales :", "Indirect Expenses"])
        self.assertEqual(self.pl["income"][0]["amount"], 30151900.11)

    def test_sub_rows_are_details_not_totals(self):
        # Counting Opening Stock / Purchases / Closing Stock alongside their
        # parent 'Cost of Sales' would double the expense side.
        names = [d["name"] for d in self.pl["details"]]
        self.assertIn("Opening Stock", names)
        self.assertTrue(all(d["under"] == "Cost of Sales :" for d in self.pl["details"]))
        self.assertTrue(all(d["name"] not in names[:0] for d in self.pl["details"]))
        for d in self.pl["details"]:
            self.assertNotIn(d["name"], [e["name"] for e in self.pl["expense"]])

    def test_the_reported_figures_add_up_to_tally_s_net(self):
        net = (sum(i["amount"] for i in self.pl["income"])
               - sum(e["amount"] for e in self.pl["expense"]))
        self.assertAlmostEqual(net, 2895848.46, places=2)


class GroupSummaryTests(unittest.TestCase):

    def setUp(self):
        self.gs = parser()._parse_group_summary(fixture("group_summary.xml"))

    def test_every_account_row_is_returned(self):
        self.assertEqual(len(self.gs["rows"]), 66)

    def test_groups_and_ledgers_are_distinguished(self):
        first = self.gs["rows"][0]
        self.assertEqual(first["name"], "Capital Account")
        self.assertTrue(first["is_group"])
        self.assertFalse(self.gs["rows"][1]["is_group"])

    def test_the_hierarchy_is_carried_by_guid(self):
        # PGUID is what makes a Balance Sheet line drillable without
        # re-deriving the tree from ledger parent names.
        child = self.gs["rows"][1]
        self.assertEqual(child["parent_guid"], self.gs["rows"][0]["guid"])
        self.assertEqual(self.gs["rows"][0]["parent_guid"], "")

    def test_amounts_are_read_from_dspaccname_only(self):
        # DSPACCINFO restates the same two figures; reading both doubles
        # every balance in the report.
        self.assertEqual(self.gs["rows"][0]["credit"], 11808076.45)
        self.assertEqual(self.gs["rows"][0]["debit"], 0.0)


class TallyDateTests(unittest.TestCase):

    def test_every_shape_tally_emits_is_accepted(self):
        self.assertEqual(TallyConnector._tally_date("20260401"), "2026-04-01")
        self.assertEqual(TallyConnector._tally_date("2026-04-01"), "2026-04-01")
        self.assertEqual(TallyConnector._tally_date("4-Jun-26"), "2026-06-04")
        self.assertEqual(TallyConnector._tally_date("30-Jul-2026"), "2026-07-30")

    def test_anything_else_is_empty_rather_than_a_wrong_date(self):
        self.assertEqual(TallyConnector._tally_date(""), "")
        self.assertEqual(TallyConnector._tally_date("not a date"), "")
        self.assertEqual(TallyConnector._tally_date("4-Xyz-26"), "")


if __name__ == "__main__":
    unittest.main()
