"""Tests for the Stock Journal / Physical Stock XML builders.

Stock Journal and Physical Stock are GOODS vouchers: no ledger, no GST, no
money total. A Stock Journal moves goods (source lines decrease stock at one
godown, destination lines increase it at another); a Physical Stock voucher
asserts an ABSOLUTE counted quantity, not a delta. Every line of either needs
an item name, a godown and a quantity -- a line missing any of those must
refuse the whole voucher rather than send it half-formed (see
tally_connector._inventory_voucher_xml for the escaping/company-targeting
conventions this mirrors).

These tests check the SHAPE of the XML the agent builds, not Tally itself --
Tally is not installed in this environment.

Run: python -m pytest agent/tests/test_stock_voucher_xml.py -q
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tally_connector import TallyConnector  # noqa: E402


def _connector():
    return TallyConnector("http://localhost:9000")


def test_stock_journal_xml_has_both_sides():
    """Source lines decrease stock, destination lines increase it -- both must
    appear in the XML."""
    c = _connector()
    xml = c.create_stock_journal_xml(
        "SJ-2026-0001", "20260806",
        source_items=[{"item": "Raw Widget", "godown": "Main Store", "qty": 5}],
        destination_items=[{"item": "Finished Widget", "godown": "Main Store", "qty": 5}],
        narration="Assembly",
    )
    assert "Raw Widget" in xml
    assert "Finished Widget" in xml
    assert "Stock Journal" in xml
    assert "<VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME>" in xml


def test_stock_journal_xml_names_the_godown_for_every_line():
    """Without a godown Tally cannot decide where to remove stock from."""
    c = _connector()
    xml = c.create_stock_journal_xml(
        "SJ-2026-0002", "20260806",
        source_items=[{"item": "Raw Widget", "godown": "Main Store", "qty": 2}],
        destination_items=[{"item": "Finished Widget", "godown": "Assembly Bay", "qty": 2}],
        narration="",
    )
    assert "Main Store" in xml
    assert "Assembly Bay" in xml
    assert xml.count("<GODOWNNAME>") >= 2


def test_stock_journal_xml_escapes_item_names():
    """Names like 'A & B' must not break the XML."""
    c = _connector()
    xml = c.create_stock_journal_xml(
        "SJ-2026-0003", "20260806",
        source_items=[{"item": "A & B Raw", "godown": "Main & Sub", "qty": 1}],
        destination_items=[{"item": "A & B Finished", "godown": "Main Store", "qty": 1}],
        narration="Job & Batch",
    )
    assert "A & B Raw" not in xml
    assert "A &amp; B Raw" in xml
    assert "Main &amp; Sub" in xml
    assert "Job &amp; Batch" in xml


def test_physical_stock_xml_sets_the_counted_quantity():
    """The counted quantity goes in verbatim -- no delta math."""
    c = _connector()
    xml = c.create_physical_stock_xml(
        "PS-2026-0001", "20260806",
        items=[{"item": "Widget", "godown": "Main Store", "qty": 42}],
        narration="Monthly count",
    )
    assert "Physical Stock" in xml
    assert "<VOUCHERTYPENAME>Physical Stock</VOUCHERTYPENAME>" in xml
    assert "Widget" in xml
    assert "42" in xml


def test_a_line_without_an_item_or_quantity_is_refused():
    """An incomplete line must refuse the WHOLE voucher, not build it half-formed."""
    c = _connector()
    with pytest.raises(ValueError):
        c.create_stock_journal_xml(
            "SJ-2026-0004", "20260806",
            source_items=[{"item": "", "godown": "Main Store", "qty": 1}],
            destination_items=[{"item": "Finished", "godown": "Main Store", "qty": 1}],
            narration="",
        )
    with pytest.raises(ValueError):
        c.create_stock_journal_xml(
            "SJ-2026-0005", "20260806",
            source_items=[{"item": "Raw", "godown": "", "qty": 1}],
            destination_items=[{"item": "Finished", "godown": "Main Store", "qty": 1}],
            narration="",
        )
    with pytest.raises(ValueError):
        c.create_stock_journal_xml(
            "SJ-2026-0006", "20260806",
            source_items=[{"item": "Raw", "godown": "Main Store", "qty": 0}],
            destination_items=[{"item": "Finished", "godown": "Main Store", "qty": 1}],
            narration="",
        )
    with pytest.raises(ValueError):
        c.create_physical_stock_xml(
            "PS-2026-0002", "20260806",
            items=[{"item": "Widget", "godown": "", "qty": 5}],
            narration="",
        )
    with pytest.raises(ValueError):
        c.create_physical_stock_xml(
            "PS-2026-0003", "20260806",
            items=[{"item": "", "godown": "Main Store", "qty": 5}],
            narration="",
        )


if __name__ == "__main__":
    import unittest
    unittest.main()
