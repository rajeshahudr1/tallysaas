"""Tests for the per-voucher-type, diff-driven voucher pull.

Two defects motivated this design and both are pinned here:

  1. A single unfiltered ``TYPE=Voucher`` collection does not reliably return
     Tally's order and inventory-only documents. A real book synced this way
     showed 8 voucher types where the company defines 24 — Sales Orders,
     Delivery Notes and Stock Journals were simply absent, with nothing
     reporting a problem.
  2. A forward-only AlterID watermark can never revisit a window it has passed,
     so a gap (Tally stalled, agent killed mid-cycle, cursor bumped) is
     permanent and silent.

Run: python -m unittest discover -s agent/tests
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tally_connector import TallyConnector  # noqa: E402
from tally_schema import RESERVED_VOUCHER_TYPES  # noqa: E402

IDS_XML = """<ENVELOPE><BODY><DATA><COLLECTION>
  <VOUCHER><GUID>g-1</GUID><ALTERID>55</ALTERID><MASTERID>7</MASTERID>
    <VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME></VOUCHER>
  <VOUCHER><GUID>g-2</GUID><ALTERID>56</ALTERID><MASTERID>8</MASTERID>
    <VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME></VOUCHER>
  <VOUCHER><ALTERID>99</ALTERID></VOUCHER>
</COLLECTION></DATA></BODY></ENVELOPE>"""

FULL_XML = """<ENVELOPE><BODY><DATA><COLLECTION>
  <VOUCHER>
    <GUID>g-1</GUID><ALTERID>55</ALTERID>
    <VOUCHERTYPENAME>Delivery Note</VOUCHERTYPENAME>
    <VOUCHERNUMBER>DN-1</VOUCHERNUMBER><DATE>20260401</DATE>
    <PARTYLEDGERNAME>Acme</PARTYLEDGERNAME><AMOUNT>-5000</AMOUNT>
    <LEDGERENTRIES.LIST><LEDGERNAME>Acme</LEDGERNAME>
      <AMOUNT>-5000</AMOUNT></LEDGERENTRIES.LIST>
    <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Widget</STOCKITEMNAME>
      <BILLEDQTY>5 Nos</BILLEDQTY><RATE>1000/Nos</RATE>
      <AMOUNT>5000</AMOUNT></ALLINVENTORYENTRIES.LIST>
  </VOUCHER>
