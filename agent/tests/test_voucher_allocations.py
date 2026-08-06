"""Tests for the voucher CHILD COLLECTIONS (bill / batch / cost / bank / GST).

These allocations used to be parsed past and discarded, which is why the cloud
could report "this party owes 50,000" but never "invoice S-1001 is 90 days
overdue". Each test pins the link between an allocation and its OWNER line —
the part that makes the row useful rather than just present.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tally_connector import TallyConnector  # noqa: E402
from test_master_identity import connector_returning  # noqa: E402


# A sales invoice with bill-wise refs, a batch/godown split, cost centres and
# per-line GST — i.e. what a real GST trading company's voucher looks like.
SALES_XML = """<ENVELOPE><BODY><DATA><COLLECTION>
  <VOUCHER>
    <GUID>cmp-0001-00002710</GUID>
    <MASTERID>10000</MASTERID>
    <ALTERID>9999</ALTERID>
    <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
    <VOUCHERNUMBER>S-1001</VOUCHERNUMBER>
    <DATE>20260401</DATE>
    <EFFECTIVEDATE>20260401</EFFECTIVEDATE>
    <REFERENCE>PO-77</REFERENCE>
    <NARRATION>Being goods sold on credit</NARRATION>
    <PARTYLEDGERNAME>Acme Traders</PARTYLEDGERNAME>
    <PARTYGSTIN>27AABCU9603R1ZM</PARTYGSTIN>
    <PLACEOFSUPPLY>Maharashtra</PLACEOFSUPPLY>
    <ISINVOICE>Yes</ISINVOICE>
    <AMOUNT>-11800.00</AMOUNT>

    <LEDGERENTRIES.LIST>
      <LEDGERNAME>Acme Traders</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-11800.00</AMOUNT>
      <BILLALLOCATIONS.LIST>
        <NAME>S-1001</NAME>
        <BILLTYPE>New Ref</BILLTYPE>
        <BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>
        <AMOUNT>-11800.00</AMOUNT>
      </BILLALLOCATIONS.LIST>
    </LEDGERENTRIES.LIST>

    <LEDGERENTRIES.LIST>
      <LEDGERNAME>Sales Local</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <AMOUNT>10000.00</AMOUNT>
      <CATEGORYALLOCATIONS.LIST>
        <CATEGORY>Branch</CATEGORY>
        <COSTCENTREALLOCATIONS.LIST>
          <NAME>Indore</NAME>
          <AMOUNT>6000.00</AMOUNT>
        </COSTCENTREALLOCATIONS.LIST>
        <COSTCENTREALLOCATIONS.LIST>
          <NAME>Bhopal</NAME>
          <AMOUNT>4000.00</AMOUNT>
        </COSTCENTREALLOCATIONS.LIST>
      </CATEGORYALLOCATIONS.LIST>
    </LEDGERENTRIES.LIST>

    <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>Widget 10mm</STOCKITEMNAME>
      <GSTHSNCODE>73181500</GSTHSNCODE>
      <BILLEDQTY>10 Nos</BILLEDQTY>
      <RATE>1000.00/Nos</RATE>
      <AMOUNT>10000.00</AMOUNT>
      <BATCHALLOCATIONS.LIST>
        <GODOWNNAME>Main Store</GODOWNNAME>
        <BATCHNAME>B-01</BATCHNAME>
        <BILLEDQTY>6 Nos</BILLEDQTY>
        <ACTUALQTY>6 Nos</ACTUALQTY>
        <AMOUNT>6000.00</AMOUNT>
      </BATCHALLOCATIONS.LIST>
      <BATCHALLOCATIONS.LIST>
        <GODOWNNAME>Overflow</GODOWNNAME>
        <BATCHNAME>B-02</BATCHNAME>
        <BILLEDQTY>4 Nos</BILLEDQTY>
        <ACTUALQTY>4 Nos</ACTUALQTY>
        <AMOUNT>4000.00</AMOUNT>
      </BATCHALLOCATIONS.LIST>
      <RATEDETAILS.LIST>
        <GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD>
        <GSTRATE>9</GSTRATE>
        <GSTRATEVALUE>900.00</GSTRATEVALUE>
      </RATEDETAILS.LIST>
      <RATEDETAILS.LIST>
        <GSTRATEDUTYHEAD>State Tax</GSTRATEDUTYHEAD>
        <GSTRATE>9</GSTRATE>
        <GSTRATEVALUE>900.00</GSTRATEVALUE>
      </RATEDETAILS.LIST>
    </ALLINVENTORYENTRIES.LIST>
  </VOUCHER>
