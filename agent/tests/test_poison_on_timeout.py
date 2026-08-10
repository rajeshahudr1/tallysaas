"""Tests for quarantining a request that HANGS TallyPrime rather than closing it.

WHAT WAS ALREADY HANDLED. Asking a company for an object type it does not have
("Incorrect Object Type!") normally makes TallyPrime drop the connection
mid-answer. _killed_tally() spots that and the whole F11 family is quarantined
and written to the skip store, so it is asked once and never again.

THE HOLE. That is only ONE of the two ways the same modal presents. When the
error box appears and Tally simply STOPS ANSWERING — the box is modal, so the
XML server behind it serves nobody until somebody clicks OK — the connection is
never closed. We get a read timeout, _killed_tally() says no, and nothing is
quarantined. The identical request goes out on the next cycle, and the next,
which is what "this error keeps coming back" looks like from the customer's
desk.

THE RULE PINNED HERE. A timeout quarantines ONLY the requests marked
feature_must_be_on — the handful of collections whose ABSENCE is known to take
Tally down. Those are tiny requests against small masters; if one of them has
not answered within the timeout, Tally is not busy, it is stuck behind a box.
Every other request (a stock summary over three years genuinely can be slow)
times out exactly as before and is retried, because quarantining a slow report
would silently cost the customer their data.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests  # noqa: E402

import tally_connector as TC  # noqa: E402


class _Session:
    """A session whose post() always raises the exception it was given."""

    def __init__(self, exc):
        self.exc = exc
        self.sent = 0

    def post(self, *_a, **_kw):
        self.sent += 1
        raise self.exc


class PoisonOnTimeoutTests(unittest.TestCase):

    def setUp(self):
        TC._POISON.clear()
        self.addCleanup(TC._POISON.clear)
        # A kill is only blamed on a request when Tally answered the one before
        # it (see test_no_blame_when_tally_already_dead). These cases are all
        # "Tally was fine, then this request took it down", so start from a
        # healthy Tally — the flag is module-level and another test may have
        # left it false.
        TC._LAST_REQUEST_ANSWERED = True
        self.addCleanup(setattr, TC, "_LAST_REQUEST_ANSWERED", True)

    def _connector(self, exc):
        c = TC.TallyConnector(url="http://localhost:9000")
        c._session = _Session(exc)
        c._last_send = 0.0
        return c

    def _collection_xml(self, coll_type):
        return ("<ENVELOPE><HEADER><TYPE>Collection</TYPE>"
                "<ID>TSSM%s</ID></HEADER>"
                "<SVCURRENTCOMPANY>ACME</SVCURRENTCOMPANY></ENVELOPE>"
                % coll_type)

    def test_a_hung_fragile_collection_is_quarantined(self):
        """The reported case: the modal is up, so nothing is ever answered."""
        c = self._connector(requests.Timeout("read timed out"))
        with self.assertRaises(TC.TallyUnavailable):
            c._send_once(self._collection_xml("TDSCategory"))

        self.assertIn("Collection TSSMTDSCategory", TC._POISON)
        # And its siblings, for the same reason a closed connection takes them:
        # one crash should buy the whole answer.
        self.assertIn("Collection TSSMTDSRate", TC._POISON)

    def test_a_slow_ordinary_report_is_never_quarantined(self):
        """A three-year stock summary is slow, not poisonous. Retry it."""
        c = self._connector(requests.Timeout("read timed out"))
        xml = ("<ENVELOPE><HEADER><TYPE>Data</TYPE>"
               "<ID>Stock Summary</ID></HEADER></ENVELOPE>")
        with self.assertRaises(TC.TallyUnavailable):
            c._send_once(xml)
        self.assertEqual(TC._POISON, set(),
                         "quarantining a slow report costs the customer real data")

    def test_a_gated_but_not_fragile_master_is_never_quarantined(self):
        """GSTClassification is gated on ISGSTON but served fine when probed
        against the live EDU Tally, so a timeout on it is an ordinary timeout —
        a slow answer, not an error box. (Payroll is NOT the example here: it
        was assumed harmless until the probe showed each payroll master hanging
        six minutes and then killing Tally, so it is feature_must_be_on now.)"""
        c = self._connector(requests.Timeout("read timed out"))
        with self.assertRaises(TC.TallyUnavailable):
            c._send_once(self._collection_xml("GSTClassification"))
        self.assertEqual(TC._POISON, set())

    def test_a_refused_connection_is_still_just_tally_being_closed(self):
        """Tally not running must never poison anything — it is the normal case."""
        c = self._connector(requests.ConnectionError("actively refused"))
        with self.assertRaises(TC.TallyUnavailable):
            c._send_once(self._collection_xml("TDSCategory"))
        self.assertEqual(TC._POISON, set())


if __name__ == "__main__":
    unittest.main()
