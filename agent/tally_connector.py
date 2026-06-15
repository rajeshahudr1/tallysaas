"""Local Tally Prime connector for the Tally Sync Agent.

Talks to a running Tally Prime instance over HTTP/XML on
``http://localhost:9000``. Tally Prime exposes a small XML gateway: you
POST a Tally ``ENVELOPE`` request (an ``EXPORT`` to read data, or an
``IMPORT`` to create masters/vouchers) and it replies with XML.

Connectivity requirement (must be enabled on the customer PC):
    TallyPrime -> F1 (Help) -> Settings -> Connectivity ->
    "Client/Server configuration": set as **Server**, Port **9000**.
Without that, nothing here can reach Tally and every call raises
:class:`TallyUnavailable` with a human-friendly hint.

Design rules: every external call is wrapped. Transport problems
(connection refused, timeout) become :class:`TallyUnavailable` so the
main loop can log + retry instead of crashing. Tally's XML is famously
quirky (mixed encodings, missing closing tags, ``&#4;`` control chars),
so parsing is best-effort and tolerant.
"""

from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET
from typing import Any, Optional

import requests


class TallyUnavailable(Exception):
    """Raised when Tally Prime cannot be reached or refuses the request."""


# Default Tally XML gateway endpoint and per-request timeout.
DEFAULT_URL = "http://localhost:9000"
TIMEOUT = 30  # seconds; large exports (stock summary) can be slow


