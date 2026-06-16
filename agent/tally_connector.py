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

    def ledger_list(self, company: Optional[str] = None) -> list[dict[str, Any]]:
        """Fetch ledgers from Tally via a COLLECTION (name, parent, alterid, ...).

        Uses a Collection of TYPE Ledger that FETCHes NAME, PARENT, ALTERID,
        PARTYGSTIN and OPENINGBALANCE so the cloud can both classify the ledger
        (parent group) AND upsert its fields (gstin/opening) AND drive
        incrementality (alterid is Tally's monotonically-rising change counter).

        Pass ``company`` to read a SPECIFIC loaded company (SVCURRENTCOMPANY);
        omit it to read whichever company is currently active in Tally. Returns
        ``[{name, parent, gstin, opening, alterid:int}, ...]``.
        """
        xml = self.send(self._ledger_collection_request_xml(company))
        root = self._safe_parse(xml)
        ledgers: list[dict[str, Any]] = []
        if root is not None:
            for el in root.iter():
                if self._localname(el.tag).upper() == "LEDGER":
                    name = (el.get("NAME") or el.get("Name") or "").strip() \
                        or self._child_text(el, "NAME")
                    if not name:
                        continue
                    ledgers.append({
                        "name": name,
                        "parent": self._child_text(el, "PARENT"),
                        "gstin": self._child_text(el, "PARTYGSTIN") or None,
                        "opening": self._child_text(el, "OPENINGBALANCE"),
                        "alterid": self._alterid(el),
                    })
        return ledgers

    def stock_summary(self, company: Optional[str] = None) -> list[dict[str, Any]]:
        """Fetch stock items from Tally via a COLLECTION (name, alterid, ...).

        Uses a Collection of TYPE StockItem that FETCHes NAME, ALTERID,
        BASEUNITS, GSTHSNCODE and CLOSINGBALANCE so the cloud can upsert the
        item's fields (unit/hsn/closing) AND drive incrementality via alterid.

        Pass ``company`` to target a specific loaded company (SVCURRENTCOMPANY).
        Returns ``[{name, unit, hsn, closing, alterid:int}, ...]``.
        """
        xml = self.send(self._stock_collection_request_xml(company))
        root = self._safe_parse(xml)
        items: list[dict[str, Any]] = []
        if root is not None:
            for el in root.iter():
                if self._localname(el.tag).upper() == "STOCKITEM":
                    name = (el.get("NAME") or el.get("Name") or "").strip() \
                        or self._child_text(el, "NAME")
                    if not name:
                        continue
                    items.append({
                        "name": name,
                        "unit": self._child_text(el, "BASEUNITS") or None,
                        "hsn": self._child_text(el, "GSTHSNCODE") or None,
                        "closing": self._child_text(el, "CLOSINGBALANCE"),
                        "alterid": self._alterid(el),
                    })
        return items

    def godown_list(self, company: Optional[str] = None) -> list[dict[str, Any]]:
        """Fetch godowns from Tally via a COLLECTION (name, alterid) -> locations.

        Uses the SAME working Collection envelope as ledgers/stock (HEADER
        TALLYREQUEST=Export / TYPE=Collection / ID, BODY/DESC with the inline
        TDL COLLECTION of TYPE Godown that FETCHes NAME + ALTERID). The cloud
        maps each godown to a row in the locations table.

        Pass ``company`` to target a specific loaded company (SVCURRENTCOMPANY);
        omit it for the active company. Returns ``[{name, alterid:int}, ...]``.
        """
        xml = self.send(self._godown_collection_request_xml(company))
        root = self._safe_parse(xml)
        godowns: list[dict[str, Any]] = []
        if root is not None:
            for el in root.iter():
                if self._localname(el.tag).upper() == "GODOWN":
                    name = (el.get("NAME") or el.get("Name") or "").strip() \
                        or self._child_text(el, "NAME")
                    if not name:
                        continue
                    godowns.append({
                        "name": name,
                        "alterid": self._alterid(el),
                    })
        return godowns

    def day_book(self, company: Optional[str] = None) -> list[dict[str, Any]]:
        """Fetch vouchers from Tally's Day Book → [{date, vtype, vno, party, amount}].

        Reads the Day Book report over a wide date range and parses each
        <VOUCHER>: type, number, date, party, and the party-ledger amount (abs;
        falls back to the first amount found). Pass ``company`` to target a
        specific loaded company (SVCURRENTCOMPANY). Best-effort + tolerant of
        Tally's XML quirks; an unparseable body yields an empty list.
        """
        xml = self.send(self._day_book_request_xml(company))
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
        company: Optional[str] = None,
    ) -> str:
        """Create a ledger master in Tally; returns the raw Tally response.

        Pass ``company`` to import the ledger into that SPECIFIC loaded company
        (SVCURRENTCOMPANY); omit it to import into whichever company is active.
        """
        return self.send(self.create_ledger_xml(name, parent, gstin, opening, company))

    def create_unit(self, name: str, company: Optional[str] = None) -> str:
        """Create a simple Unit of Measure master in Tally (e.g. Nos, Kg, Box).

        A stock item can only reference a unit that already exists, so the sync
        pass creates the required units BEFORE the stock items. Re-creating an
        existing unit is harmless (Tally ignores it). Pass ``company`` so the
        unit is created in the SAME company as the stock items that need it.
        """
        return self.send(self.create_unit_xml(name, company))

    def create_stock_item(
        self,
        name: str,
        unit: str = "Nos",
        hsn: Optional[str] = None,
        gst_rate: Optional[float] = None,
        company: Optional[str] = None,
    ) -> str:
        """Create a stock item master in Tally; returns the raw response.

        Pass ``company`` to import the item into that specific loaded company.
        """
        return self.send(self.create_stock_item_xml(name, unit, hsn, gst_rate, company))

    def create_godown(self, name: str, company: Optional[str] = None) -> str:
        """Create a Godown master in Tally (cloud location -> Tally godown).

        Idempotent: re-creating an existing godown is harmless. Pass ``company``
        to import into that specific loaded company.
        """
        return self.send(self.create_godown_xml(name, company))

    def create_stock_group(self, name: str, company: Optional[str] = None) -> str:
        """Create a Stock Group master in Tally (cloud category -> Tally group).

        Idempotent: re-creating an existing stock group is harmless. Pass
        ``company`` to import into that specific loaded company.
        """
        return self.send(self.create_stock_group_xml(name, company))

    def create_sales_voucher(self, party: str, date: str, items: list[dict[str, Any]],
                             company: Optional[str] = None, amount: Optional[float] = None) -> str:
        """Create a Sales voucher in Tally; returns the raw response.

        Pass ``company`` to import the voucher into that specific loaded company.
        ``amount`` is the voucher total; when omitted it is summed from ``items``.
        """
        return self.send(self.create_sales_voucher_xml(party, date, items, company, amount))

    def create_purchase_voucher(self, party: str, date: str, items: list[dict[str, Any]],
                                company: Optional[str] = None, amount: Optional[float] = None) -> str:
        """Create a Purchase voucher in Tally; returns the raw response.

        Pass ``company`` to import the voucher into that specific loaded company.
        ``amount`` is the voucher total; when omitted it is summed from ``items``.
        """
        return self.send(self.create_purchase_voucher_xml(party, date, items, company, amount))

    def ensure_sales_ledger(self, company: Optional[str] = None) -> str:
        """Create the "Sales" account ledger (under Sales Accounts) if missing.

        A plain accounting Sales voucher debits the party and credits a "Sales"
        ledger, so that ledger must exist first. Re-creating it is harmless
        (Tally ignores a duplicate). Pass ``company`` to target a specific
        loaded company.
        """
        return self.create_account_ledger("Sales", "Sales Accounts", company)

    def ensure_purchase_ledger(self, company: Optional[str] = None) -> str:
        """Create the "Purchase" account ledger (under Purchase Accounts) if missing.

        A plain accounting Purchase voucher credits the party and debits a
        "Purchase" ledger, so that ledger must exist first. Re-creating it is
        harmless. Pass ``company`` to target a specific loaded company.
        """
        return self.create_account_ledger("Purchase", "Purchase Accounts", company)

    def create_account_ledger(self, name: str, parent: str,
                              company: Optional[str] = None) -> str:
        """Create an accounting ledger (e.g. Sales/Purchase) under ``parent``.

        Thin wrapper over :meth:`create_ledger` with no GSTIN/opening, used to
        idempotently ensure the Sales/Purchase account ledgers exist before a
        plain accounting voucher references them.
        """
        return self.create_ledger(name, parent=parent, company=company)

    def create_receipt(self, party: str, date: str, amount: float, mode: str = "Cash",
                       company: Optional[str] = None) -> str:
        """Create a Receipt voucher in Tally; returns the raw response.

        Pass ``company`` to import the voucher into that specific loaded company.
        """
        return self.send(self.create_receipt_xml(party, date, amount, mode, company))

    def create_payment(self, party: str, date: str, amount: float, mode: str = "Cash",
                       company: Optional[str] = None) -> str:
        """Create a Payment voucher in Tally; returns the raw response.

        Pass ``company`` to import the voucher into that specific loaded company.
        """
        return self.send(self.create_payment_xml(party, date, amount, mode, company))

    def create_company(
        self,
        name: str,
        books_from: Optional[str] = None,
        fy_from: Optional[str] = None,
    ) -> str:
        """Create a COMPANY in Tally (web-made company -> Tally); raw response.

        ``books_from`` / ``fy_from`` are Tally YYYYMMDD dates; both default to
        the 1st April of the current (or previous, before April) financial year
        — the usual Indian FY start. Returns the raw Tally response.
        """
        return self.send(self.create_company_xml(name, books_from, fy_from))

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
    def _svcompany(company: Optional[str]) -> str:
        """An ``<SVCURRENTCOMPANY>`` static-variable block targeting a specific
        loaded company. Empty string = the active company. Used both in EXPORT
        requests (inside DESC/STATICVARIABLES) and, via :meth:`_import_requestdesc`,
        in IMPORT requests (inside REQUESTDESC/STATICVARIABLES)."""
        return ("<SVCURRENTCOMPANY>" + TallyConnector._esc(company) + "</SVCURRENTCOMPANY>") if company else ""

    @staticmethod
    def _import_requestdesc(report_name: str, company: Optional[str]) -> str:
        """Build the IMPORT ``<REQUESTDESC>`` block, optionally company-targeted.

        ``report_name`` is the import report (``All Masters`` for ledgers/units/
        stock items, ``Vouchers`` for vouchers). When ``company`` is given, a
        ``<STATICVARIABLES><SVCURRENTCOMPANY>name</SVCURRENTCOMPANY></STATICVARIABLES>``
        block is injected right after ``<REPORTNAME>`` so Tally imports into that
        NAMED loaded company instead of just the active one. Omitting ``company``
        keeps the original single-company behaviour (import into the active company).
        """
        sv = TallyConnector._svcompany(company)
        sv_block = ("<STATICVARIABLES>" + sv + "</STATICVARIABLES>") if sv else ""
        return (
            "<REQUESTDESC>"
            "<REPORTNAME>" + TallyConnector._esc(report_name) + "</REPORTNAME>"
            + sv_block +
            "</REQUESTDESC>"
        )

    @staticmethod
    def _companies_request_xml() -> str:
        """EXPORT: a Collection of Company (the LOADED companies). Also the probe.

        Tally Prime has no "List of Companies" REPORT — the working way to list
        open companies is a Collection of TYPE Company via the
        TALLYREQUEST=Export / TYPE=Collection / ID envelope. Each loaded company
        comes back as <COMPANY NAME="..."> in the response.
        """
        return TallyConnector._collection_request_xml(
            "TSSCompanyColl", "Company", ["NAME"], None,
        )

    @staticmethod
    def _collection_request_xml(
        coll_name: str,
        coll_type: str,
        fetch: list[str],
        company: Optional[str] = None,
    ) -> str:
        """EXPORT: a Tally COLLECTION fetching specific fields (with ALTERID).

        Uses the format Tally Prime actually accepts for a custom collection:
        HEADER carries TALLYREQUEST=Export + TYPE=Collection + ID=<coll_name>,
        and BODY/DESC defines that same-named <COLLECTION> inline in <TDL> with a
        single comma-separated <FETCH> (NAME, ALTERID + the upsert fields).
        Exporting it returns one element per object carrying those fields, which
        lets the cloud upsert + run incrementally on ALTERID.

        ``fetch`` is the list of Tally field names to pull. ``company`` targets a
        specific loaded company (SVCURRENTCOMPANY); empty = the active company.
        """
        fetch_csv = TallyConnector._esc(",".join(fetch))
        coll_e = TallyConnector._esc(coll_name)
        type_e = TallyConnector._esc(coll_type)
        return (
            "<ENVELOPE>"
            "<HEADER>"
            "<VERSION>1</VERSION>"
            "<TALLYREQUEST>Export</TALLYREQUEST>"
            "<TYPE>Collection</TYPE>"
            "<ID>" + coll_e + "</ID>"
            "</HEADER>"
            "<BODY><DESC>"
            "<STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
            + TallyConnector._svcompany(company) +
            "</STATICVARIABLES>"
            "<TDL><TDLMESSAGE>"
            '<COLLECTION NAME="' + coll_e + '" ISMODIFY="No">'
            "<TYPE>" + type_e + "</TYPE>"
            "<FETCH>" + fetch_csv + "</FETCH>"
            "</COLLECTION>"
            "</TDLMESSAGE></TDL>"
            "</DESC></BODY>"
            "</ENVELOPE>"
        )

    @staticmethod
    def _ledger_collection_request_xml(company: Optional[str] = None) -> str:
        """EXPORT: a Collection of Ledgers fetching name/parent/alterid/gstin/opening."""
        return TallyConnector._collection_request_xml(
            "TSSLedgerColl", "Ledger",
            ["NAME", "PARENT", "ALTERID", "PARTYGSTIN", "OPENINGBALANCE"],
            company,
        )

    @staticmethod
    def _stock_collection_request_xml(company: Optional[str] = None) -> str:
        """EXPORT: a Collection of StockItems fetching name/alterid/units/hsn/closing."""
        return TallyConnector._collection_request_xml(
            "TSSStockColl", "StockItem",
            ["NAME", "ALTERID", "BASEUNITS", "GSTHSNCODE", "CLOSINGBALANCE"],
            company,
        )

    @staticmethod
    def _godown_collection_request_xml(company: Optional[str] = None) -> str:
        """EXPORT: a Collection of Godowns fetching name/alterid."""
        return TallyConnector._collection_request_xml(
            "TSSGodownColl", "Godown",
            ["NAME", "ALTERID"],
            company,
        )

    @staticmethod
    def _day_book_request_xml(company: Optional[str] = None) -> str:
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
            + TallyConnector._svcompany(company) +
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
        company: Optional[str] = None,
    ) -> str:
        """IMPORT: create a Ledger master.

        Tally tags used inside <LEDGER>:
            <NAME>                 - ledger name
            <PARENT>               - group it belongs to (e.g. Sundry Debtors)
            <OPENINGBALANCE>       - opening balance amount
            <PARTYGSTIN>           - GSTIN/UIN of the party (optional)
            <GSTREGISTRATIONTYPE>  - Regular/Composition (set when GSTIN given)

        Pass ``company`` to import the ledger into that specific loaded company
        (SVCURRENTCOMPANY inside REQUESTDESC); omit it for the active company.
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
            + self._import_requestdesc("All Masters", company) +
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

    def create_unit_xml(self, name: str, company: Optional[str] = None) -> str:
        """IMPORT: create a simple Unit of Measure (e.g. Nos, Kg, Box).

        Pass ``company`` to create the unit in that specific loaded company
        (so it exists in the same company as the stock items referencing it).
        """
        name_e = self._esc(name)
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("All Masters", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<UNIT NAME="' + name_e + '" ACTION="Create">'
            "<NAME>" + name_e + "</NAME>"
            "<ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>"
            # NOTE: no <ORIGINALNAME> — that field is for RENAMING; on a Create it
            # makes Tally reject the unit as "DUPLICATE ORIGINAL NAME".
            "<DECIMALPLACES>0</DECIMALPLACES>"
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
        company: Optional[str] = None,
    ) -> str:
        """IMPORT: create a Stock Item master.

        Tally tags used inside <STOCKITEM>:
            <NAME>                 - item name
            <BASEUNITS>            - unit of measure (e.g. Nos, Kgs)
            <HSNCODE> / <GSTHSNCODE> - HSN/SAC code (optional)
            <GSTDETAILS> ...       - GST rate setup (optional)

        Pass ``company`` to import the item into that specific loaded company.
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
            + self._import_requestdesc("All Masters", company) +
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

    def create_godown_xml(self, name: str, company: Optional[str] = None) -> str:
        """IMPORT: create a Godown master (All Masters import, idempotent).

        Tally tags used inside <GODOWN>:
            <NAME>     - godown name
            <PARENT>   - "Primary" (top-level godown)

        Pass ``company`` to import into that specific loaded company.
        """
        name_e = self._esc(name)
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("All Masters", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<GODOWN NAME="' + name_e + '" ACTION="Create">'
            "<NAME>" + name_e + "</NAME>"
            # No <PARENT> — a top-level godown. "Primary" is NOT a valid godown
            # parent in Tally ("Godown 'Primary' does not exist!").
            "</GODOWN>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_stock_group_xml(self, name: str, company: Optional[str] = None) -> str:
        """IMPORT: create a Stock Group master (All Masters import, idempotent).

        Tally tags used inside <STOCKGROUP>:
            <NAME>     - stock group name
            <PARENT>   - "Primary" (top-level group)

        Pass ``company`` to import into that specific loaded company.
        """
        name_e = self._esc(name)
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("All Masters", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<STOCKGROUP NAME="' + name_e + '" ACTION="Create">'
            "<NAME>" + name_e + "</NAME>"
            # No <PARENT> — a top-level stock group. "Primary" is NOT a valid
            # parent ("Stock Group 'Primary' does not exist!").
            "</STOCKGROUP>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    @staticmethod
    def _items_total(items: list[dict[str, Any]]) -> float:
        """Sum qty*rate across voucher line items (fallback when no total given)."""
        total = 0.0
        for it in (items or []):
            try:
                qty = float(it.get("qty", 0) or 0)
                rate = float(it.get("rate", 0) or 0)
            except (TypeError, ValueError):
                qty, rate = 0.0, 0.0
            total += qty * rate
        return total

    def _inventory_voucher_xml(
        self,
        vtype: str,
        party: str,
        date: str,
        items: list[dict[str, Any]],
        party_is_debit: bool,
        company: Optional[str] = None,
        amount: Optional[float] = None,
    ) -> str:
        """Shared builder for Sales/Purchase vouchers as PLAIN ACCOUNTING entries.

        PROVEN-WORKING shape (CREATED=1 live): a plain accounting voucher with NO
        inventory. The voucher carries exactly two ledger lines — the PARTY and
        the Sales/Purchase account ledger — using the voucher TOTAL (no GST split,
        no stock items). The inventory-invoice form (ISINVOICE + ALLINVENTORYENTRIES)
        was too fragile and failed with a bare <EXCEPTIONS>1</EXCEPTIONS>.

        ``amount`` is the voucher total; when None it is summed from ``items``
        (items are otherwise ignored — they no longer drive inventory lines). The
        "Sales"/"Purchase" account ledger must already exist (see
        :meth:`ensure_sales_ledger` / :meth:`ensure_purchase_ledger`). Pass
        ``company`` to import into that specific loaded company.

        Sales (party_is_debit=True): party ISDEEMEDPOSITIVE=Yes AMOUNT=-TOTAL,
        Sales ledger ISDEEMEDPOSITIVE=No AMOUNT=TOTAL.
        Purchase (party_is_debit=False): party ISDEEMEDPOSITIVE=No AMOUNT=TOTAL,
        Purchase ledger ISDEEMEDPOSITIVE=Yes AMOUNT=-TOTAL.
        """
        party_e = self._esc(party)
        date_e = self._esc(date)

        total = float(amount) if amount is not None else self._items_total(items)
        total_s = "%.2f" % total
        account_ledger = "Sales" if party_is_debit else "Purchase"

        if party_is_debit:  # Sales
            party_amt = "-" + total_s
            party_pos = "Yes"
            account_amt = total_s
            account_pos = "No"
        else:               # Purchase
            party_amt = total_s
            party_pos = "No"
            account_amt = "-" + total_s
            account_pos = "Yes"

        ledger_entries = (
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + party_e + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>" + party_pos + "</ISDEEMEDPOSITIVE>"
            "<AMOUNT>" + party_amt + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
            "<ALLLEDGERENTRIES.LIST>"
            "<LEDGERNAME>" + account_ledger + "</LEDGERNAME>"
            "<ISDEEMEDPOSITIVE>" + account_pos + "</ISDEEMEDPOSITIVE>"
            "<AMOUNT>" + account_amt + "</AMOUNT>"
            "</ALLLEDGERENTRIES.LIST>"
        )

        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("Vouchers", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<VOUCHER VCHTYPE="' + self._esc(vtype) + '" ACTION="Create">'
            "<DATE>" + date_e + "</DATE>"
            "<VOUCHERTYPENAME>" + self._esc(vtype) + "</VOUCHERTYPENAME>"
            "<PARTYLEDGERNAME>" + party_e + "</PARTYLEDGERNAME>"
            + ledger_entries +
            "</VOUCHER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

    def create_sales_voucher_xml(self, party: str, date: str, items: list[dict[str, Any]],
                                 company: Optional[str] = None,
                                 amount: Optional[float] = None) -> str:
        """IMPORT: create a Sales voucher (party debit, Sales a/c credit)."""
        return self._inventory_voucher_xml("Sales", party, date, items, party_is_debit=True,
                                           company=company, amount=amount)

    def create_purchase_voucher_xml(self, party: str, date: str, items: list[dict[str, Any]],
                                    company: Optional[str] = None,
                                    amount: Optional[float] = None) -> str:
        """IMPORT: create a Purchase voucher (party credit, Purchase a/c debit)."""
        return self._inventory_voucher_xml("Purchase", party, date, items, party_is_debit=False,
                                           company=company, amount=amount)

    def _settlement_voucher_xml(
        self,
        vtype: str,
        party: str,
        date: str,
        amount: float,
        mode: str,
        party_is_debit: bool,
        company: Optional[str] = None,
    ) -> str:
        """Shared builder for Receipt/Payment vouchers.

        Receipt: money comes IN  -> cash/bank ledger debited, party credited.
        Payment: money goes OUT -> party debited, cash/bank ledger credited.
        ``mode`` is the cash/bank ledger name (e.g. "Cash", "HDFC Bank"). Pass
        ``company`` to import the voucher into that specific loaded company.
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
            + self._import_requestdesc("Vouchers", company) +
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

    def create_receipt_xml(self, party: str, date: str, amount: float, mode: str = "Cash",
                           company: Optional[str] = None) -> str:
        """IMPORT: create a Receipt voucher (cash/bank debit, party credit)."""
        return self._settlement_voucher_xml("Receipt", party, date, amount, mode,
                                            party_is_debit=False, company=company)

    def create_payment_xml(self, party: str, date: str, amount: float, mode: str = "Cash",
                           company: Optional[str] = None) -> str:
        """IMPORT: create a Payment voucher (party debit, cash/bank credit)."""
        return self._settlement_voucher_xml("Payment", party, date, amount, mode,
                                            party_is_debit=True, company=company)

    def create_journal_xml(self, dr_ledger: str, cr_ledger: str, date: str,
                           amount: float, narration: str = "", vch_type: str = "Journal",
                           company: Optional[str] = None) -> str:
        """IMPORT: create a two-ledger voucher — Debit one ledger, Credit another.

        `vch_type` is the Tally voucher type: Journal | Contra | Credit Note |
        Debit Note (all share the Dr/Cr shape). Tally convention: the debited
        ledger carries a NEGATIVE amount + ISDEEMEDPOSITIVE=Yes; the credited
        ledger a POSITIVE amount + ISDEEMEDPOSITIVE=No. Pass ``company`` to import
        the voucher into that specific loaded company.
        """
        amt = f"{float(amount):.2f}"
        date_e = self._esc(date)
        vt = self._esc(vch_type or "Journal")
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("Vouchers", company) +
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
                       amount: float, narration: str = "", vch_type: str = "Journal",
                       company: Optional[str] = None) -> str:
        """Create a two-ledger voucher (Journal/Contra/Credit Note/Debit Note).

        Pass ``company`` to import the voucher into that specific loaded company.
        """
        return self.send(self.create_journal_xml(dr_ledger, cr_ledger, date, amount,
                                                  narration, vch_type, company))

    @staticmethod
    def _default_fy_start() -> str:
        """Tally YYYYMMDD for the start of the current Indian financial year.

        Indian FY starts 1 April; before April we are still in the FY that began
        on 1 April of the PREVIOUS calendar year. Computed with the stdlib only.
        """
        import datetime
        today = datetime.date.today()
        year = today.year if today.month >= 4 else today.year - 1
        return "%04d0401" % year

    def create_company_xml(
        self,
        name: str,
        books_from: Optional[str] = None,
        fy_from: Optional[str] = None,
    ) -> str:
        """IMPORT: create a COMPANY master in Tally.

        Tally tags used inside <COMPANY>:
            <NAME>              - company name
            <STARTINGFROM>      - financial-year start (YYYYMMDD)
            <BOOKSFROM>         - books-beginning date (YYYYMMDD)
            <ISACCOUNTSONLY>    - "No" so inventory is enabled too

        NOTE: Company-creation XML varies across Tally releases (some builds want
        the company under a different REPORTNAME, or require additional GST/state
        tags). This uses the common "All Masters" import shape with sensible FY
        defaults; it may need field tweaks against a live Tally.
        """
        name_e = self._esc(name)
        start = self._esc(fy_from or self._default_fy_start())
        books = self._esc(books_from or fy_from or self._default_fy_start())
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            "<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>"
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<COMPANY NAME="' + name_e + '" ACTION="Create">'
            "<NAME>" + name_e + "</NAME>"
            "<STARTINGFROM>" + start + "</STARTINGFROM>"
            "<BOOKSFROM>" + books + "</BOOKSFROM>"
            "<ISACCOUNTSONLY>No</ISACCOUNTSONLY>"
            "</COMPANY>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

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

    def _alterid(self, el: ET.Element) -> int:
        """Extract a Tally ALTERID for an element -> int (0 if absent/unparsable).

        Tally exposes ALTERID either as an ATTRIBUTE on the object element
        (<LEDGER ALTERID="42" ...>) or as a CHILD tag (<ALTERID>42</ALTERID>),
        depending on the build/collection. Try the attribute first, then the
        child; tolerate junk by stripping to digits and defaulting to 0.
        """
        raw = el.get("ALTERID") or el.get("AlterId") or el.get("Alterid") or ""
        if not raw:
            raw = self._child_text(el, "ALTERID")
        raw = re.sub(r"[^0-9\-]", "", str(raw or ""))
        try:
            return int(raw) if raw not in ("", "-") else 0
        except ValueError:
            return 0
