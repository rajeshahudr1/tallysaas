"""Server-published envelopes override the built-in Tally queries.

This is the change that lets a report ship without a new exe, and it is also the
one most able to break every customer at once: if a published envelope ever
replaced the built-in query UNCONDITIONALLY, one bad publish would stop every
agent in the field from syncing.

So the property under test is the fallback, not the override. The built-in query
must still run when there is no store, no envelope for that report, an
unverified set, or a store that raises. The override is one test; the ways it
must decline to override are the rest.

Run: python -m unittest discover -s agent/tests
"""

import logging
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tally_connector import TallyConnector  # noqa: E402
import envelope_store  # noqa: E402

PUBLISHED = ("<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>"
             "<ID>Ratio Analysis</ID></HEADER><BODY><DESC><STATICVARIABLES>"
             "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
             "</STATICVARIABLES></DESC></BODY></ENVELOPE>")


class FakeStore:
    """An EnvelopeStore stand-in. `raises` models a store that cannot answer."""

    def __init__(self, mapping=None, raises=False):
        self.mapping = mapping or {}
        self.raises = raises

    def xml(self, name):
        if self.raises:
            raise envelope_store.EnvelopeError("no verified envelopes available")
        if name not in self.mapping:
            raise envelope_store.EnvelopeError(f"unknown envelope {name!r}")
        return self.mapping[name]


class Conn(TallyConnector):
    """Captures the request instead of sending it."""

    def __init__(self, envelopes=None):
        super().__init__("http://localhost:9000", logging.getLogger("test"),
                         envelopes=envelopes)
        self.sent = []

    def send(self, xml, timeout=None):
        self.sent.append(xml)
        return "<ENVELOPE/>"


class NoAttributeTests(unittest.TestCase):

    def test_a_connector_built_without___init___still_pulls_reports(self):
        # Subclasses and test doubles in this repo build themselves without
        # calling super().__init__, so `self.envelopes` may simply not exist.
        # That must degrade to the built-in query, not raise AttributeError
        # halfway through a report pull.
        class Bare(TallyConnector):
            def __init__(self):
                self.log = logging.getLogger("test")
                self.sent = []

            def send(self, xml, timeout=None):
                self.sent.append(xml)
                return "<ENVELOPE/>"

        c = Bare()
        c._report_xml("Balance Sheet", "ACME")
        self.assertIn("<ID>Balance Sheet</ID>", c.sent[0])


class KeyTests(unittest.TestCase):

    def test_report_names_normalise_to_a_stable_key(self):
        # So the server can publish readable English without the two sides
        # having to agree on punctuation.
        self.assertEqual(TallyConnector.envelope_key("Balance Sheet"), "report:balance_sheet")
        self.assertEqual(TallyConnector.envelope_key("Profit and Loss"), "report:profit_and_loss")
        self.assertEqual(TallyConnector.envelope_key("Ratio Analysis"), "report:ratio_analysis")

    def test_the_key_is_stable_across_spacing_and_case(self):
        self.assertEqual(TallyConnector.envelope_key("  BALANCE   sheet "),
                         TallyConnector.envelope_key("Balance Sheet"))


class FallbackTests(unittest.TestCase):
    """Every way a published envelope must decline to take over."""

    def test_with_no_store_the_built_in_query_runs(self):
        c = Conn()
        c._report_xml("Balance Sheet", "ACME")
        self.assertIn("<ID>Balance Sheet</ID>", c.sent[0])

    def test_with_a_store_but_no_matching_envelope_the_built_in_runs(self):
        c = Conn(FakeStore({"report:something_else": PUBLISHED}))
        c._report_xml("Balance Sheet", "ACME")
        self.assertIn("<ID>Balance Sheet</ID>", c.sent[0])

    def test_a_store_that_raises_does_not_break_the_pull(self):
        # An unverified set, an unreadable cache, an offline first run. None of
        # these may stop a report the agent has always been able to fetch.
        c = Conn(FakeStore(raises=True))
        c._report_xml("Balance Sheet", "ACME")
        self.assertIn("<ID>Balance Sheet</ID>", c.sent[0])

    def test_an_empty_published_envelope_falls_back(self):
        c = Conn(FakeStore({"report:balance_sheet": ""}))
        c._report_xml("Balance Sheet", "ACME")
        self.assertIn("<ID>Balance Sheet</ID>", c.sent[0])


class OverrideTests(unittest.TestCase):

    def test_a_published_envelope_replaces_the_built_in_query(self):
        c = Conn(FakeStore({"report:ratio_analysis": PUBLISHED}))
        c._report_xml("Ratio Analysis", "ACME")
        self.assertIn("<ID>Ratio Analysis</ID>", c.sent[0])

    def test_the_agent_fills_in_the_company_and_period(self):
        # The server publishes the SHAPE of the query; it cannot know which
        # company is open or which financial year is being pulled.
        c = Conn(FakeStore({"report:ratio_analysis": PUBLISHED}))
        c._report_xml("Ratio Analysis", "ACME", "20260401", "20270331")
        sent = c.sent[0]
        self.assertIn("<SVCURRENTCOMPANY>ACME</SVCURRENTCOMPANY>", sent)
        self.assertIn("<SVFROMDATE>20260401</SVFROMDATE>", sent)
        self.assertIn("<SVTODATE>20270331</SVTODATE>", sent)
        # Injected INSIDE the existing block, not appended after it.
        self.assertLess(sent.index("SVCURRENTCOMPANY"), sent.index("</STATICVARIABLES>"))

    def test_an_envelope_that_sets_its_own_company_is_left_alone(self):
        # Publishing a company explicitly is a deliberate choice; overwriting it
        # would silently pull the wrong books.
        pinned = PUBLISHED.replace("</STATICVARIABLES>",
                                   "<SVCURRENTCOMPANY>PINNED</SVCURRENTCOMPANY></STATICVARIABLES>")
        c = Conn(FakeStore({"report:ratio_analysis": pinned}))
        c._report_xml("Ratio Analysis", "ACME")
        self.assertIn("PINNED", c.sent[0])
        self.assertNotIn("ACME", c.sent[0])

    def test_an_envelope_with_no_staticvariables_block_is_sent_as_published(self):
        # Better to send exactly what was published than to guess at a structure
        # we did not write.
        bare = "<ENVELOPE><HEADER><ID>X</ID></HEADER></ENVELOPE>"
        c = Conn(FakeStore({"report:x": bare}))
        c._report_xml("X", "ACME")
        self.assertEqual(c.sent[0], bare)

    def test_the_built_in_query_is_untouched_for_other_reports(self):
        # Publishing one report must not disturb the rest.
        c = Conn(FakeStore({"report:ratio_analysis": PUBLISHED}))
        c._report_xml("Ratio Analysis", "ACME")
        c._report_xml("Trial Balance", "ACME")
        self.assertIn("<ID>Ratio Analysis</ID>", c.sent[0])
        self.assertIn("<ID>Trial Balance</ID>", c.sent[1])


if __name__ == "__main__":
    unittest.main()
