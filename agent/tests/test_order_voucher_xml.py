"""Tests for the shared item-voucher XML builder used by Quotation, Sales
Order, Purchase Order, Delivery Note and Receipt Note.

These five voucher kinds all carry the same shape -- a party, a date and a
list of item lines -- but differ in their Tally voucher TYPE NAME (which is
NOT fixed: a company can rename "Quotation" to anything, or not have it at
all) and in whether they post OPTIONAL (Quotation/Order never book into the
company's actual accounts; ISOPTIONAL marks that). See
tally_connector._inventory_voucher_xml and the Phase 2 stock builders for the
escaping/company-targeting conventions this mirrors.

These tests check the SHAPE of the XML the agent builds, not Tally itself --
Tally is not installed in this environment.

Run: python -m pytest agent/tests/test_order_voucher_xml.py -q
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tally_connector import TallyConnector  # noqa: E402


def _connector():
    return TallyConnector("http://localhost:9000")


def test_the_voucher_type_name_comes_from_the_caller_not_the_code():
    """Quotation's name isn't the same in every company -- it comes from the row."""
    c = _connector()
    xml = c.create_item_voucher_xml(
        "Proforma Quote", "Acme Traders", "20260806",
        items=[{"item": "Widget", "qty": 2, "rate": 100}],
    )
    assert '<VOUCHER VCHTYPE="Proforma Quote"' in xml
    assert "<VOUCHERTYPENAME>Proforma Quote</VOUCHERTYPENAME>" in xml
    # Nothing in the codebase should have hard-coded a fixed name instead.
    assert "Quotation" not in xml


def test_an_optional_voucher_is_marked_optional():
    """A Quotation never books into the company's real accounts -- ISOPTIONAL is that."""
    c = _connector()
    xml = c.create_item_voucher_xml(
        "Quotation", "Acme Traders", "20260806",
        items=[{"item": "Widget", "qty": 2, "rate": 100}],
        is_optional=True,
    )
    assert "<ISOPTIONAL>Yes</ISOPTIONAL>" in xml

    xml_default = c.create_item_voucher_xml(
        "Sales Order", "Acme Traders", "20260806",
        items=[{"item": "Widget", "qty": 2, "rate": 100}],
    )
    assert "<ISOPTIONAL>Yes</ISOPTIONAL>" not in xml_default


def test_every_item_line_carries_name_quantity_and_rate():
    """An incomplete line reaching Tally would build half a voucher."""
    c = _connector()
    xml = c.create_item_voucher_xml(
        "Sales Order", "Acme Traders", "20260806",
        items=[{"item": "Widget", "qty": 3, "rate": 250}],
    )
    assert "<STOCKITEMNAME>Widget</STOCKITEMNAME>" in xml
    assert "3" in xml
    assert "250" in xml


def test_item_and_party_names_are_escaped():
    """'A & B Traders' must not break the XML."""
    c = _connector()
    xml = c.create_item_voucher_xml(
        "Sales Order", "A & B Traders", "20260806",
        items=[{"item": "Nuts & Bolts", "qty": 1, "rate": 50}],
    )
    assert "A & B Traders" not in xml
    assert "A &amp; B Traders" in xml
    assert "Nuts &amp; Bolts" in xml


def test_a_voucher_with_no_usable_line_is_refused():
    """Not one usable line -- the voucher must not be built at all."""
    c = _connector()
    with pytest.raises(ValueError):
        c.create_item_voucher_xml(
            "Sales Order", "Acme Traders", "20260806",
            items=[{"item": "", "qty": 1, "rate": 100}],
        )
    with pytest.raises(ValueError):
        c.create_item_voucher_xml(
            "Sales Order", "Acme Traders", "20260806",
            items=[{"item": "Widget", "qty": 0, "rate": 100}],
        )
    with pytest.raises(ValueError):
        c.create_item_voucher_xml(
            "Sales Order", "Acme Traders", "20260806",
            items=[],
        )


def test_the_extra_date_is_included_when_given():
    """Sales Order's due date / Delivery Note's dispatch date."""
    c = _connector()
    xml = c.create_item_voucher_xml(
        "Sales Order", "Acme Traders", "20260806",
        items=[{"item": "Widget", "qty": 1, "rate": 100}],
        extra_date="20260810", extra_date_tag="DUEDATE",
    )
    assert "<DUEDATE>20260810</DUEDATE>" in xml

    xml_none = c.create_item_voucher_xml(
        "Sales Order", "Acme Traders", "20260806",
        items=[{"item": "Widget", "qty": 1, "rate": 100}],
    )
    assert "DUEDATE" not in xml_none


if __name__ == "__main__":
    import unittest
    unittest.main()
