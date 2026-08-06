"""Tests for Tally master IDENTITY parsing (GUID / MASTERID).

These cover the change that makes the cloud a true mirror rather than a
name-keyed approximation: every master now carries Tally's rename-stable GUID
and its company-local MASTERID, which are what let the importer follow a rename
in place and let a reconcile pass detect a delete.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tally_connector import TallyConnector  # noqa: E402


def connector_returning(xml: str) -> TallyConnector:
    """A TallyConnector whose send() replays a canned response (no Tally needed)."""
    tc = TallyConnector("http://localhost:9000")
    tc.send = lambda _xml, timeout=None: xml   # type: ignore[assignment]
    return tc


LEDGER_XML = """<ENVELOPE><BODY><DATA><COLLECTION>
  <LEDGER NAME="Acme Traders">
    <GUID>a1b2c3d4-0000-4444-8888-000000000001-0000012f</GUID>
    <MASTERID>303</MASTERID>
    <ALTERID>9812</ALTERID>
    <PARENT>Sundry Debtors</PARENT>
    <PARTYGSTIN>27AABCU9603R1ZM</PARTYGSTIN>
    <OPENINGBALANCE>-15000.00</OPENINGBALANCE>
    <CLOSINGBALANCE>-22500.50</CLOSINGBALANCE>
    <ADDRESS>12 Ring Road</ADDRESS>
    <ADDRESS>Indore</ADDRESS>
  </LEDGER>
  <LEDGER NAME="No Identity Ledger">
    <PARENT>Sundry Creditors</PARENT>
    <ALTERID>7</ALTERID>
  </LEDGER>
</COLLECTION></DATA></BODY></ENVELOPE>"""


# A stock item whose NESTED lists carry their own GUID/MASTERID. This is the
# trap that motivated _direct_child_text: a descending search returns the batch's
# identity, silently giving two different masters the same GUID.
STOCK_XML = """<ENVELOPE><BODY><DATA><COLLECTION>
  <STOCKITEM NAME="Widget 10mm">
    <GUID>a1b2c3d4-0000-4444-8888-000000000001-000004d2</GUID>
    <MASTERID>1234</MASTERID>
    <ALTERID>5555</ALTERID>
    <BASEUNITS>Nos</BASEUNITS>
    <PARENT>Hardware</PARENT>
    <GSTHSNCODE>73181500</GSTHSNCODE>
    <CLOSINGBALANCE>250 Nos</CLOSINGBALANCE>
    <STANDARDPRICE>187.96/pair</STANDARDPRICE>
    <BATCHALLOCATIONS.LIST>
      <GUID>ffffffff-9999-4444-8888-000000000009-00000063</GUID>
      <MASTERID>99</MASTERID>
      <BATCHNAME>B-01</BATCHNAME>
    </BATCHALLOCATIONS.LIST>
  </STOCKITEM>
</COLLECTION></DATA></BODY></ENVELOPE>"""


GODOWN_XML = """<ENVELOPE><BODY><DATA><COLLECTION>
  <GODOWN NAME="Main Store">
    <GUID>a1b2c3d4-0000-4444-8888-000000000001-0000000a</GUID>
    <MASTERID>10</MASTERID>
    <ALTERID>44</ALTERID>
    <PARENT>Primary</PARENT>
    <ADDRESS>Plot 4, MIDC</ADDRESS>
    <HASNOSPACE>No</HASNOSPACE>
    <ISEXTERNAL>Yes</ISEXTERNAL>
  </GODOWN>
</COLLECTION></DATA></BODY></ENVELOPE>"""


GROUP_XML = """<ENVELOPE><BODY><DATA><COLLECTION>
  <GROUP NAME="Sundry Debtors">
    <GUID>a1b2c3d4-0000-4444-8888-000000000001-00000005</GUID>
    <MASTERID>5</MASTERID>
    <ALTERID>2</ALTERID>
    <PARENT>Current Assets</PARENT>
    <PRIMARYGROUP>Current Assets</PRIMARYGROUP>
    <ISREVENUE>No</ISREVENUE>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
  </GROUP>
</COLLECTION></DATA></BODY></ENVELOPE>"""


# GUID/MASTERID as ATTRIBUTES rather than child tags — some Tally builds do this.
ATTR_LEDGER_XML = """<ENVELOPE><BODY><DATA><COLLECTION>
  <LEDGER NAME="Attr Ledger" GUID="dead-beef-0001" MASTERID="77" ALTERID="88">
    <PARENT>Sundry Debtors</PARENT>
  </LEDGER>