class TallyConnector:
    """Send/receive Tally XML and build the common request envelopes.

    Parameters
    ----------
    url:
        Tally XML gateway URL, e.g. ``http://localhost:9000``. Defaults to
        :data:`DEFAULT_URL` when falsy.
    logger:
        A :class:`logging.Logger` (from ``logger.get_logger``) used to record
        every request and failure.
    """

    def __init__(self, url: str = DEFAULT_URL, logger: Optional[logging.Logger] = None) -> None:
        self.url = (url or DEFAULT_URL).rstrip("/")
        self.log = logger or logging.getLogger(__name__)
        self._session = requests.Session()

    # ------------------------------------------------------------------ #
    # Transport
    # ------------------------------------------------------------------ #
    def is_available(self) -> bool:
        """Quick probe: is Tally reachable on the configured URL?

        Sends a tiny "List of Companies" export and returns ``True`` on any
        HTTP reply. Never raises — returns ``False`` if Tally is down so the
        main loop can simply skip this cycle and retry later.
        """
        try:
            self.send(self._companies_request_xml())
            return True
        except TallyUnavailable:
            return False
        except Exception as exc:  # noqa: BLE001 - probe must never raise
            self.log.debug("Tally probe failed: %s", exc)
            return False

    def send(self, xml: str) -> str:
        """POST a Tally XML envelope and return the raw response text.

        Raises
        ------
        TallyUnavailable
            On any transport-level error (connection refused, timeout, DNS),
            or when Tally answers with a non-2xx HTTP status.
        """
        try:
            # Tally expects raw bytes; encode explicitly so non-ASCII names
            # (party names, GSTIN) survive the trip.
            resp = self._session.post(
                self.url,
                data=xml.encode("utf-8"),
                headers={"Content-Type": "text/xml"},
                timeout=TIMEOUT,
            )
        except (requests.ConnectionError, requests.Timeout) as exc:
            self.log.error("Tally transport error: %s", exc)
            raise TallyUnavailable(
                "Tally Prime is not reachable on "
                + self.url
                + ". Is Tally running with the XML port enabled?"
            ) from exc
        except requests.RequestException as exc:
            self.log.error("Tally request error: %s", exc)
            raise TallyUnavailable(
                "Tally Prime is not reachable on "
                + self.url
                + ". Is Tally running with the XML port enabled?"
            ) from exc

        if resp.status_code >= 400:
            self.log.error("Tally HTTP %s: %s", resp.status_code, resp.text[:200])
            raise TallyUnavailable(
                "Tally Prime returned HTTP "
                + str(resp.status_code)
                + " from "
                + self.url
                + "."
            )

        # Tally usually replies as UTF-16; let requests guess but fall back.
        try:
            text = resp.text
        except Exception:  # noqa: BLE001 - decode quirks
            text = resp.content.decode("utf-8", errors="replace")
        return text

    # ------------------------------------------------------------------ #
    # High-level reads
    # ------------------------------------------------------------------ #
    def company_info(self) -> dict[str, Any]:
        """Return basic info about the open company / list of companies.

        Sends the "List of Companies" export and parses it best-effort into
        ``{"companies": [{"name": ...}, ...], "active": <first name or None>}``.
        Tolerates Tally's quirky XML; on a parse miss returns an empty list
        rather than raising (transport errors still raise
        :class:`TallyUnavailable`).
        """
        xml = self.send(self._companies_request_xml())
        root = self._safe_parse(xml)
        companies: list[dict[str, Any]] = []
        if root is not None:
            # Company names show up under <COMPANY NAME="..."> or as text in
            # <COMPANYNAME>/<SVCURRENTCOMPANY> depending on the export collection.
            for el in root.iter():
                tag = self._localname(el.tag).upper()
                name = (el.get("NAME") or el.get("Name") or "").strip()
                if tag == "COMPANY" and name:
                    companies.append({"name": name})
                elif tag in ("COMPANYNAME", "SVCURRENTCOMPANY") and (el.text or "").strip():
                    companies.append({"name": el.text.strip()})
        # De-duplicate while preserving order.
        seen: set[str] = set()
        unique = []
        for c in companies:
            if c["name"] not in seen:
                seen.add(c["name"])
                unique.append(c)
        active = unique[0]["name"] if unique else None
        return {"companies": unique, "active": active}

    def ledger_list(self) -> list[dict[str, Any]]:
        """Fetch the list of ledgers (name + parent group) from Tally."""
        xml = self.send(self._ledger_list_request_xml())
        root = self._safe_parse(xml)
        ledgers: list[dict[str, Any]] = []
        if root is not None:
            for el in root.iter():
                if self._localname(el.tag).upper() == "LEDGER":
                    name = (el.get("NAME") or el.get("Name") or "").strip()
                    parent = self._child_text(el, "PARENT")
                    if name:
                        ledgers.append({"name": name, "parent": parent})
        return ledgers

    def stock_summary(self) -> list[dict[str, Any]]:
        """Fetch the stock summary (item name + closing balance) from Tally."""
        xml = self.send(self._stock_summary_request_xml())
        root = self._safe_parse(xml)
        items: list[dict[str, Any]] = []
        if root is not None:
            for el in root.iter():
                if self._localname(el.tag).upper() == "STOCKITEM":
                    name = (el.get("NAME") or el.get("Name") or "").strip()
                    closing = self._child_text(el, "CLOSINGBALANCE")
                    if name:
                        items.append({"name": name, "closing": closing})
        return items

    def day_book(self) -> list[dict[str, Any]]:
        """Fetch vouchers from Tally's Day Book → [{date, vtype, vno, party, amount}].

        Reads the Day Book report over a wide date range and parses each
        <VOUCHER>: type, number, date, party, and the party-ledger amount (abs;
        falls back to the first amount found). Best-effort + tolerant of Tally's
        XML quirks; an unparseable body yields an empty list.
        """
        xml = self.send(self._day_book_request_xml())
        root = self._safe_parse(xml)
        out: list[dict[str, Any]] = []
        if root is None:
            return out

        def _amt(s: str) -> float:
            try:
                return abs(float(re.sub(r"[^0-9.\-]", "", s or "") or 0))
            except ValueError:
                return 0.0

        for v in root.iter():
            if self._localname(v.tag).upper() != "VOUCHER":
                continue
            date = self._child_text(v, "DATE")
            vtype = self._child_text(v, "VOUCHERTYPENAME")
            vno = self._child_text(v, "VOUCHERNUMBER")
            party = self._child_text(v, "PARTYLEDGERNAME") or self._child_text(v, "PARTYNAME")

            amount = 0.0
            if party:
                for entry in v.iter():
                    if self._localname(entry.tag).upper() in ("ALLLEDGERENTRIES.LIST", "LEDGERENTRIES.LIST"):
                        if self._child_text(entry, "LEDGERNAME") == party:
                            amount = _amt(self._child_text(entry, "AMOUNT"))
                            if amount:
                                break
            if not amount:
                for entry in v.iter():
                    if self._localname(entry.tag).upper() == "AMOUNT" and (entry.text or "").strip():
                        amount = _amt(entry.text)
                        if amount:
                            break

            if vtype and (vno or party):
                out.append({"date": date, "vtype": vtype, "vno": vno, "party": party, "amount": amount})
        return out

    # ------------------------------------------------------------------ #
    # High-level writes (build XML, send, return raw Tally response)
    # ------------------------------------------------------------------ #
    def create_ledger(
        self,
        name: str,
        parent: str = "Sundry Debtors",
        gstin: Optional[str] = None,
        opening: float = 0,
    ) -> str:
        """Create a ledger master in Tally; returns the raw Tally response."""
        return self.send(self.create_ledger_xml(name, parent, gstin, opening))

    def create_unit(self, name: str) -> str:
        """Create a simple Unit of Measure master in Tally (e.g. Nos, Kg, Box).

        A stock item can only reference a unit that already exists, so the sync
        pass creates the required units BEFORE the stock items. Re-creating an
        existing unit is harmless (Tally ignores it).
        """
        return self.send(self.create_unit_xml(name))

    def create_stock_item(
        self,
        name: str,
        unit: str = "Nos",
        hsn: Optional[str] = None,
        gst_rate: Optional[float] = None,
    ) -> str:
        """Create a stock item master in Tally; returns the raw response."""
        return self.send(self.create_stock_item_xml(name, unit, hsn, gst_rate))

    def create_sales_voucher(self, party: str, date: str, items: list[dict[str, Any]]) -> str:
        """Create a Sales voucher in Tally; returns the raw response."""
        return self.send(self.create_sales_voucher_xml(party, date, items))

    def create_purchase_voucher(self, party: str, date: str, items: list[dict[str, Any]]) -> str:
        """Create a Purchase voucher in Tally; returns the raw response."""
        return self.send(self.create_purchase_voucher_xml(party, date, items))

    def create_receipt(self, party: str, date: str, amount: float, mode: str = "Cash") -> str:
        """Create a Receipt voucher in Tally; returns the raw response."""
        return self.send(self.create_receipt_xml(party, date, amount, mode))

    def create_payment(self, party: str, date: str, amount: float, mode: str = "Cash") -> str:
        """Create a Payment voucher in Tally; returns the raw response."""
        return self.send(self.create_payment_xml(party, date, amount, mode))

    # ------------------------------------------------------------------ #
    # XML BUILDERS — request envelopes (Tally ENVELOPE/TALLYREQUEST format)
    # ------------------------------------------------------------------ #
    # Tally requests are always wrapped in <ENVELOPE>. EXPORT requests read
    # data (HEADER/TALLYREQUEST = Export Data); IMPORT requests create data
    # (HEADER/TALLYREQUEST = Import Data, body holds <TALLYMESSAGE> masters).

    @staticmethod
    def _esc(value: Any) -> str:
        """XML-escape a value for safe inclusion in a Tally request."""
        s = "" if value is None else str(value)
        return (
            s.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
        )

    @staticmethod
    def _companies_request_xml() -> str:
        """EXPORT: List of Companies (also used as the availability probe)."""
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>"
            "<BODY><EXPORTDATA><REQUESTDESC>"
            "<REPORTNAME>List of Companies</REPORTNAME>"
            "<STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
            "</STATICVARIABLES>"
            "</REQUESTDESC></EXPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    @staticmethod
    def _ledger_list_request_xml() -> str:
        """EXPORT: a Collection of Ledgers, fetching NAME + PARENT."""
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>"
            "<BODY><EXPORTDATA><REQUESTDESC>"
            "<REPORTNAME>List of Accounts</REPORTNAME>"
            "<STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
            "<ACCOUNTTYPE>Ledgers</ACCOUNTTYPE>"
            "</STATICVARIABLES>"
            "</REQUESTDESC></EXPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    @staticmethod
    def _stock_summary_request_xml() -> str:
        """EXPORT: the Stock Summary report (item name + closing balance)."""
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>"
            "<BODY><EXPORTDATA><REQUESTDESC>"
            "<REPORTNAME>Stock Summary</REPORTNAME>"
            "<STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
            "</STATICVARIABLES>"
            "</REQUESTDESC></EXPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    @staticmethod
    def _day_book_request_xml() -> str:
        """EXPORT: the Day Book report over a wide date range (all vouchers)."""
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>"
            "<BODY><EXPORTDATA><REQUESTDESC>"
            "<REPORTNAME>Day Book</REPORTNAME>"
            "<STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
            "<SVFROMDATE>19000401</SVFROMDATE>"
            "<SVTODATE>20991231</SVTODATE>"
            "</STATICVARIABLES>"
            "</REQUESTDESC></EXPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_ledger_xml(
        self,
        name: str,
        parent: str = "Sundry Debtors",
        gstin: Optional[str] = None,
        opening: float = 0,
    ) -> str:
        """IMPORT: create a Ledger master.

        Tally tags used inside <LEDGER>:
            <NAME>                 - ledger name
            <PARENT>               - group it belongs to (e.g. Sundry Debtors)
            <OPENINGBALANCE>       - opening balance amount
            <PARTYGSTIN>           - GSTIN/UIN of the party (optional)
            <GSTREGISTRATIONTYPE>  - Regular/Composition (set when GSTIN given)
        """
        name_e = self._esc(name)
        gstin_block = ""
        if gstin:
            gstin_block = (
                "<PARTYGSTIN>" + self._esc(gstin) + "</PARTYGSTIN>"
                "<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>"
            )
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            "<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>"
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<LEDGER NAME="' + name_e + '" ACTION="Create">'
            "<NAME>" + name_e + "</NAME>"
            "<PARENT>" + self._esc(parent) + "</PARENT>"
            "<OPENINGBALANCE>" + self._esc(opening) + "</OPENINGBALANCE>"
            + gstin_block +
            "</LEDGER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_unit_xml(self, name: str) -> str:
        """IMPORT: create a simple Unit of Measure (e.g. Nos, Kg, Box)."""
        name_e = self._esc(name)
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            "<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>"
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<UNIT NAME="' + name_e + '" ACTION="Create">'
            "<NAME>" + name_e + "</NAME>"
            "<ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>"
            "<ORIGINALNAME>" + name_e + "</ORIGINALNAME>"
            "<DECIMALPLACES>2</DECIMALPLACES>"
            "</UNIT>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_stock_item_xml(
        self,
        name: str,
        unit: str = "Nos",
        hsn: Optional[str] = None,
        gst_rate: Optional[float] = None,
    ) -> str:
        """IMPORT: create a Stock Item master.

        Tally tags used inside <STOCKITEM>:
            <NAME>                 - item name
            <BASEUNITS>            - unit of measure (e.g. Nos, Kgs)
            <HSNCODE> / <GSTHSNCODE> - HSN/SAC code (optional)
            <GSTDETAILS> ...       - GST rate setup (optional)
        """
        name_e = self._esc(name)
        hsn_block = "<GSTHSNCODE>" + self._esc(hsn) + "</GSTHSNCODE>" if hsn else ""
        gst_block = ""
        if gst_rate is not None:
            gst_block = (
                "<GSTDETAILS.LIST><STATEWISEDETAILS.LIST><RATEDETAILS.LIST>"
                "<GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD>"
                "<GSTRATE>" + self._esc(gst_rate) + "</GSTRATE>"
                "</RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>"
            )
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            "<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>"
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<STOCKITEM NAME="' + name_e + '" ACTION="Create">'
            "<NAME>" + name_e + "</NAME>"
            "<BASEUNITS>" + self._esc(unit) + "</BASEUNITS>"
            + hsn_block + gst_block +
            "</STOCKITEM>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def _inventory_voucher_xml(
        self,
        vtype: str,
        party: str,
        date: str,
        items: list[dict[str, Any]],
        party_is_debit: bool,
    ) -> str:
        """Shared builder for Sales/Purchase inventory vouchers.

        ``items`` is a list of dicts with keys ``name``, ``qty``, ``rate``.
        Each line maps to an <ALLINVENTORYENTRIES.LIST> with the stock item,
        billed quantity, rate and computed amount. The party ledger takes the
        opposite (debit/credit) sign to the stock value.
        """
        party_e = self._esc(party)
        date_e = self._esc(date)

        total = 0.0
        inv_entries = ""
        for it in items:
            iname = self._esc(it.get("name"))
            qty = float(it.get("qty", 0) or 0)
            rate = float(it.get("rate", 0) or 0)
            amount = qty * rate
            total += amount
            inv_entries += (
                "<ALLINVENTORYENTRIES.LIST>"
                "<STOCKITEMNAME>" + iname + "</STOCKITEMNAME>"
                "<ISDEEMEDPOSITIVE>" + ("No" if party_is_debit else "Yes") + "</ISDEEMEDPOSITIVE>"
                "<ACTUALQTY>" + self._esc(qty) + "</ACTUALQTY>"
                "<BILLEDQTY>" + self._esc(qty) + "</BILLEDQTY>"
                "<RATE>" + self._esc(rate) + "</RATE>"
                "<AMOUNT>" + self._esc(amount) + "</AMOUNT>"
                "</ALLINVENTORYENTRIES.LIST>"
            )

        # Ledger entries: party ledger vs. the sales/purchase account.
        # Sales: party is Debtor (debit, positive amount), Sales a/c credit.
        # Purchase: party is Creditor (credit), Purchase a/c debit.
        party_amount = -total if party_is_debit else total
        account_amount = total if party_is_debit else -total
        account_ledger = "Sales" if party_is_debit else "Purchase"
        ledger_entries = (
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + party_e + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>" + ("Yes" if party_is_debit else "No") + "</ISDEEMEDPOSITIVE>"
            "<AMOUNT>" + self._esc(party_amount) + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + account_ledger + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>" + ("No" if party_is_debit else "Yes") + "</ISDEEMEDPOSITIVE>"
            "<AMOUNT>" + self._esc(account_amount) + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
        )

        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            "<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>"
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<VOUCHER VCHTYPE="' + self._esc(vtype) + '" ACTION="Create">'
            "<DATE>" + date_e + "</DATE>"
            "<EFFECTIVEDATE>" + date_e + "</EFFECTIVEDATE>"
            "<VOUCHERTYPENAME>" + self._esc(vtype) + "</VOUCHERTYPENAME>"
            "<PARTYLEDGERNAME>" + party_e + "</PARTYLEDGERNAME>"
            "<ISINVOICE>Yes</ISINVOICE>"
            + ledger_entries + inv_entries +
            "</VOUCHER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_sales_voucher_xml(self, party: str, date: str, items: list[dict[str, Any]]) -> str:
        """IMPORT: create a Sales voucher (party debit, Sales a/c credit)."""
        return self._inventory_voucher_xml("Sales", party, date, items, party_is_debit=True)

    def create_purchase_voucher_xml(self, party: str, date: str, items: list[dict[str, Any]]) -> str:
        """IMPORT: create a Purchase voucher (party credit, Purchase a/c debit)."""
        return self._inventory_voucher_xml("Purchase", party, date, items, party_is_debit=False)

    def _settlement_voucher_xml(
        self,
        vtype: str,
        party: str,
        date: str,
        amount: float,
        mode: str,
        party_is_debit: bool,
    ) -> str:
        """Shared builder for Receipt/Payment vouchers.

        Receipt: money comes IN  -> cash/bank ledger debited, party credited.
        Payment: money goes OUT -> party debited, cash/bank ledger credited.
        ``mode`` is the cash/bank ledger name (e.g. "Cash", "HDFC Bank").
        """
        party_e = self._esc(party)
        mode_e = self._esc(mode)
        date_e = self._esc(date)
        amt = float(amount or 0)

        # In Tally, debit amounts are negative, credit amounts positive.
        if party_is_debit:  # Payment
            party_amt, mode_amt = -amt, amt
            party_pos, mode_pos = "Yes", "No"
        else:  # Receipt
            party_amt, mode_amt = amt, -amt
            party_pos, mode_pos = "No", "Yes"

        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            "<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>"
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<VOUCHER VCHTYPE="' + self._esc(vtype) + '" ACTION="Create">'
            "<DATE>" + date_e + "</DATE>"
            "<VOUCHERTYPENAME>" + self._esc(vtype) + "</VOUCHERTYPENAME>"
            "<PARTYLEDGERNAME>" + party_e + "</PARTYLEDGERNAME>"
            # First ledger line = the cash/bank side, second = the party side.
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + mode_e + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>" + mode_pos + "</ISDEEMEDPOSITIVE>"
            "<AMOUNT>" + self._esc(mode_amt) + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + party_e + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>" + party_pos + "</ISDEEMEDPOSITIVE>"
            "<AMOUNT>" + self._esc(party_amt) + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
            "</VOUCHER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_receipt_xml(self, party: str, date: str, amount: float, mode: str = "Cash") -> str:
        """IMPORT: create a Receipt voucher (cash/bank debit, party credit)."""
        return self._settlement_voucher_xml("Receipt", party, date, amount, mode, party_is_debit=False)

    def create_payment_xml(self, party: str, date: str, amount: float, mode: str = "Cash") -> str:
        """IMPORT: create a Payment voucher (party debit, cash/bank credit)."""
        return self._settlement_voucher_xml("Payment", party, date, amount, mode, party_is_debit=True)

    def create_journal_xml(self, dr_ledger: str, cr_ledger: str, date: str,
                           amount: float, narration: str = "", vch_type: str = "Journal") -> str:
        """IMPORT: create a two-ledger voucher — Debit one ledger, Credit another.

        `vch_type` is the Tally voucher type: Journal | Contra | Credit Note |
        Debit Note (all share the Dr/Cr shape). Tally convention: the debited
        ledger carries a NEGATIVE amount + ISDEEMEDPOSITIVE=Yes; the credited
        ledger a POSITIVE amount + ISDEEMEDPOSITIVE=No.
        """
        amt = f"{float(amount):.2f}"
        date_e = self._esc(date)
        vt = self._esc(vch_type or "Journal")
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            "<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>"
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<VOUCHER VCHTYPE="' + vt + '" ACTION="Create">'
            "<DATE>" + date_e + "</DATE>"
            "<EFFECTIVEDATE>" + date_e + "</EFFECTIVEDATE>"
            "<VOUCHERTYPENAME>" + vt + "</VOUCHERTYPENAME>"
            "<NARRATION>" + self._esc(narration or "") + "</NARRATION>"
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + self._esc(dr_ledger) + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>"
            "<AMOUNT>-" + amt + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + self._esc(cr_ledger) + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>"
            "<AMOUNT>" + amt + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
            "</VOUCHER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_journal(self, dr_ledger: str, cr_ledger: str, date: str,
                       amount: float, narration: str = "", vch_type: str = "Journal") -> str:
        """Create a two-ledger voucher (Journal/Contra/Credit Note/Debit Note)."""
        return self.send(self.create_journal_xml(dr_ledger, cr_ledger, date, amount, narration, vch_type))

    # ------------------------------------------------------------------ #
    # XML parsing helpers (best-effort, tolerant of Tally quirks)
    # ------------------------------------------------------------------ #
    @staticmethod
    def _localname(tag: str) -> str:
        """Strip any XML namespace prefix from an element tag."""
        if "}" in tag:
            return tag.split("}", 1)[1]
        return tag

    @staticmethod
    def _sanitize(xml: str) -> str:
        """Remove illegal control chars Tally sometimes emits (e.g. &#4;)."""
        # Strip raw control chars (except tab/newline/CR) and bad entities.
        xml = re.sub(r"&#(?:[0-8]|1[12]|1[4-9]|2[0-9]|3[01]);", "", xml)
        xml = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", xml)
        return xml

    def _safe_parse(self, xml: str) -> Optional[ET.Element]:
        """Parse Tally XML defensively; return the root or ``None`` on failure."""
        if not xml:
            return None
        try:
            return ET.fromstring(self._sanitize(xml))
        except ET.ParseError as exc:
            self.log.warning("Tally XML parse failed: %s", exc)
            return None

    def _child_text(self, el: ET.Element, child_localname: str) -> str:
        """Return the trimmed text of the first matching child, namespace-agnostic."""
        target = child_localname.upper()
        for child in el.iter():
            if self._localname(child.tag).upper() == target and (child.text or "").strip():
                return child.text.strip()
        return ""