</COLLECTION></DATA></BODY></ENVELOPE>"""


# A receipt SETTLING that invoice — the other half of bill-wise accounting.
RECEIPT_XML = """<ENVELOPE><BODY><DATA><COLLECTION>
  <VOUCHER>
    <GUID>cmp-0001-00002711</GUID>
    <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
    <VOUCHERNUMBER>R-500</VOUCHERNUMBER>
    <DATE>20260415</DATE>
    <PARTYLEDGERNAME>Acme Traders</PARTYLEDGERNAME>
    <AMOUNT>11800.00</AMOUNT>
    <LEDGERENTRIES.LIST>
      <LEDGERNAME>Acme Traders</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <AMOUNT>11800.00</AMOUNT>
      <BILLALLOCATIONS.LIST>
        <NAME>S-1001</NAME>
        <BILLTYPE>Agst Ref</BILLTYPE>
        <AMOUNT>11800.00</AMOUNT>
      </BILLALLOCATIONS.LIST>
    </LEDGERENTRIES.LIST>
    <LEDGERENTRIES.LIST>
      <LEDGERNAME>HDFC Bank</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-11800.00</AMOUNT>
      <BANKALLOCATIONS.LIST>
        <INSTRUMENTNUMBER>004411</INSTRUMENTNUMBER>
        <INSTRUMENTDATE>20260414</INSTRUMENTDATE>
        <TRANSACTIONTYPE>Cheque</TRANSACTIONTYPE>
        <BANKNAME>ICICI Bank</BANKNAME>
        <PAYMENTFAVOURING>Devpuri Sales</PAYMENTFAVOURING>
        <UNIQUEREFERENCENUMBER>UTR-99881</UNIQUEREFERENCENUMBER>
        <STATUS>Reconciled</STATUS>
      </BANKALLOCATIONS.LIST>
    </LEDGERENTRIES.LIST>
  </VOUCHER>
</COLLECTION></DATA></BODY></ENVELOPE>"""


class TestVoucherHeader(unittest.TestCase):
    def setUp(self):
        self.v = connector_returning(SALES_XML).voucher_list()[0]

    def test_header_fields_that_were_never_fetched(self):
        self.assertEqual(self.v["master_id"], 10000)
        self.assertEqual(self.v["reference"], "PO-77")
        self.assertEqual(self.v["narration"], "Being goods sold on credit")
        self.assertEqual(self.v["party_gstin"], "27AABCU9603R1ZM")
        self.assertEqual(self.v["place_of_supply"], "Maharashtra")
        self.assertTrue(self.v["is_invoice"])
        self.assertFalse(self.v["is_cancelled"])


class TestBillAllocations(unittest.TestCase):
    def test_new_ref_is_linked_to_its_party_ledger(self):
        """A bill allocation is only useful if we know WHOSE bill it is — the
        LEDGERNAME lives on the parent entry, not on the allocation."""
        v = connector_returning(SALES_XML).voucher_list()[0]
        self.assertEqual(len(v["bill_allocations"]), 1)
        b = v["bill_allocations"][0]
        self.assertEqual(b["ledger"], "Acme Traders")
        self.assertEqual(b["bill_name"], "S-1001")
        self.assertEqual(b["bill_type"], "New Ref")
        self.assertEqual(b["credit_period_days"], 30)
        self.assertEqual(b["amount"], -11800.0)

    def test_agst_ref_settles_the_named_bill(self):
        v = connector_returning(RECEIPT_XML).voucher_list()[0]
        b = v["bill_allocations"][0]
        self.assertEqual(b["bill_type"], "Agst Ref")
        self.assertEqual(b["bill_name"], "S-1001")
        self.assertEqual(b["ledger"], "Acme Traders")

    def test_credit_period_units_are_normalised_to_days(self):
        c = TallyConnector._credit_days
        self.assertEqual(c("30 Days"), 30)
        self.assertEqual(c("2 Months"), 60)
        self.assertEqual(c("1 Week"), 7)
        self.assertEqual(c("45"), 45)
        self.assertIsNone(c(""))


class TestBatchAllocations(unittest.TestCase):
    def test_each_batch_line_knows_its_item(self):
        v = connector_returning(SALES_XML).voucher_list()[0]
        batches = v["batch_allocations"]
        self.assertEqual(len(batches), 2)
        self.assertTrue(all(b["item"] == "Widget 10mm" for b in batches))
        self.assertEqual({b["godown"] for b in batches}, {"Main Store", "Overflow"})
        self.assertEqual(sum(b["billed_qty"] for b in batches), 10.0)


class TestCostAllocations(unittest.TestCase):
    def test_cost_centres_carry_category_and_ledger(self):
        v = connector_returning(SALES_XML).voucher_list()[0]
        costs = v["cost_allocations"]
        self.assertEqual(len(costs), 2)
        self.assertTrue(all(c["cost_category"] == "Branch" for c in costs))
        self.assertTrue(all(c["ledger"] == "Sales Local" for c in costs))
        self.assertEqual({c["cost_centre"]: c["amount"] for c in costs},
                         {"Indore": 6000.0, "Bhopal": 4000.0})


class TestBankAllocations(unittest.TestCase):
    def test_cheque_details_for_reconciliation(self):
        v = connector_returning(RECEIPT_XML).voucher_list()[0]
        self.assertEqual(len(v["bank_allocations"]), 1)
        b = v["bank_allocations"][0]
        self.assertEqual(b["ledger"], "HDFC Bank")
        self.assertEqual(b["instrument_no"], "004411")
        self.assertEqual(b["transaction_type"], "Cheque")
        self.assertEqual(b["unique_reference"], "UTR-99881")
        self.assertEqual(b["status"], "Reconciled")


class TestGstDetails(unittest.TestCase):
    def test_tax_heads_are_folded_into_one_row_per_line(self):
        """Tally sends one RATEDETAILS row per head; a GST return wants taxable
        value and each component side by side, not a pivot."""
        v = connector_returning(SALES_XML).voucher_list()[0]
        self.assertEqual(len(v["gst_details"]), 1)
        g = v["gst_details"][0]
        self.assertEqual(g["item"], "Widget 10mm")
        self.assertEqual(g["hsn_code"], "73181500")
        self.assertEqual(g["cgst"], 900.0)
        self.assertEqual(g["sgst"], 900.0)
        self.assertEqual(g["igst"], 0.0)
        self.assertEqual(g["rate"], 18.0)          # 9 + 9


class TestNoAllocationsIsEmptyNotMissing(unittest.TestCase):
    def test_plain_voucher_yields_empty_lists(self):
        """A contra/journal with no allocations must return [] for each, so the
        importer can loop unconditionally."""
        xml = """<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER>
          <GUID>cmp-0001-1</GUID><VOUCHERTYPENAME>Contra</VOUCHERTYPENAME>
          <VOUCHERNUMBER>C-1</VOUCHERNUMBER><DATE>20260401</DATE><AMOUNT>500</AMOUNT>
          <LEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>500</AMOUNT></LEDGERENTRIES.LIST>
        </VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>"""
        v = connector_returning(xml).voucher_list()[0]
        for key in ("bill_allocations", "batch_allocations", "cost_allocations",
                    "bank_allocations", "gst_details"):
            self.assertEqual(v[key], [], key)


if __name__ == "__main__":
    unittest.main()


# A purchase whose DISCOUNT RECEIVED leg nests a BILLALLOCATIONS carrying its
# own ISDEEMEDPOSITIVE and AMOUNT. A descending tag search returns the NESTED
# values, flipping the leg's Dr/Cr — the defect that left 2,233 of 4,442 real
# vouchers not balancing, and every discount ledger reporting the exact negative
# of its Tally balance.
NESTED_TRAP_XML = """<ENVELOPE><BODY><DATA><COLLECTION>
  <VOUCHER>
    <GUID>cmp-0001-trap</GUID>
    <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
    <VOUCHERNUMBER>P-900</VOUCHERNUMBER>
    <DATE>20260401</DATE>
    <AMOUNT>1167351.13</AMOUNT>
    <LEDGERENTRIES.LIST>
      <LEDGERNAME>Purchase</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-1299262.93</AMOUNT>
    </LEDGERENTRIES.LIST>
    <LEDGERENTRIES.LIST>
      <LEDGERNAME>LIBERTY SHOES LTD.</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <AMOUNT>1167351.13</AMOUNT>
      <BILLALLOCATIONS.LIST>
        <NAME>P-900</NAME>
        <BILLTYPE>New Ref</BILLTYPE>
        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        <AMOUNT>1167351.13</AMOUNT>
      </BILLALLOCATIONS.LIST>
    </LEDGERENTRIES.LIST>
    <LEDGERENTRIES.LIST>
      <LEDGERNAME>DISCOUNT RECEIVED</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <AMOUNT>131911.80</AMOUNT>
      <BILLALLOCATIONS.LIST>
        <NAME>P-900</NAME>
        <BILLTYPE>Agst Ref</BILLTYPE>
        <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
        <AMOUNT>-131911.80</AMOUNT>
      </BILLALLOCATIONS.LIST>
    </LEDGERENTRIES.LIST>
  </VOUCHER>