</COLLECTION></DATA></BODY></ENVELOPE>"""


VOUCHER_WITH_GODOWN_XML = """<ENVELOPE><BODY><DATA><COLLECTION>
  <VOUCHER>
    <GUID>a1b2c3d4-0000-4444-8888-000000000001-00002710</GUID>
    <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
    <VOUCHERNUMBER>S-1001</VOUCHERNUMBER>
    <DATE>20260401</DATE>
    <PARTYLEDGERNAME>Acme Traders</PARTYLEDGERNAME>
    <AMOUNT>-11800.00</AMOUNT>
    <ALTERID>9999</ALTERID>
    <LEDGERENTRIES.LIST>
      <LEDGERNAME>Acme Traders</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-11800.00</AMOUNT>
    </LEDGERENTRIES.LIST>
    <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>Widget 10mm</STOCKITEMNAME>
      <BILLEDQTY>10 Nos</BILLEDQTY>
      <RATE>1000.00/Nos</RATE>
      <AMOUNT>10000.00</AMOUNT>
      <BATCHALLOCATIONS.LIST>
        <GODOWNNAME>Main Store</GODOWNNAME>
        <BATCHNAME>Primary Batch</BATCHNAME>
      </BATCHALLOCATIONS.LIST>
    </ALLINVENTORYENTRIES.LIST>
  </VOUCHER>
</COLLECTION></DATA></BODY></ENVELOPE>"""


class TestLedgerIdentity(unittest.TestCase):
    def test_guid_and_master_id_are_captured(self):
        rows = connector_returning(LEDGER_XML).ledger_list()
        acme = next(r for r in rows if r["name"] == "Acme Traders")
        self.assertEqual(acme["guid"], "a1b2c3d4-0000-4444-8888-000000000001-0000012f")
        self.assertEqual(acme["master_id"], 303)
        self.assertEqual(acme["alterid"], 9812)
        self.assertEqual(acme["parent"], "Sundry Debtors")

    def test_missing_identity_is_none_not_a_placeholder(self):
        """A ledger with no GUID must report None so the importer falls back to
        name matching — never a stand-in string, which would collide under the
        unique (company_id, tally_guid) index."""
        rows = connector_returning(LEDGER_XML).ledger_list()
        plain = next(r for r in rows if r["name"] == "No Identity Ledger")
        self.assertIsNone(plain["guid"])
        self.assertEqual(plain["master_id"], 0)


class TestStockItemIdentity(unittest.TestCase):
    def test_nested_list_identity_does_not_leak_into_the_item(self):
        rows = connector_returning(STOCK_XML).stock_summary()
        self.assertEqual(len(rows), 1)
        item = rows[0]
        self.assertEqual(item["guid"], "a1b2c3d4-0000-4444-8888-000000000001-000004d2")
        self.assertEqual(item["master_id"], 1234)
        # The batch's own identity must NOT win.
        self.assertNotEqual(item["guid"], "ffffffff-9999-4444-8888-000000000009-00000063")
        self.assertNotEqual(item["master_id"], 99)


class TestGodownFields(unittest.TestCase):
    def test_godown_now_carries_more_than_a_name(self):
        rows = connector_returning(GODOWN_XML).godown_list()
        g = rows[0]
        self.assertEqual(g["guid"], "a1b2c3d4-0000-4444-8888-000000000001-0000000a")
        self.assertEqual(g["master_id"], 10)
        self.assertEqual(g["parent"], "Primary")
        self.assertEqual(g["address"], "Plot 4, MIDC")
        self.assertFalse(g["has_no_space"])
        self.assertTrue(g["is_external"])


class TestGroupIdentity(unittest.TestCase):
    def test_group_identity(self):
        g = connector_returning(GROUP_XML).group_list()[0]
        self.assertEqual(g["master_id"], 5)
        self.assertEqual(g["guid"], "a1b2c3d4-0000-4444-8888-000000000001-00000005")
        self.assertFalse(g["is_revenue"])
        self.assertTrue(g["is_deemed_positive"])


class TestAttributeForm(unittest.TestCase):
    def test_identity_read_from_attributes(self):
        """Tally exposes GUID/ALTERID as an attribute on some builds and as a
        child tag on others; both forms must parse."""
        row = connector_returning(ATTR_LEDGER_XML).ledger_list()[0]
        self.assertEqual(row["guid"], "dead-beef-0001")
        self.assertEqual(row["master_id"], 77)
        self.assertEqual(row["alterid"], 88)


class TestInventoryGodown(unittest.TestCase):
    def test_godown_is_read_from_the_nested_batch_allocation(self):
        """tally_inventory_entries.godown existed but was never populated, so
        godown-wise stock had nothing to group by."""
        v = connector_returning(VOUCHER_WITH_GODOWN_XML).voucher_list()[0]
        self.assertEqual(len(v["inventory"]), 1)
        self.assertEqual(v["inventory"][0]["godown"], "Main Store")
        self.assertEqual(v["inventory"][0]["item"], "Widget 10mm")
        self.assertEqual(v["inventory"][0]["qty"], 10.0)


if __name__ == "__main__":
    unittest.main()
