"""Tests that the quarantine convicts only requests Tally died ON.

THE BUG THIS PINS. TallyPrime's error box is MODAL. Once one bad request raises
it, the XML server behind it answers nobody, so EVERY later request fails the
same way — and a dead Tally is indistinguishable from a request that just killed
it. The quarantine could not tell the difference and blamed whatever ran next.

Live, on 2026-08-10, that convicted an innocent:

    12:27:00  Tally STOPPED ANSWERING on [Collection TSSMTDSCategory]
    12:28:09  Tally CLOSED THE CONNECTION on [Data Balance Sheet]

The Balance Sheet did nothing wrong; it walked into a corpse 69 seconds later.
It was written to the skip store permanently, and that company's balance sheet
stopped syncing for a fault that was never its own.

THE RULE. A kill counts only when the PREVIOUS request was answered — i.e.
Tally was alive when this one went out. Erring the other way is deliberate: a
real offender that happens to follow another failure is convicted on its next
attempt, costing one more crash we already survive. Blaming an innocent drops
real data forever, silently.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests  # noqa: E402

import tally_connector as TC  # noqa: E402


class _Session:
    """post() replays a scripted list of outcomes, one per call.

    An entry is either an exception (raised) or a response body (returned), so
    one session can act out "Tally answered, then died, then stayed dead".
    """

    def __init__(self, script):
        self.script = list(script)
        self.sent = 0

    def post(self, *_a, **_kw):
        outcome = self.script[min(self.sent, len(self.script) - 1)]
        self.sent += 1
        if isinstance(outcome, Exception):
            raise outcome
        return _Response(outcome)


class _Response:
    status_code = 200

    def __init__(self, text):
        self.text = text
        self.content = text.encode("utf-8")


DEAD = requests.ConnectionError("Remote end closed connection without response")


class BlameOnlyWhenTallyWasAliveTests(unittest.TestCase):

    def setUp(self):
        TC._POISON.clear()
        TC._LAST_REQUEST_ANSWERED = True
        self.addCleanup(TC._POISON.clear)
        self.addCleanup(setattr, TC, "_LAST_REQUEST_ANSWERED", True)

    def _connector(self, script):
        c = TC.TallyConnector(url="http://localhost:9000")
        c._session = _Session(script)
        c._last_send = 0.0
        return c

    def _report_xml(self, name):
        return ("<ENVELOPE><HEADER><TYPE>Data</TYPE>"
                "<ID>%s</ID></HEADER></ENVELOPE>" % name)

    def _send(self, c, xml):
        try:
            c._send_once(xml)
        except Exception:                                  # noqa: BLE001
            pass

    def test_a_request_that_kills_a_LIVE_tally_is_quarantined(self):
        """Unchanged behaviour: Tally answered, then died on this request."""
        c = self._connector(["<ENVELOPE/>", DEAD])
        self._send(c, self._report_xml("Stock Summary"))   # answered
        self._send(c, self._report_xml("Balance Sheet"))   # died on this one
        self.assertIn("Data Balance Sheet", TC._POISON)

    def test_a_request_that_finds_tally_ALREADY_dead_is_not_quarantined(self):
        """The live bug: the offender killed Tally, the next request took the blame."""
        c = self._connector(["<ENVELOPE/>", DEAD, DEAD])
        self._send(c, self._report_xml("Stock Summary"))   # answered
        self._send(c, self._report_xml("Trial Balance"))   # the real offender
        self._send(c, self._report_xml("Balance Sheet"))   # walked into the corpse

        self.assertIn("Data Trial Balance", TC._POISON,
                      "the request Tally actually died on must still be caught")
        self.assertNotIn("Data Balance Sheet", TC._POISON,
                         "a request that never reached a live Tally cannot be the cause")

    def test_tally_answering_again_restores_blame(self):
        """After a restart Tally answers, so the NEXT killer is convicted again."""
        c = self._connector(["<ENVELOPE/>", DEAD, "<ENVELOPE/>", DEAD])
        self._send(c, self._report_xml("Stock Summary"))    # answered
        self._send(c, self._report_xml("Trial Balance"))    # killed it
        self._send(c, self._report_xml("Group Summary"))    # Tally is back
        self._send(c, self._report_xml("Balance Sheet"))    # kills it for real now

        self.assertIn("Data Balance Sheet", TC._POISON)

    def test_tally_never_reachable_blames_nobody(self):
        """Tally simply not running must not quarantine the first report tried.

        This is the START-OF-PROCESS state: the flag defaults to False because a
        fresh process has no evidence Tally is alive, and "Tally is closed" is
        the commonest reason its first request fails.
        """
        TC._LAST_REQUEST_ANSWERED = False                  # nothing has answered
        c = self._connector([DEAD, DEAD])
        self._send(c, self._report_xml("Balance Sheet"))
        self._send(c, self._report_xml("Profit and Loss"))
        self.assertEqual(TC._POISON, set())


if __name__ == "__main__":
    unittest.main()
