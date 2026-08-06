"""Tests for running PUBLISHED reports the agent has no parser for.

WHY THIS EXISTS
---------------
Adding a Tally report used to mean a new exe: a request builder, a parser, a
release, and every customer downloading it. The envelope mechanism was built to
end that — the server publishes the XML, the agent runs it — but only half
landed. `_published_envelope` was consulted ONLY for the seven reports the agent
already asked for by name, so an envelope for anything else was never run.
`cash_flow`, `ratio_analysis` and `godown_summary` sat published and unused, and
nobody noticed because a report that is never fetched looks exactly like a report
with no data.

`extra_reports()` is the missing half: sweep the published set, run what we do
not already handle, and hand the RAW XML to the cloud, where a parser is a
server-side change.

The properties pinned here are the ones that make it safe to leave running on
every customer's machine:

  * IT MUST NOT DOUBLE-PULL. An envelope named for a report the agent already
    parses is an OVERRIDE of that report's XML (test_envelope_first.py). Running
    it here as well would fetch it twice a cycle and store the same report both
    parsed and raw.

  * IT MUST NOT SWEEP UP NON-REPORTS. `license_info` and anything published
    later for its own call site must not land in the report table.

  * ONE BAD ENVELOPE MUST NOT COST THE REST — nor the sync. A report that throws,
    times out or comes back empty is skipped; only Tally going away propagates,
    because then nothing else will work either.

Run: python -m unittest discover -s agent/tests
"""

import logging
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import envelope_store  # noqa: E402
from tally_connector import TallyConnector, TallyUnavailable  # noqa: E402


def _env(report_id):
    return ("<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>"
            "<ID>" + report_id + "</ID></HEADER><BODY><DESC><STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
            "</STATICVARIABLES></DESC></BODY></ENVELOPE>")


class FakeStore:
    """EnvelopeStore stand-in. `names_raises` / `xml_raises` model a store that
    cannot answer at all, or only for one envelope."""

    def __init__(self, mapping=None, names_raises=False, xml_raises=()):
        self.mapping = mapping or {}
        self.names_raises = names_raises
        self.xml_raises = set(xml_raises)

    def names(self):
        if self.names_raises:
            raise envelope_store.EnvelopeError("no verified envelopes available")
        return sorted(self.mapping)

    def xml(self, name):
        if name in self.xml_raises:
            raise envelope_store.EnvelopeError(f"envelope {name!r} can modify Tally")
        if name not in self.mapping:
            raise envelope_store.EnvelopeError(f"unknown envelope {name!r}")
        return self.mapping[name]


class Conn(TallyConnector):
    """Captures requests instead of sending them. `answers` maps a substring of
    the outgoing XML to the reply; `boom` raises for that substring."""

    def __init__(self, envelopes=None, answers=None, boom=None):
        super().__init__("http://localhost:9000", logging.getLogger("test"),
                         envelopes=envelopes)
        self.sent = []
        self.answers = answers or {}
        self.boom = boom or {}

    def send(self, xml, timeout=None):
        self.sent.append(xml)
        for needle, exc in self.boom.items():
            if needle in xml:
                raise exc
        for needle, reply in self.answers.items():
            if needle in xml:
                return reply
        return "<ENVELOPE><DATA/></ENVELOPE>"


