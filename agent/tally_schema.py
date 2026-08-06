"""Declarative registry of every Tally MASTER collection the agent pulls.

Before this, each master had its own hand-written request builder and parser in
tally_connector.py — which is why only five ever existed: adding the sixth meant
writing three more functions. Here a master is DATA:

    MasterSpec(kind="unit", collection_type="Unit", table="tally_units",
               fields={"original_name": "ORIGINALNAME", ...})

and `TallyConnector.fetch_master(kind)` turns it into a request, a parse and a
list of dicts. The cloud's /agent/import receives them under `masters` keyed by
`kind`, and writes each to `table` — so a new master needs ONE entry here plus a
column set in a tenant migration, and nothing else.

Field mapping notes
-------------------
* ``fields`` maps cloud column -> Tally tag. The tag is looked up with a
  DESCENDING search (Tally nests inconsistently across builds), except the
  identity tags GUID/MASTERID/ALTERID which are always read from the object
  itself — see TallyConnector._guid / _masterid.
* A tuple of tags means "first non-empty wins" (Tally renamed several tags
  between releases, and both spellings are still in the wild).
* ``bools`` / ``numbers`` / ``dates`` declare the coercion; everything else
  stays a trimmed string. Tally answers "Yes"/"No", "187.96/pair" and
  "20260401" respectively, so the coercion cannot be inferred from the value.
* ``requires_feature`` names an F11 flag (from the company master). A company
  with payroll switched off has no Employee collection at all, and asking for
  one wastes a round trip per cycle and logs a scary-looking empty result.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass(frozen=True)
class MasterSpec:
    kind: str                       # stable key used on the wire + in the cloud
    collection_type: str            # Tally TDL collection TYPE
    table: str                      # destination table in the tenant db
    fields: dict[str, Any] = field(default_factory=dict)
    bools: frozenset[str] = frozenset()
    numbers: frozenset[str] = frozenset()
    dates: frozenset[str] = frozenset()
    requires_feature: Optional[str] = None
    # How to treat requires_feature when Tally does NOT report the flag.
    #
    # False (the default) — ask anyway. Right for a harmless master: an absent
    # flag usually means this Tally build did not report it, and guessing "off"
    # would silently drop data the company really uses.
    #
    # True — do NOT ask. Reserved for object types whose ABSENCE crashes
    # TallyPrime rather than returning nothing ("Internal Error … Incorrect
    # Object Type!", connection dropped mid-answer). For those the cost of a
    # wrong guess is not a missing table, it is the customer's accounting
    # software falling over, so silence has to mean no.
    feature_must_be_on: bool = False

    @property
    def fetch_list(self) -> list[str]:
        """The <FETCH> tags: identity + every mapped tag, de-duplicated."""
        tags = ["NAME", "GUID", "MASTERID", "ALTERID"]
        for tag in self.fields.values():
            for t in (tag if isinstance(tag, tuple) else (tag,)):
                if t not in tags:
                    tags.append(t)
        return tags


# ── The registry ──────────────────────────────────────────────────────────
# Ordered cheapest/most-depended-upon first: units and groups are tiny and are
# what items and ledgers point at, so a partial sync still leaves the cloud
# self-consistent.
MASTERS: tuple[MasterSpec, ...] = (
    MasterSpec(
        kind="unit", collection_type="Unit", table="tally_units",
        fields={
            "original_name": "ORIGINALNAME",
            "is_simple": "ISSIMPLEUNIT",
            "base_units": "BASEUNITS",
            "additional_units": "ADDITIONALUNITS",
            "conversion": "CONVERSION",
            "decimal_places": "DECIMALPLACES",
        },
        bools=frozenset({"is_simple"}),
        numbers=frozenset({"conversion", "decimal_places"}),
    ),
    MasterSpec(
        kind="stock_group", collection_type="StockGroup", table="tally_stock_groups",
        fields={"parent": "PARENT", "is_addable": "ISADDABLE"},
        bools=frozenset({"is_addable"}),
    ),
    MasterSpec(
        kind="stock_category", collection_type="StockCategory", table="tally_stock_categories",
        fields={"parent": "PARENT"},
    ),
    MasterSpec(
        kind="cost_category", collection_type="CostCategory", table="tally_cost_categories",
        fields={
            "allocate_revenue": "ALLOCATEREVENUE",
            "allocate_non_revenue": "ALLOCATENONREVENUE",
        },
        bools=frozenset({"allocate_revenue", "allocate_non_revenue"}),
        requires_feature="ISCOSTCENTRESON",
    ),
    MasterSpec(
        kind="cost_centre", collection_type="CostCentre", table="tally_cost_centres",
        fields={"parent": "PARENT", "category": "CATEGORY"},
        requires_feature="ISCOSTCENTRESON",
    ),
    MasterSpec(
        kind="currency", collection_type="Currency", table="tally_currencies",
        fields={
            # For a Currency, Tally puts the SYMBOL in NAME and the readable
            # name in ORIGINALNAME — the opposite of every other master.
            "symbol": "NAME",
            "formal_name": ("ORIGINALNAME", "FORMALNAME"),
            "mailing_name": "MAILINGNAME",
            "decimal_places": "DECIMALPLACES",
            "is_suffixed": "ISSUFFIXED",
            "has_space": "HASSPACE",
            "decimal_symbol": "DECIMALSYMBOL",
        },
        bools=frozenset({"is_suffixed", "has_space"}),
        numbers=frozenset({"decimal_places"}),
    ),
    MasterSpec(
        kind="voucher_type", collection_type="VoucherType", table="tally_voucher_types",
        fields={
            "parent": "PARENT",
            "numbering_method": "NUMBERINGMETHOD",
            "is_deemed_positive": "ISDEEMEDPOSITIVE",
            "affects_stock": "AFFECTSSTOCK",
            "use_for_pos": "USEFORPOS",
            "is_active": "ISACTIVE",
        },
        bools=frozenset({"is_deemed_positive", "affects_stock", "use_for_pos", "is_active"}),
    ),
    MasterSpec(
        kind="stock_item_full", collection_type="StockItem", table="tally_stock_items",
        fields={
            "parent": "PARENT",
            "category": "CATEGORY",
            "base_units": "BASEUNITS",
            "additional_units": "ADDITIONALUNITS",
            "hsn_code": ("GSTHSNCODE", "HSNCODE"),
            "gst_rate": "GSTRATE",
            "costing_method": "COSTINGMETHOD",
            "valuation_method": "VALUATIONMETHOD",
            "is_batchwise": "ISBATCHWISEON",
            "has_mfg_date": "HASMFGDATE",
            "is_perishable": "ISPERISHABLEON",
            "is_cost_tracking": "ISCOSTTRACKINGON",
            "reorder_level": "REORDERLEVEL",
            "minimum_order_qty": "MINIMUMORDERQTY",
            "opening_qty": "OPENINGBALANCE",
            "opening_rate": "OPENINGRATE",
            "opening_value": "OPENINGVALUE",
            "closing_qty": "CLOSINGBALANCE",
            "closing_rate": "CLOSINGRATE",
            "closing_value": "CLOSINGVALUE",
            "standard_price": "STANDARDPRICE",
            "standard_cost": "STANDARDCOST",
        },
        bools=frozenset({"is_batchwise", "has_mfg_date", "is_perishable", "is_cost_tracking"}),
        numbers=frozenset({
            "gst_rate", "reorder_level", "minimum_order_qty",
            "opening_qty", "opening_rate", "opening_value",
            "closing_qty", "closing_rate", "closing_value",
            "standard_price", "standard_cost",
        }),
        requires_feature="ISINVENTORYON",
    ),
    # Godowns are NOT here: they already flow through godown_list() -> locations,
    # and pulling them twice would just race two writers at the same rows.
    # PRICE LEVELS are deliberately NOT here. "PriceLevel" is not a Tally object
    # type — price levels are a list on the company — and asking for a type that
    # does not exist does not fail cleanly: on a real customer build it hung the
    # request for six minutes, then Tally showed "Internal Error. Contact Tally
    # Solutions. Incorrect Object Type!" and CLOSED. Since fetch_all_masters runs
    # early in the pull, that cost the company every later master, every voucher
    # and every report — once a minute, forever.
    # Nothing is lost by dropping it: each price level's name already reaches the
    # cloud on the stock item that uses it (the price_list block parsed in
    # tally_connector), which is also the only place the figure means anything.
    MasterSpec(
        kind="budget", collection_type="Budget", table="tally_budgets",
        fields={"parent": "PARENT", "period_from": "BUDGETPERIODFROM",
                "period_to": "BUDGETPERIODTO"},
        dates=frozenset({"period_from", "period_to"}),
    ),
    # A GST TAX UNIT is the registration a return is actually filed under — one
    # company with branches in three states files three sets of GSTR, one per
    # tax unit. Every GST report has to be scoped to one; without this master
    # they silently aggregate across registrations, which is the wrong number
    # on every screen for any multi-state company.
    MasterSpec(
        kind="tax_unit", collection_type="TaxUnit", table="tally_tax_units",
        fields={
            "gstin": ("GSTIN", "PARTYGSTIN"),
            "state": ("STATENAME", "PLACEOFSUPPLY"),
            "registration_type": "GSTREGISTRATIONTYPE",
            "applicable_from": "APPLICABLEFROM",
            "is_default": "ISDEFAULT",
        },
        bools=frozenset({"is_default"}),
        dates=frozenset({"applicable_from"}),
        requires_feature="ISGSTON",
    ),
    MasterSpec(
        kind="gst_classification", collection_type="GSTClassification",
        table="tally_gst_classifications",
        fields={"hsn_code": ("GSTHSNCODE", "HSNCODE"), "rate": "GSTRATE",
                "taxability": "TAXABILITY", "applicable_from": "APPLICABLEFROM"},
        numbers=frozenset({"rate"}), dates=frozenset({"applicable_from"}),
        requires_feature="ISGSTON",
    ),
    # ── TDS / TCS. GATED, and the gate is not a nicety. A company with TDS
    #    switched off has no TDSCategory object at all, and asking for a
    #    collection of a type the company does not have does not return empty —
    #    TallyPrime raises "Internal Error … Incorrect Object Type!" in a modal
    #    box and drops the connection mid-answer, taking the whole cycle with
    #    it. The flag is read from the company itself (see company_details). ──
    MasterSpec(
        kind="tds_category", collection_type="TDSCategory", table="tally_tds_categories",
        fields={"section_number": "SECTIONNUMBER", "payment_code": "PAYMENTCODE"},
        requires_feature="ISTDSON", feature_must_be_on=True,
    ),
    # A TDS CATEGORY is the section ("194C — Contractors"); the RATE is a separate
    # master holding the percentage actually applied, which varies by deductee
    # type (company/individual), by threshold and by effective date. Without it
    # the cloud knows a payment was under 194C but cannot say what should have
    # been deducted, so no TDS figure can be verified against Tally's.
    MasterSpec(
        kind="tds_rate", collection_type="TDSRate", table="tally_tds_rates",
        fields={
            "category": ("TDSCATEGORY", "PARENT"),
            "deductee_type": "DEDUCTEETYPE",
            "applicable_from": "APPLICABLEFROM",
            "rate": "TDSRATE",
            "surcharge": "TDSSURCHARGE",
            "cess": "TDSCESS",
            "zero_rate_reason": "ZEROTDSREASON",
            "exemption_limit": "EXEMPTIONLIMIT",
        },
        numbers=frozenset({"rate", "surcharge", "cess", "exemption_limit"}),
        dates=frozenset({"applicable_from"}),
        requires_feature="ISTDSON", feature_must_be_on=True,
    ),
    MasterSpec(
        kind="tcs_category", collection_type="TCSCategory", table="tally_tcs_categories",
        fields={"section_number": "SECTIONNUMBER", "rate": "TCSRATE"},
        numbers=frozenset({"rate"}),
        requires_feature="ISTCSON", feature_must_be_on=True,
    ),
    # ── Payroll. All gated on the F11 payroll flag: a company without payroll
    #    has none of these collections. ──
    MasterSpec(
        kind="employee_group", collection_type="EmployeeGroup", table="tally_employee_groups",
        fields={"parent": "PARENT"}, requires_feature="ISPAYROLLON",
    ),
    MasterSpec(
        kind="employee", collection_type="Employee", table="tally_employees",
        fields={
            "parent": "PARENT",
            "employee_code": "EMPLOYEENUMBER",
            "designation": "DESIGNATION",
            "date_of_joining": "JOININGDATE",
            "date_of_release": "DATEOFRELEASE",
            "bank_name": "BANKNAME",
            "bank_account_no": "ACCOUNTNUMBER",
            "ifsc": "IFSCODE",
            "pan_number": "INCOMETAXNUMBER",
            "pf_account": "PFACCOUNTNUMBER",
            "esi_number": "ESINUMBER",
        },
        dates=frozenset({"date_of_joining", "date_of_release"}),
        requires_feature="ISPAYROLLON",
    ),
    MasterSpec(
        kind="attendance_type", collection_type="AttendanceType", table="tally_attendance_types",
        fields={"parent": "PARENT", "attendance_period": "ATTENDANCEPERIOD",
                "production_type": "ATTENDANCETYPE"},
        requires_feature="ISPAYROLLON",
    ),
    MasterSpec(
        kind="pay_head", collection_type="PayHead", table="tally_pay_heads",
        fields={"parent": "PARENT", "pay_head_type": "PAYHEADTYPE",
                "calculation_type": "CALCTYPE", "calculation_period": "CALCPERIOD",
                "affects_net_salary": "AFFECTSNETSALARY"},
        bools=frozenset({"affects_net_salary"}),
        requires_feature="ISPAYROLLON",
    ),
)

BY_KIND: dict[str, MasterSpec] = {m.kind: m for m in MASTERS}


# ── Voucher types ─────────────────────────────────────────────────────────
# Tally's RESERVED base voucher types — the full set, not just the accounting
# ones. This matters: a single unfiltered ``TYPE=Voucher`` collection does NOT
# reliably return the order and inventory-only vouchers (Sales Order, Delivery
# Note, Stock Journal, Job Work, Material In/Out …), which is why a generic pull
# can look complete while silently missing whole categories of document.
#
# Every company-defined type inherits from one of these via PARENT — "RETAIL
# CASH SALES" has PARENT "Sales" — so pulling per type covers custom types too,
# as long as we enumerate the company's OWN types (tally_voucher_types) and fall
# back to this list before that master has ever synced.
RESERVED_VOUCHER_TYPES: tuple[str, ...] = (
    # Accounting
    "Sales", "Purchase", "Receipt", "Payment", "Contra", "Journal",
    "Credit Note", "Debit Note",
    "Reversing Journal", "Memorandum",
    # Inventory movement
    "Delivery Note", "Receipt Note", "Rejections In", "Rejections Out",
    "Stock Journal", "Physical Stock",
    "Material In", "Material Out",
    # Orders
    "Sales Order", "Purchase Order", "Job Work In Order", "Job Work Out Order",
    # Payroll
    "Payroll", "Attendance",
)
