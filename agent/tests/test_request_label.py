"""Tests for naming the Tally request that is in flight.

Tally is a desktop app and it CAN die on a request it dislikes — it puts up
"Internal Error. Contact Tally Solutions. Incorrect Object Type!" and closes.
All the agent sees is the socket dropping mid-response (RemoteDisconnected),
followed by connection-refused for as long as Tally stays down.

Before this, the log said only "Tally Prime is not reachable" — indistinguishable
from the operator simply having closed Tally, and naming NONE of the ~20 reports
a single pull sends. That made the crashing request unfindable without bisecting
by hand. So every transport error now carries the label of the request that was
being served when the connection died.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tally_connector import TallyConnector  # noqa: E402


class RequestLabelTests(unittest.TestCase):

    def test_names_type_id_and_company(self):
        xml = ("<ENVELOPE><HEADER><TYPE>Collection</TYPE>"
               "<ID>TSSRecLedger</ID></HEADER><BODY><DESC><STATICVARIABLES>"
               "<SVCURRENTCOMPANY>SHREE DEVPURI SALES</SVCURRENTCOMPANY>"
               "</STATICVARIABLES></DESC></BODY></ENVELOPE>")
        label = TallyConnector._req_label(xml)
        self.assertIn("Collection", label)
        self.assertIn("TSSRecLedger", label)
        self.assertIn("SHREE DEVPURI SALES", label)

    def test_report_request_without_company(self):
        xml = ("<ENVELOPE><HEADER><TYPE>Data</TYPE>"
               "<ID>Bills Receivable</ID></HEADER></ENVELOPE>")
        label = TallyConnector._req_label(xml)
        self.assertIn("Data", label)
        self.assertIn("Bills Receivable", label)

    def test_unrecognisable_xml_still_yields_a_label(self):
        """A label is diagnostics — it must never be the thing that raises."""
        self.assertTrue(TallyConnector._req_label("<ENVELOPE/>"))
        self.assertTrue(TallyConnector._req_label(""))

    def test_transport_error_message_carries_the_label(self):
        """The operator reads the message, not the debug log."""
        import requests

        from tally_connector import TallyUnavailable

        conn = TallyConnector("http://localhost:9000")

        class _Boom:
            def post(self, *_a, **_kw):
                raise requests.ConnectionError("Remote end closed connection")

        conn._session = _Boom()
        xml = ("<ENVELOPE><HEADER><TYPE>Data</TYPE>"
               "<ID>Bills Receivable</ID></HEADER></ENVELOPE>")
        with self.assertRaises(TallyUnavailable) as ctx:
            conn._send_once(xml)
        self.assertIn("Bills Receivable", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
