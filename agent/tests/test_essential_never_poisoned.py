"""Tests that a Tally crash can never permanently disable the agent's lifeline.

THE BUG THIS PINS, found on a live machine. Quarantining exists because some
requests genuinely kill TallyPrime ("Incorrect Object Type!"), and re-sending
them kills it again after every restart. The evidence used is that Tally dropped
the connection while serving the request.

That evidence is not proof. When Tally dies, EVERY request in flight sees the
same dropped connection — including requests that had nothing to do with it. On
the machine this was found on, an unrelated crash landed while the agent was
asking "which companies are open", and this went into the skip store:

    [ "Collection List of Companies", ... ]

That is the first question every cycle asks. Skipped, the agent finds no
company, syncs nothing, and — because the store is written to disk — does so
forever, on every restart, with no error anywhere. Sync was dead permanently and
silently, and the only cure was deleting a file nobody knows about.

THE RULE. A handful of requests are the agent's lifeline: without them there is
no sync at all, so "skip it from now on" can never be the right answer for them.
If they really are broken, failing loudly every cycle is what we want. Everything
else keeps the existing behaviour.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests  # noqa: E402

import tally_connector as TC  # noqa: E402


class _Session:
    def __init__(self, exc):
        self.exc = exc

    def post(self, *_a, **_kw):
        raise self.exc


DROPPED = requests.ConnectionError(
    "('Connection aborted.', RemoteDisconnected('Remote end closed connection "
    "without response'))")


class EssentialRequestTests(unittest.TestCase):

    def setUp(self):
        TC._POISON.clear()
        self.addCleanup(TC._POISON.clear)
        # These cases are all "Tally was serving, then this request took it
        # down". A kill is only blamed on a request when the one before it was
        # answered (see test_no_blame_when_tally_already_dead), and the flag
        # starts false for a fresh process — so say Tally was alive.
        TC._LAST_REQUEST_ANSWERED = True
        self.addCleanup(setattr, TC, "_LAST_REQUEST_ANSWERED", False)

    def _connector(self, exc=DROPPED):
        c = TC.TallyConnector(url="http://localhost:9000")
        c._session = _Session(exc)
        c._last_send = 0.0
        return c

    def _collection(self, name):
        return ("<ENVELOPE><HEADER><TYPE>Collection</TYPE><ID>%s</ID></HEADER>"
                "<SVCURRENTCOMPANY>ACME</SVCURRENTCOMPANY></ENVELOPE>" % name)

    def test_list_of_companies_survives_a_crash_it_did_not_cause(self):
        """The exact live failure: the lifeline must never be quarantined."""
        c = self._connector()
        with self.assertRaises(TC.TallyUnavailable):
            c._send_once(self._collection("List of Companies"))
        self.assertEqual(TC._POISON, set(),
                         "quarantining this kills sync permanently and silently")

    def test_it_is_still_sent_even_if_the_store_somehow_names_it(self):
        """Stores written by older builds already carry it. Ignore that."""
        TC._POISON.add("Collection List of Companies")
        c = self._connector()
        # A poisoned label raises TallySkipped WITHOUT sending; an essential one
        # must reach the transport, so the transport error is what we see.
        with self.assertRaises(TC.TallyUnavailable):
            c._send_once(self._collection("List of Companies"))

    def test_an_ordinary_request_is_still_quarantined(self):
        """The protection is narrow: it must not disarm the whole mechanism."""
        c = self._connector()
        with self.assertRaises(TC.TallyUnavailable):
            c._send_once(self._collection("TSSMTDSCategory"))
        self.assertIn("Collection TSSMTDSCategory", TC._POISON)


class PayrollGateTests(unittest.TestCase):
    """Payroll masters kill Tally when the objects are absent, exactly like TDS.

    Probed against a live TallyPrime EDU: EmployeeGroup, Employee and PayHead
    each hung for six minutes and then took Tally down. They were gated on
    ISPAYROLLON but NOT marked feature_must_be_on, so an unreported flag meant
    "send it anyway" — the same reasoning that made TDS crash every cycle before
    it was marked.
    """

    def test_payroll_masters_require_the_flag_to_be_explicitly_on(self):
        from tally_schema import BY_KIND

        for kind in ("employee_group", "employee", "attendance_type", "pay_head"):
            spec = BY_KIND[kind]
            self.assertEqual(spec.requires_feature, "ISPAYROLLON", kind)
            self.assertTrue(spec.feature_must_be_on,
                            kind + ": silence must mean no, or it is sent to a "
                                   "company that cannot serve it")


if __name__ == "__main__":
    unittest.main()
