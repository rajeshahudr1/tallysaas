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
import time
import xml.etree.ElementTree as ET
from typing import Any, Optional

import requests


# A process-unique nonce for voucher-collection NAMES. Tally caches an inline TDL
# collection by NAME for the session AND poisons it (serves empty forever) if it
# ever returns empty during a heavy/degraded moment. A brand-new name ALWAYS
# evaluates fresh + correct, so every voucher fetch uses a unique name.
_vch_call_counter = 0


def _vch_nonce() -> str:
    global _vch_call_counter
    _vch_call_counter += 1
    return "%x%x" % (int(time.time()) & 0xFFFFFF, _vch_call_counter)


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

    def send(self, xml: str, timeout: "int | None" = None) -> str:
        """POST a Tally XML envelope and return the raw response text.

        ``timeout`` overrides the module default (used by the voucher pull, whose
        chunked collections can be a couple of MB and need longer than a master read).

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
                timeout=timeout or TIMEOUT,
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
        # DEBUG diagnostic (log_level=DEBUG): the response size per request tells
        # us at a glance whether Tally answered with data or an empty/error body.
        self.log.debug("Tally HTTP %s, %d bytes response.", resp.status_code, len(text or ""))
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

    def company_full_info(self, company: Optional[str] = None) -> dict[str, Any]:
        """Fetch the open company's FULL master so the cloud company record mirrors
        Tally: address, state, pincode, country, email, phone, GSTIN, PAN, and the
        financial-year start. Returns ``{}`` on miss. Best-effort."""
        xml = self._collection_request_xml(
            "TSSCmpFull", "Company",
            ["NAME", "GUID", "MAILINGNAME", "ADDRESS", "STATENAME", "PINCODE", "COUNTRYNAME",
             "EMAIL", "PHONENUMBER", "MOBILENUMBERS", "CMPGSTIN",
             "GSTREGISTRATIONNUMBER", "INCOMETAXNUMBER", "STARTINGFROM", "BOOKSFROM"], None)
        root = self._safe_parse(self.send(xml, timeout=60))
        if root is None:
            return {}

        def _fy(s: str) -> Optional[str]:
            m = re.match(r"^(\d{4})(\d{2})(\d{2})$", str(s or "").strip())
            return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None

        for el in root.iter():
            if self._localname(el.tag).upper() != "COMPANY":
                continue
            nm = (el.get("NAME") or "").strip() or self._child_text(el, "NAME")
            if not nm:
                continue
            lines = [a.text.strip() for a in el.iter()
                     if self._localname(a.tag).upper() == "ADDRESS" and (a.text or "").strip()]
            return {
                "name": nm,
                # Tally's STABLE per-company GUID — the cloud dedups companies on
                # this (NOT the mutable name), so a renamed/blank-named company
                # never spawns a duplicate. None if Tally didn't return it (then
                # the cloud falls back to name matching).
                "guid": self._child_text(el, "GUID") or None,
                "mailing_name": self._child_text(el, "MAILINGNAME") or None,
                "email": self._child_text(el, "EMAIL") or None,
                "pincode": self._child_text(el, "PINCODE") or None,
                "state": self._child_text(el, "STATENAME") or None,
                "country": self._child_text(el, "COUNTRYNAME") or None,
                "pan": self._child_text(el, "INCOMETAXNUMBER") or None,
                "gstin": (self._child_text(el, "CMPGSTIN")
                          or self._child_text(el, "GSTREGISTRATIONNUMBER") or None),
                # Tally keeps landline (PHONENUMBER) and mobile (MOBILENUMBERS)
                # separately — mirror that instead of collapsing into one.
                "phone": self._child_text(el, "PHONENUMBER") or None,
                "mobile": self._child_text(el, "MOBILENUMBERS") or None,
                "address": "\n".join(lines) or None,
                "books_from": _fy(self._child_text(el, "STARTINGFROM")
                                  or self._child_text(el, "BOOKSFROM")),
            }
        return {}

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
                    # Mailing address can arrive as multiple nested <ADDRESS> lines.
                    addr_lines = [a.text.strip() for a in el.iter()
                                  if self._localname(a.tag).upper() == "ADDRESS" and (a.text or "").strip()]
                    ledgers.append({
                        "name": name,
                        "parent": self._child_text(el, "PARENT"),
                        "gstin": self._child_text(el, "PARTYGSTIN") or None,
                        "opening": self._child_text(el, "OPENINGBALANCE"),
                        # Tally's AUTHORITATIVE current balance (opening + all
                        # postings + inventory valuation). The cloud uses this for
                        # exact-match reports instead of reconstructing.
                        "closing": self._child_text(el, "CLOSINGBALANCE"),
                        "mobile": (self._child_text(el, "LEDGERMOBILE")
                                   or self._child_text(el, "LEDGERPHONE") or None),
                        "email": self._child_text(el, "EMAIL") or None,
                        "pan": self._child_text(el, "INCOMETAXNUMBER") or None,
                        "address": "\n".join(addr_lines) or None,
                        "state": (self._child_text(el, "LEDSTATENAME")
                                  or self._child_text(el, "STATENAME") or None),
                        "pincode": self._child_text(el, "PINCODE") or None,
                        "country": self._child_text(el, "COUNTRYNAME") or None,
                        "credit_limit": self._child_text(el, "CREDITLIMIT") or None,
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
                        # Stock group = the cloud "category".
                        "parent": self._child_text(el, "PARENT") or None,
                        # HSN: flat GSTHSNCODE, else the nested GST-details HSNCODE.
                        "hsn": (self._child_text(el, "GSTHSNCODE")
                                or self._child_text(el, "HSNCODE") or None),
                        # GST rate lives in the nested GST details; _child_text finds
                        # the first GSTRATE descendant. 0 when the item has no GST.
                        "gst_rate": self._rate(self._child_text(el, "GSTRATE")),
                        "closing": self._child_text(el, "CLOSINGBALANCE"),
                        # Rates come as "187.96/pair" - keep just the number.
                        "sales_price": self._rate(self._child_text(el, "STANDARDPRICE")),
                        "purchase_price": self._rate(self._child_text(el, "STANDARDCOST")
                                                     or self._child_text(el, "OPENINGRATE")),
                        "alterid": self._alterid(el),
                    })
        return items

    @staticmethod
    def _rate(s: str) -> float:
        """Parse a Tally rate like '187.96/pair' or '227.85' -> 187.96 (0 if none)."""
        m = re.search(r"-?\d+(?:\.\d+)?", str(s or "").replace(",", ""))
        try:
            return float(m.group(0)) if m else 0.0
        except ValueError:
            return 0.0

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

    def group_list(self, company: Optional[str] = None) -> list[dict[str, Any]]:
        """Fetch account GROUPS via a COLLECTION (name/parent/alterid/nature) so the
        cloud can build the Balance Sheet / P&L hierarchy. Returns
        ``[{name, parent, is_revenue, is_deemed_positive, alterid:int}, ...]``."""
        root = self._safe_parse(self.send(self._group_collection_request_xml(company)))
        out: list[dict[str, Any]] = []
        if root is None:
            return out
        for el in root.iter():
            if self._localname(el.tag).upper() != "GROUP":
                continue
            name = (el.get("NAME") or "").strip() or self._child_text(el, "NAME")
            if not name:
                continue
            out.append({
                "name": name,
                "parent": self._child_text(el, "PARENT"),
                "is_revenue": self._child_text(el, "ISREVENUE").lower() == "yes",
                "is_deemed_positive": self._child_text(el, "ISDEEMEDPOSITIVE").lower() != "no",
                "alterid": self._alterid(el),
            })
        return out

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

    def voucher_list(self, company: Optional[str] = None,
                     after_alterid: int = 0,
                     upto_alterid: "int | None" = None) -> list[dict[str, Any]]:
        """Fetch vouchers via an AlterID-bounded COLLECTION (the RELIABLE way).

        Returns vouchers whose AlterID is in ``(after_alterid, upto_alterid]`` so
        each response stays small + the pull is INCREMENTAL/CHUNKED like masters
        (a full unfiltered voucher collection chokes Tally). Each item:
        ``{date, vtype, vno, party, amount, alterid:int, guid}``. ``guid`` is
        Tally's stable per-voucher id - the cloud dedupes on it because voucher
        NUMBERS repeat (purchases reuse the supplier bill no). ``alterid`` drives
        incrementality. Best-effort + tolerant of Tally's XML quirks.
        """
        def _amt(s: str) -> float:
            try:
                return abs(float(re.sub(r"[^0-9.\-]", "", s or "") or 0))
            except ValueError:
                return 0.0

        def _parse(root) -> list[dict[str, Any]]:
            rows: list[dict[str, Any]] = []
            if root is None:
                return rows
            for v in root.iter():
                if self._localname(v.tag).upper() != "VOUCHER":
                    continue
                vtype = self._child_text(v, "VOUCHERTYPENAME") or (v.get("VCHTYPE") or "")
                guid = self._child_text(v, "GUID")
                if not (vtype and guid):
                    continue   # skip the CMPINFO <VOUCHER>0</VOUCHER> + partial nodes
                # FULL DOUBLE-ENTRY: every ledger posting of this voucher
                # (LEDGERNAME + signed AMOUNT + Dr/Cr). Sum per ledger (+ opening)
                # = its balance -> Trial Balance / Balance Sheet / P&L / Ledger.
                # Ledger postings live in TWO places: top-level LEDGERENTRIES.LIST
                # (party + tax + round-off) AND, for INVOICE vouchers, the sales/
                # purchase ledger sits in ACCOUNTINGALLOCATIONS.LIST nested under
                # each INVENTORYENTRIES.LIST. Both carry LEDGERNAME + AMOUNT; parse
                # both so the double-entry sums to zero.
                ENTRY_TAGS = ("LEDGERENTRIES.LIST", "ALLLEDGERENTRIES.LIST",
                              "ACCOUNTINGALLOCATIONS.LIST")
                entries = []
                for le in v.iter():
                    if self._localname(le.tag).upper() not in ENTRY_TAGS:
                        continue
                    lname = self._child_text(le, "LEDGERNAME")
                    if not lname:
                        continue
                    raw = self._child_text(le, "AMOUNT")
                    try:
                        amt = float(re.sub(r"[^0-9.\-]", "", raw or "") or 0)
                    except ValueError:
                        amt = 0.0
                    if not amt:
                        continue
                    entries.append({
                        "ledger": lname,
                        "amount": amt,   # signed as Tally stores it
                        "is_debit": self._child_text(le, "ISDEEMEDPOSITIVE").lower() == "yes",
                    })
                # INVENTORY movement (item, qty, rate, amount) for Stock Summary /
                # value. Lives in INVENTORYENTRIES.LIST of trading vouchers.
                inventory = []
                for ie in v.iter():
                    if self._localname(ie.tag).upper() not in ("ALLINVENTORYENTRIES.LIST", "INVENTORYENTRIES.LIST"):
                        continue
                    iname = self._child_text(ie, "STOCKITEMNAME")
                    if not iname:
                        continue
                    inventory.append({
                        "item": iname,
                        "qty": self._rate(self._child_text(ie, "BILLEDQTY")
                                          or self._child_text(ie, "ACTUALQTY")),
                        "rate": self._rate(self._child_text(ie, "RATE")),
                        "amount": self._rate(self._child_text(ie, "AMOUNT")),
                    })
                rows.append({
                    "date": self._child_text(v, "DATE"),
                    "vtype": vtype,
                    "vno": self._child_text(v, "VOUCHERNUMBER"),
                    "party": self._child_text(v, "PARTYLEDGERNAME") or self._child_text(v, "PARTYNAME"),
                    "amount": _amt(self._child_text(v, "AMOUNT")),
                    "alterid": self._alterid(v),
                    "guid": guid,
                    # OPTIONAL = unposted draft, CANCELLED = voided — both are
                    # excluded from Tally's registers, so the cloud flags them.
                    "is_optional": self._child_text(v, "ISOPTIONAL").lower() == "yes",
                    "is_cancelled": self._child_text(v, "ISCANCELLED").lower() == "yes",
                    "entries": entries,
                    "inventory": inventory,
                })
            return rows

        out: list[dict[str, Any]] = []
        # Up to 2 attempts, each with a BRAND-NEW collection name (the request
        # builder mints a nonce) so a transient empty isn't a poisoned name we keep
        # re-hitting. A genuinely-empty AlterID window returns [] both times (cheap).
        for attempt in range(2):
            xml = self._voucher_collection_request_xml(company, after_alterid, upto_alterid)
            out = _parse(self._safe_parse(self.send(xml, timeout=180)))
            if out:
                break
            self.log.debug("voucher_list(%s,%s): empty on attempt %d",
                           after_alterid, upto_alterid, attempt + 1)
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
        **fields: Any,
    ) -> str:
        """Create a ledger master in Tally; returns the raw Tally response.

        ``fields`` carries the extra party columns (mobile/email/pan/address/
        state/pincode/credit_limit) so the cloud customer/supplier pushes its
        FULL record, not just name/gstin/opening.

        Pass ``company`` to import the ledger into that SPECIFIC loaded company
        (SVCURRENTCOMPANY); omit it to import into whichever company is active.
        """
        return self.send(self.create_ledger_xml(name, parent, gstin, opening, company, **fields))

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
        action: str = "Create",
    ) -> str:
        """Create OR alter a stock item master in Tally; returns the raw response.

        ``action`` is "Create" (new) or "Alter" (cloud edit re-push, matched by NAME).
        Pass ``company`` to import the item into that specific loaded company.
        """
        return self.send(self.create_stock_item_xml(name, unit, hsn, gst_rate, company, action))

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

    def create_voucher_from_ledgers(self, vtype: str, party: str, date: str,
                                    ledgers: list[dict[str, Any]],
                                    company: Optional[str] = None) -> str:
        """Create a voucher from an EXPLICIT ledger breakdown so a cloud invoice
        reproduces Tally's exact double-entry (party + Sales/Purchase + GST +
        round-off), not just a 2-line total.

        ``ledgers`` = [{"name": str, "amount": float(abs), "is_debit": bool}].
        Tally signs: a debit posts ISDEEMEDPOSITIVE=Yes AMOUNT=-x, a credit No +x.
        """
        return self.send(self.create_voucher_from_ledgers_xml(vtype, party, date, ledgers, company))

    def create_voucher_from_ledgers_xml(self, vtype: str, party: str, date: str,
                                        ledgers: list[dict[str, Any]],
                                        company: Optional[str] = None) -> str:
        lines = ""
        for L in (ledgers or []):
            amt = abs(float(L.get("amount") or 0))
            if amt == 0:
                continue
            is_debit = bool(L.get("is_debit"))
            pos = "Yes" if is_debit else "No"
            val = ("-%.2f" % amt) if is_debit else ("%.2f" % amt)
            lines += (
                "<ALLLEDGERENTRIES.LIST>"
                "<LEDGERNAME>" + self._esc(L.get("name") or "") + "</LEDGERNAME>"
                "<ISDEEMEDPOSITIVE>" + pos + "</ISDEEMEDPOSITIVE>"
                "<AMOUNT>" + val + "</AMOUNT>"
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
            "<DATE>" + self._esc(date) + "</DATE>"
            "<VOUCHERTYPENAME>" + self._esc(vtype) + "</VOUCHERTYPENAME>"
            "<PARTYLEDGERNAME>" + self._esc(party) + "</PARTYLEDGERNAME>"
            + lines +
            "</VOUCHER>"
            "</TALLYMESSAGE>"
            "</REQUESTDATA></IMPORTDATA></BODY>"
            "</ENVELOPE>"
        )

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
        **fields: Any,
    ) -> str:
        """Create a COMPANY in Tally (web-made company -> Tally); raw response.

        ``books_from`` / ``fy_from`` are Tally YYYYMMDD dates; both default to
        the 1st April of the current (or previous, before April) financial year.
        ``fields`` carries the rest of the cloud company record (mailing_name,
        email, phone, mobile, gst, pan, state, pincode, country, address) so the
        FULL company is created, not just the name. Returns the raw response.
        """
        return self.send(self.create_company_xml(name, books_from, fy_from, **fields))

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
        """EXPORT: a Collection of Ledgers fetching name/parent/alterid + every
        party field the cloud customer/supplier record can store (gstin, opening,
        mobile, email, PAN, address, credit limit)."""
        return TallyConnector._collection_request_xml(
            "TSSLedgerColl", "Ledger",
            ["NAME", "PARENT", "ALTERID", "PARTYGSTIN", "OPENINGBALANCE", "CLOSINGBALANCE",
             "LEDGERMOBILE", "LEDGERPHONE", "EMAIL", "INCOMETAXNUMBER",
             "ADDRESS", "LEDSTATENAME", "PINCODE", "COUNTRYNAME", "CREDITLIMIT"],
            company,
        )

    @staticmethod
    def _stock_collection_request_xml(company: Optional[str] = None) -> str:
        """EXPORT: a Collection of StockItems fetching name/alterid/units/hsn/closing."""
        return TallyConnector._collection_request_xml(
            "TSSStockColl", "StockItem",
            ["NAME", "ALTERID", "BASEUNITS", "PARENT", "GSTHSNCODE", "HSNCODE",
             "GSTRATE", "GSTDETAILS", "CLOSINGBALANCE",
             "STANDARDPRICE", "STANDARDCOST", "OPENINGRATE"],
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
    def _voucher_collection_request_xml(company: Optional[str] = None,
                                        after_alterid: int = 0,
                                        upto_alterid: "int | None" = None) -> str:
        """EXPORT a Voucher COLLECTION FILTERED to an AlterID window (after, upto].

        Tally's plain "Day Book" report is single-day (SVCURRENTDATE) and a full
        unfiltered voucher collection chokes Tally, so we drive an inline
        <COLLECTION TYPE=Voucher> with a <SYSTEM Formulae> AlterID filter. The
        window keeps each response small (a couple of MB) and makes the pull
        incremental + chunked. FETCH includes GUID (stable dedup key) + ALTERID
        (the change counter). ``&gt;``/``&lt;`` are XML-escaped so Tally parses
        the formula operators correctly.
        """
        after = int(after_alterid or 0)
        # LITERAL AlterID filter (PROVEN on this Tally - the static-variable form
        # returned empty). &gt;/&lt; are XML-escaped so Tally parses the operators.
        cond = "$AlterID &gt; " + str(after)
        if upto_alterid is not None:
            cond += " AND $AlterID &lt;= " + str(int(upto_alterid))
        # A BRAND-NEW collection + filter name for EVERY fetch (nonce). Tally
        # poisons a name that ever returned empty (serves empty forever until
        # restart); a fresh name always evaluates correctly (verified). The cost
        # is one cached TDL def per fetch - bounded per Tally session + cleared on
        # restart, and a sync makes few fetches per minute.
        coll = "TSSVch" + _vch_nonce()
        filt = coll + "F"
        return (
            "<ENVELOPE>"
            "<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>"
            "<TYPE>Collection</TYPE><ID>" + coll + "</ID></HEADER>"
            "<BODY><DESC><STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
            + TallyConnector._svcompany(company) +
            "</STATICVARIABLES><TDL><TDLMESSAGE>"
            '<COLLECTION NAME="' + coll + '" ISMODIFY="No">'
            "<TYPE>Voucher</TYPE>"
            "<FETCH>DATE,VOUCHERTYPENAME,VOUCHERNUMBER,PARTYLEDGERNAME,AMOUNT,ALTERID,GUID,ISOPTIONAL,ISCANCELLED</FETCH>"
            "<FILTER>" + filt + "</FILTER>"
            "</COLLECTION>"
            '<SYSTEM TYPE="Formulae" NAME="' + filt + '">' + cond + "</SYSTEM>"
            "</TDLMESSAGE></TDL></DESC></BODY>"
            "</ENVELOPE>"
        )

    @staticmethod
    def _group_collection_request_xml(company: Optional[str] = None) -> str:
        """EXPORT: a Collection of Groups fetching name/parent/alterid/nature."""
        return TallyConnector._collection_request_xml(
            "TSSGroupColl", "Group",
            ["NAME", "PARENT", "ALTERID", "ISREVENUE", "ISDEEMEDPOSITIVE"],
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
        mobile: Optional[str] = None,
        email: Optional[str] = None,
        pan: Optional[str] = None,
        address: Optional[str] = None,
        state: Optional[str] = None,
        pincode: Optional[str] = None,
        credit_limit: Optional[float] = None,
        action: str = "Create",
    ) -> str:
        """IMPORT: create OR alter a Ledger master with the FULL party record.

        ``action`` is "Create" for a new ledger or "Alter" to update an existing
        one (cloud edit re-push) — Tally matches the existing master by NAME.

        Tally tags used inside <LEDGER>:
            <NAME> <PARENT> <OPENINGBALANCE> <PARTYGSTIN> <GSTREGISTRATIONTYPE>
            <LEDGERMOBILE> <EMAIL> <INCOMETAXNUMBER> (PAN) <LEDSTATENAME>
            <PINCODE> <CREDITLIMIT> + <ADDRESS.LIST><ADDRESS> lines.

        Pass ``company`` to import into that specific loaded company
        (SVCURRENTCOMPANY inside REQUESTDESC); omit it for the active company.
        """
        name_e = self._esc(name)

        def _tag(tag: str, val: Any) -> str:
            return ("<" + tag + ">" + self._esc(val) + "</" + tag + ">") if (val not in (None, "")) else ""

        gstin_block = ""
        if gstin:
            gstin_block = (
                "<PARTYGSTIN>" + self._esc(gstin) + "</PARTYGSTIN>"
                "<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>"
            )
        # Multi-line address → <ADDRESS.LIST> of <ADDRESS> entries.
        addr_block = ""
        if address:
            lines = [ln for ln in str(address).replace("\r", "").split("\n") if ln.strip()]
            if lines:
                addr_block = ("<ADDRESS.LIST TYPE=\"String\">"
                              + "".join("<ADDRESS>" + self._esc(ln) + "</ADDRESS>" for ln in lines)
                              + "</ADDRESS.LIST>")
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            + self._import_requestdesc("All Masters", company) +
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<LEDGER NAME="' + name_e + '" ACTION="' + (action or "Create") + '">'
            "<NAME>" + name_e + "</NAME>"
            "<PARENT>" + self._esc(parent) + "</PARENT>"
            "<OPENINGBALANCE>" + self._esc(opening) + "</OPENINGBALANCE>"
            + gstin_block
            + _tag("LEDGERMOBILE", mobile)
            + _tag("EMAIL", email)
            + _tag("INCOMETAXNUMBER", pan)
            + _tag("LEDSTATENAME", state)
            + _tag("PINCODE", pincode)
            + (_tag("CREDITLIMIT", credit_limit) if credit_limit not in (None, "", 0) else "")
            + addr_block +
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
        action: str = "Create",
    ) -> str:
        """IMPORT: create or alter a Stock Item master.

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
            '<STOCKITEM NAME="' + name_e + '" ACTION="' + (action or "Create") + '">'
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
        mailing_name: Optional[str] = None,
        email: Optional[str] = None,
        phone: Optional[str] = None,
        mobile: Optional[str] = None,
        gst: Optional[str] = None,
        pan: Optional[str] = None,
        state: Optional[str] = None,
        pincode: Optional[str] = None,
        country: Optional[str] = None,
        address: Optional[str] = None,
        action: str = "Create",
    ) -> str:
        """IMPORT: create OR alter a COMPANY master in Tally with the FULL record.

        Tags inside <COMPANY>: <NAME> <MAILINGNAME> <STARTINGFROM> <BOOKSFROM>
        <ISACCOUNTSONLY> <EMAIL> <PHONENUMBER> <MOBILENUMBERS> <STATENAME>
        <PINCODE> <COUNTRYNAME> <CMPGSTIN> <INCOMETAXNUMBER> + <ADDRESS.LIST>.

        NOTE: Company-creation XML varies across Tally releases; this uses the
        common "All Masters" import shape and may need field tweaks on a live Tally.
        """
        name_e = self._esc(name)
        start = self._esc(fy_from or self._default_fy_start())
        books = self._esc(books_from or fy_from or self._default_fy_start())

        def _tag(tag: str, val: Any) -> str:
            return ("<" + tag + ">" + self._esc(val) + "</" + tag + ">") if (val not in (None, "")) else ""

        addr_block = ""
        if address:
            lines = [ln for ln in str(address).replace("\r", "").split("\n") if ln.strip()]
            if lines:
                addr_block = ("<ADDRESS.LIST TYPE=\"String\">"
                              + "".join("<ADDRESS>" + self._esc(ln) + "</ADDRESS>" for ln in lines)
                              + "</ADDRESS.LIST>")
        return (
            "<ENVELOPE>"
            "<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>"
            "<BODY><IMPORTDATA>"
            "<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>"
            "<REQUESTDATA>"
            '<TALLYMESSAGE xmlns:UDF="TallyUDF">'
            '<COMPANY NAME="' + name_e + '" ACTION="' + (action or "Create") + '">'
            "<NAME>" + name_e + "</NAME>"
            + _tag("MAILINGNAME", mailing_name) +
            "<STARTINGFROM>" + start + "</STARTINGFROM>"
            "<BOOKSFROM>" + books + "</BOOKSFROM>"
            "<ISACCOUNTSONLY>No</ISACCOUNTSONLY>"
            + _tag("EMAIL", email)
            + _tag("PHONENUMBER", phone)
            + _tag("MOBILENUMBERS", mobile)
            + _tag("STATENAME", state)
            + _tag("PINCODE", pincode)
            + _tag("COUNTRYNAME", country)
            + _tag("CMPGSTIN", gst)
            + _tag("INCOMETAXNUMBER", pan)
            + addr_block +
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
        clean = self._sanitize(xml)
        try:
            return ET.fromstring(clean)
        except ET.ParseError as exc:
            # Tally VOUCHER XML carries UDF / custom fields with namespace
            # PREFIXES (e.g. <UDF:SomeField>) that are NEVER declared, so
            # ElementTree raises "unbound prefix" and the whole voucher pull
            # parses to nothing. Strip the prefixes from tags + drop the (unused)
            # xmlns:*/prefixed attrs, then retry. The fields we read
            # (DATE/VOUCHERTYPENAME/VOUCHERNUMBER/PARTYLEDGERNAME/AMOUNT/ALTERID/
            # GUID) are unprefixed, so stripping is lossless for our purposes.
            try:
                return ET.fromstring(self._strip_ns_prefixes(clean))
            except ET.ParseError as exc2:
                self.log.warning("Tally XML parse failed: %s", exc2)
                return None

    @staticmethod
    def _strip_ns_prefixes(xml: str) -> str:
        """Remove undeclared namespace prefixes so ElementTree stops choking on
        Tally's UDF voucher fields. <UDF:Tag>..</UDF:Tag> -> <Tag>..</Tag>; drops
        xmlns:* declarations and any prefixed attributes."""
        # Tag prefixes: <UDF:Tag ...> and </UDF:Tag>.
        xml = re.sub(r"(</?)[A-Za-z_][\w.\-]*:", r"\1", xml)
        # xmlns:prefix="..." declarations (now unused).
        xml = re.sub(r'\s+xmlns:[\w.\-]+\s*=\s*"[^"]*"', "", xml)
        # Prefixed attributes: foo:bar="...".
        xml = re.sub(r'\s+[A-Za-z_][\w.\-]*:[\w.\-]+\s*=\s*"[^"]*"', "", xml)
        return xml

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
