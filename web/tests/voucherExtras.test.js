'use strict';

/**
 * web/tests/voucherExtras.test.js
 *
 * voucher-extras.js drives the Price Level rate card, the party balance line
 * and the print-detail block on ALL SIX voucher create screens, so a mistake
 * here is a mistake six times over. The quantity-slab lookup in particular
 * decides what money goes on the line.
 *
 * The module is a browser IIFE that hangs its exports off `window`, so it is
 * loaded here into a minimal fake window rather than through require().
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadVoucherExtras() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'voucher-extras.js'), 'utf8');
    const win = {};
    // `document`/`fetch` are only touched by init(), which these tests do not
    // call — the pure helpers below need neither.
    const sandbox = { window: win, document: undefined, fetch: undefined, Map, Number, String, Object, Math };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return win.VoucherExtras;
}

const VX = loadVoucherExtras();

test('slabRate picks the band the quantity falls in', () => {
    const slabs = [
        { from_qty: 1, to_qty: 99, rate: 100 },
        { from_qty: 100, to_qty: null, rate: 90 },
    ];
    assert.equal(VX.slabRate(slabs, 5).rate, 100);
    assert.equal(VX.slabRate(slabs, 99).rate, 100);
    // 100 is the first quantity that earns the bulk rate — an off-by-one here
    // silently overcharges the one order that just qualified.
    assert.equal(VX.slabRate(slabs, 100).rate, 90);
    assert.equal(VX.slabRate(slabs, 5000).rate, 90);
});

test('slabRate treats a null bound as open-ended on that side', () => {
    const slabs = [{ from_qty: null, to_qty: 10, rate: 50 }];
    assert.equal(VX.slabRate(slabs, 0).rate, 50);
    assert.equal(VX.slabRate(slabs, 10).rate, 50);
});

test('slabRate falls back to the first slab when nothing matches', () => {
    // A level with one un-banded rate must still apply before any quantity is
    // typed — the common case, and the one that would otherwise price at the
    // standard rate while the header claims a level is active.
    const slabs = [{ from_qty: 5, to_qty: 10, rate: 42 }];
    assert.equal(VX.slabRate(slabs, 1).rate, 42);
});

test('slabRate says nothing when the level has no slabs for the item', () => {
    assert.equal(VX.slabRate(null, 1), null);
    assert.equal(VX.slabRate([], 1), null);
});

test('drCr prints the side, not a minus sign', () => {
    // "₹-23,003.00" reads like a bug; "₹23,003.00 Dr" reads like money owed.
    assert.match(VX.drCr(23003), /^₹23,003\.00 Dr$/);
    assert.match(VX.drCr(-23003), /^₹23,003\.00 Cr$/);
    assert.match(VX.drCr(0), /^₹0\.00$/);
});

test('ledgerSubLabel shows the group and the GST rate', () => {
    assert.equal(
        VX.ledgerSubLabel({ parent: 'Sales Accounts', tax_type: 'GST', tax_classification: 'GST @ 5%' }),
        'Sales Accounts  ·  GST @ 5%');
});

test('ledgerSubLabel falls back to "GST Applicable" with no rate on file', () => {
    assert.equal(
        VX.ledgerSubLabel({ parent: 'Sales Accounts', tax_type: 'GST' }),
        'Sales Accounts  ·  GST Applicable');
});

test('ledgerSubLabel stays quiet when no tax applies', () => {
    // Tally writes "Others" to mean no tax. "Others Applicable" under every
    // non-taxable ledger would be noise, not information.
    assert.equal(VX.ledgerSubLabel({ parent: 'Sales Accounts', tax_type: 'Others' }), 'Sales Accounts');
    assert.equal(VX.ledgerSubLabel({ parent: 'Sales Accounts' }), 'Sales Accounts');
    assert.equal(VX.ledgerSubLabel(null), '');
});

test('priceLevelRate has no opinion until a card is loaded', () => {
    // No level chosen must leave the item's own price alone rather than
    // zeroing the line.
    assert.equal(VX.priceLevelRate('Anything', 1), null);
});