</COLLECTION></DATA></BODY></ENVELOPE>"""


def recording(response):
    c = TallyConnector("http://localhost:9000")
    c.sent = []
    c.send = lambda xml, timeout=None, retries=None: (c.sent.append(xml), response)[1]
    return c


class TestReservedVoucherTypes(unittest.TestCase):
    def test_covers_orders_inventory_and_payroll_not_just_accounting(self):
        """The accounting six are the easy part; these are what a generic pull
        silently drops."""
        for vt in ('Sales Order', 'Purchase Order', 'Delivery Note', 'Receipt Note',
                   'Stock Journal', 'Physical Stock', 'Rejections In', 'Rejections Out',
                   'Material In', 'Material Out', 'Job Work In Order', 'Job Work Out Order',
                   'Payroll', 'Attendance', 'Memorandum', 'Reversing Journal'):
            self.assertIn(vt, RESERVED_VOUCHER_TYPES, vt)

    def test_no_duplicates(self):
        self.assertEqual(len(RESERVED_VOUCHER_TYPES), len(set(RESERVED_VOUCHER_TYPES)))


class TestVoucherIds(unittest.TestCase):
    def test_returns_identity_only(self):
        c = recording(IDS_XML)
        rows = c.voucher_ids(company="ACME", vtype="Sales Order")
        self.assertEqual([r["guid"] for r in rows], ["g-1", "g-2"])
        self.assertEqual(rows[0]["alterid"], 55)
        self.assertEqual(rows[0]["master_id"], 7)

    def test_a_voucher_without_a_guid_is_skipped(self):
        """Tally emits a stray <VOUCHER>0</VOUCHER> in CMPINFO; treating it as a
        real voucher would make the cloud think a guid-less row went missing."""
        rows = recording(IDS_XML).voucher_ids(company="ACME")
        self.assertTrue(all(r["guid"] for r in rows))
        self.assertEqual(len(rows), 2)

    def test_request_is_small_and_type_filtered(self):
        c = recording(IDS_XML)
        c.voucher_ids(company="ACME", vtype="Sales Order")
        xml = c.sent[-1]
        fetch = re.search(r"<FETCH>([^<]+)</FETCH>", xml).group(1)
        # Identity only — this sweep runs over EVERY voucher in the company.
        self.assertEqual(set(fetch.split(",")),
                         {"GUID", "ALTERID", "MASTERID", "VOUCHERTYPENAME"})
        self.assertIn('$VoucherTypeName = "Sales Order"', xml)
        self.assertNotIn("EWAYBILLDETAILS", xml)

    def test_sweep_is_not_alterid_limited(self):
        """The whole point is to see EVERY voucher, including ones a watermark
        has already passed. A lower bound here would recreate the blind spot."""
        c = recording(IDS_XML)
        c.voucher_ids(company="ACME", vtype="Sales")
        self.assertIn("$AlterID &gt; 0", c.sent[-1])


class TestVouchersByGuid(unittest.TestCase):
    def test_fetches_exactly_the_named_vouchers_in_full(self):
        c = recording(FULL_XML)
        rows = c.vouchers_by_guid(["g-1", "g-2"], company="ACME")
        self.assertIn('$GUID = "g-1"', c.sent[-1])
        self.assertIn('$GUID = "g-2"', c.sent[-1])
        # Full shape, same as the window pull — both paths share one parser.
        v = rows[0]
        self.assertEqual(v["vtype"], "Delivery Note")
        self.assertEqual(v["vno"], "DN-1")
        self.assertEqual(len(v["entries"]), 1)
        self.assertEqual(len(v["inventory"]), 1)

    def test_empty_list_makes_no_request(self):
        c = recording(FULL_XML)
        self.assertEqual(c.vouchers_by_guid([], company="ACME"), [])
        self.assertEqual(len(c.sent), 0)

    def test_guids_are_escaped(self):
        """A guid is echoed into a TDL formula, so a quote in it must not be able
        to terminate the string and change the filter."""
        c = recording(FULL_XML)
        c.vouchers_by_guid(['a"b'], company="ACME")
        self.assertNotIn('"a"b"', c.sent[-1])
        self.assertIn("&quot;", c.sent[-1])


class TestVoucherTypeNames(unittest.TestCase):
    def test_falls_back_to_reserved_types_when_the_master_is_unavailable(self):
        c = TallyConnector("http://localhost:9000")

        def boom(*a, **k):
            raise RuntimeError("collection unknown on this build")

        c.fetch_master = boom
        self.assertEqual(c.voucher_type_names(company="ACME"), list(RESERVED_VOUCHER_TYPES))

    def test_prefers_the_companys_own_types(self):
        """Custom types ("RETAIL CASH SALES") only exist in the company's master,
        and they are what most vouchers actually carry."""
        c = TallyConnector("http://localhost:9000")
        c.fetch_master = lambda *a, **k: [{"name": "RETAIL CASH SALES"}, {"name": "Sales"}]
        self.assertEqual(c.voucher_type_names(company="ACME"),
                         ["RETAIL CASH SALES", "Sales"])


class TestVoucherListTypeFilter(unittest.TestCase):
    def test_window_pull_can_also_be_type_scoped(self):
        c = recording(FULL_XML)
        c.voucher_list(company="ACME", after_alterid=100, vtype="Stock Journal")
        self.assertIn('$VoucherTypeName = "Stock Journal"', c.sent[-1])
        self.assertIn("$AlterID &gt; 100", c.sent[-1])


if __name__ == "__main__":
    unittest.main()