class ExtraReportsTests(unittest.TestCase):

    # ── the point of the change ──────────────────────────────────────────
    def test_a_published_unknown_report_is_run_and_returned_raw(self):
        store = FakeStore({"report:cash_flow": _env("Cash Flow")})
        c = Conn(store, answers={"Cash Flow": "<ENVELOPE><CASHFLOW/></ENVELOPE>"})

        out = c.extra_reports(company="ACME")

        self.assertEqual(list(out), ["cash_flow"])
        self.assertEqual(out["cash_flow"]["raw"], "<ENVELOPE><CASHFLOW/></ENVELOPE>")
        self.assertEqual(out["cash_flow"]["label"], "Cash Flow")
        self.assertIn("<ID>Cash Flow</ID>", c.sent[0])

    def test_company_and_period_are_injected(self):
        """The server cannot know the company or the year; the agent must add
        them or Tally answers for whatever it happens to have open."""
        store = FakeStore({"report:ratio_analysis": _env("Ratio Analysis")})
        c = Conn(store)

        c.extra_reports(company="ACME LTD", from_date="20260401", to_date="20270331")

        sent = c.sent[0]
        self.assertIn("<SVCURRENTCOMPANY>ACME LTD</SVCURRENTCOMPANY>", sent)
        self.assertIn("<SVFROMDATE>20260401</SVFROMDATE>", sent)
        self.assertIn("<SVTODATE>20270331</SVTODATE>", sent)

    def test_several_reports_all_run(self):
        store = FakeStore({
            "report:cash_flow": _env("Cash Flow"),
            "report:ratio_analysis": _env("Ratio Analysis"),
            "report:godown_summary": _env("Godown Summary"),
        })
        c = Conn(store)
        out = c.extra_reports(company="ACME")
        self.assertEqual(sorted(out), ["cash_flow", "godown_summary", "ratio_analysis"])
        self.assertEqual(len(c.sent), 3)

    # ── must not double-pull ─────────────────────────────────────────────
    def test_builtin_reports_are_skipped(self):
        """These are overrides handled by _report_xml, not extras."""
        store = FakeStore({
            "report:balance_sheet": _env("Balance Sheet"),
            "report:profit_loss": _env("Profit and Loss"),
            "report:trial_balance": _env("Trial Balance"),
            "report:sales_register": _env("Sales Register"),
            "report:purchase_register": _env("Purchase Register"),
            "report:stock_summary": _env("Stock Summary"),
            "report:group_summary": _env("Group Summary"),
        })
        c = Conn(store)
        self.assertEqual(c.extra_reports(company="ACME"), {})
        self.assertEqual(c.sent, [])

    def test_builtin_and_extra_together_runs_only_the_extra(self):
        store = FakeStore({
            "report:balance_sheet": _env("Balance Sheet"),
            "report:cash_flow": _env("Cash Flow"),
        })
        c = Conn(store)
        out = c.extra_reports(company="ACME")
        self.assertEqual(list(out), ["cash_flow"])
        self.assertEqual(len(c.sent), 1)

    def test_every_builtin_slug_matches_the_reports_actually_parsed(self):
        """If financial_reports() gains a report, the skip list must gain its
        slug — otherwise it is pulled twice, parsed AND raw, forever."""
        for slug in TallyConnector.BUILTIN_REPORT_SLUGS:
            self.assertEqual(TallyConnector.envelope_key(slug), "report:" + slug)

    # ── must not sweep up non-reports ────────────────────────────────────
    def test_non_report_envelopes_are_ignored(self):
        store = FakeStore({
            "license_info": _env("LicenseInfo"),
            "report:cash_flow": _env("Cash Flow"),
        })
        c = Conn(store)
        self.assertEqual(list(c.extra_reports(company="ACME")), ["cash_flow"])

    def test_bare_report_prefix_is_ignored(self):
        store = FakeStore({"report:": _env("Nothing")})
        c = Conn(store)
        self.assertEqual(c.extra_reports(company="ACME"), {})
        self.assertEqual(c.sent, [])

    # ── one bad envelope must not cost the rest ──────────────────────────
    def test_a_refused_envelope_is_skipped_and_the_others_run(self):
        store = FakeStore(
            {"report:cash_flow": _env("Cash Flow"),
             "report:ratio_analysis": _env("Ratio Analysis")},
            xml_raises=["report:cash_flow"])
        c = Conn(store)
        out = c.extra_reports(company="ACME")
        self.assertEqual(list(out), ["ratio_analysis"])

    def test_a_failing_report_is_skipped_and_the_others_run(self):
        store = FakeStore({"report:cash_flow": _env("Cash Flow"),
                           "report:ratio_analysis": _env("Ratio Analysis")})
        c = Conn(store, boom={"Cash Flow": RuntimeError("Tally said no")})
        out = c.extra_reports(company="ACME")
        self.assertEqual(list(out), ["ratio_analysis"])

    def test_empty_replies_are_not_stored(self):
        """An empty report must leave no row, not an empty one that reads as
        'we have this report and it says nothing'."""
        for reply in ("", "   ", "\n"):
            store = FakeStore({"report:cash_flow": _env("Cash Flow")})
            c = Conn(store, answers={"Cash Flow": reply})
            self.assertEqual(c.extra_reports(company="ACME"), {})

    def test_tally_unavailable_propagates(self):
        """Everything else degrades; Tally being gone must stop the cycle."""
        store = FakeStore({"report:cash_flow": _env("Cash Flow")})
        c = Conn(store, boom={"Cash Flow": TallyUnavailable("connection refused")})
        with self.assertRaises(TallyUnavailable):
            c.extra_reports(company="ACME")

    # ── no store / broken store ──────────────────────────────────────────
    def test_no_store_returns_nothing(self):
        c = Conn(None)
        self.assertEqual(c.extra_reports(company="ACME"), {})
        self.assertEqual(c.sent, [])

    def test_store_that_cannot_list_returns_nothing(self):
        c = Conn(FakeStore(names_raises=True))
        self.assertEqual(c.extra_reports(company="ACME"), {})
        self.assertEqual(c.sent, [])

    def test_connector_built_without___init___does_not_raise(self):
        """Same rule as the rest of this file's siblings: a double that skips
        super().__init__ has no `envelopes` attribute at all."""
        class Bare(TallyConnector):
            def __init__(self):
                self.log = logging.getLogger("test")
        self.assertEqual(Bare().extra_reports(company="ACME"), {})


class PublishedSetTests(unittest.TestCase):
    """The shipped config must follow the naming the agent looks up — the two
    were written apart and did not match, which is why nothing ever ran."""

    def setUp(self):
        import json
        here = os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))))
        with open(os.path.join(here, "api", "config", "tallyEnvelopes.json"),
                  encoding="utf-8") as fh:
            self.doc = json.load(fh)
        self.envelopes = self.doc.get("envelopes") or {}

    def test_the_set_is_not_empty(self):
        self.assertTrue(self.envelopes)

    def test_report_envelopes_use_the_report_prefix(self):
        """A bare name is looked up as 'report:<name>' and never found — which
        is exactly the bug this convention exists to prevent."""
        for name in self.envelopes:
            if name == "license_info":
                continue
            self.assertTrue(name.startswith("report:"),
                            f"{name!r} must be published as 'report:<slug>'")

    def test_slugs_are_plain(self):
        for name in self.envelopes:
            if not name.startswith("report:"):
                continue
            slug = name[len("report:"):]
            self.assertRegex(slug, r"^[a-z0-9_]+$")

    def test_every_published_report_is_read_only(self):
        for name, definition in self.envelopes.items():
            self.assertTrue(envelope_store.is_read_only(definition.get("xml") or ""),
                            f"{name!r} can modify Tally and must not be published")


if __name__ == "__main__":
    unittest.main()