</COLLECTION></DATA></BODY></ENVELOPE>"""


class TestNestedAllocationDoesNotCorruptTheLeg(unittest.TestCase):
    def setUp(self):
        self.entries = connector_returning(NESTED_TRAP_XML).voucher_list()[0]["entries"]
        self.by = {e["ledger"]: e for e in self.entries}

    def test_amounts_come_from_the_entry_not_its_nested_allocation(self):
        self.assertEqual(len(self.entries), 3)
        self.assertEqual(self.by["DISCOUNT RECEIVED"]["amount"], 131911.80)
        self.assertEqual(self.by["LIBERTY SHOES LTD."]["amount"], 1167351.13)

    def test_dr_cr_follows_the_amount_sign(self):
        """Tally stores a DEBIT negative. The nested allocation's
        ISDEEMEDPOSITIVE=Yes must not turn this credit into a debit."""
        self.assertTrue(self.by["Purchase"]["is_debit"])            # -1299262.93
        self.assertFalse(self.by["LIBERTY SHOES LTD."]["is_debit"])  # +1167351.13
        self.assertFalse(self.by["DISCOUNT RECEIVED"]["is_debit"])   # +131911.80

    def test_the_voucher_balances(self):
        """The whole point: Sum(Dr) must equal Sum(Cr), to the paisa."""
        net = sum((abs(e["amount"]) if e["is_debit"] else -abs(e["amount"]))
                  for e in self.entries)
        self.assertAlmostEqual(net, 0.0, places=2)
