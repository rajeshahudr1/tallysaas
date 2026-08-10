'use strict';

/**
 * web/tests/voucherFormsRender.test.js
 *
 * All six voucher create screens must actually RENDER the controls the shared
 * voucher-extras.js looks up: the Price Level picker, the party's closing
 * balance line, and the Buyer/Consignee/Dispatch/Order block. A missing id
 * here is silent — the JS just finds nothing and the feature quietly is not
 * there — which is exactly how the Price Level column went missing on five of
 * the six forms in the first place.
 *
 * These render the real templates with realistic locals; nothing is mocked
 * except the data, so a broken include or a renamed id fails the test.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');

// The id prefix each screen uses for its DOM contract.
const FORMS = {
    'quotations': 'q',
    'sales-orders': 'so',
    'purchase-orders': 'po',
    'delivery-notes': 'dn',
    'receipt-notes': 'rn',
    'return-notes': 'cn',
};

const PARTY = {
    id: 1, name: 'ACME Traders', closing_balance: 23003,
    gst_number: '24AAAAA0000A1Z5', gst_registration_type: 'Regular',
    billing_address: 'Ring Road', country: 'India', state: 'Gujarat', pincode: '380001',
};

function locals() {
    return {
        title: 'Create', activeMenu: 'x', breadcrumb: [], pageScript: '',
        user: { name: 'Tester', role_slug: 'company-admin' },
        csrfToken: 'test', flash: null, menuTree: [], currentPath: '/',

        locationOptions: [{ id: 1, name: 'Main', is_tally_godown: true }],
        salesPersonOptions: [{ id: 1, name: 'Ravi' }],
        godownOptions: [{ id: 1, name: 'Main Location' }],
        unitOptions: ['PRS', 'NOS'],

        invoiceProducts: [{ id: 1, name: 'SHOE A', hsn: '6403', unit: 'PRS', rate: 500, gst: 5, stock: 12 }],
        returnNoteProducts: [{ id: 1, name: 'SHOE A', hsn: '6403', unit: 'PRS', rate: 500, gst: 5, stock: 3 }],

        customerOptions: [PARTY],
        supplierOptions: [{ id: 2, name: 'VENDOR', closing_balance: -5000, gst_number: '24BBBBB0000B1Z5', address: 'Lane 2' }],
        partyOptions: [PARTY],

        salesLedgerOptions: [{ id: 1, name: 'Sales', parent: 'Sales Accounts' }],
        purchaseLedgerOptions: [{ id: 1, name: 'Purchase', parent: 'Purchase Accounts' }],
        ledgerOptions: [{ id: 1, name: 'Sales', parent: 'Sales Accounts' }],
        ledgerGroupOptions: ['Sundry Debtors'],
        billOptions: [], salesOrderOptions: [], purchaseOrderOptions: [],

        gstStates: ['Gujarat'], gstRegistrationTypes: ['Regular', 'Composition'],
        // Two rate cards, so "was the picker rendered AND populated" is
        // distinguishable from "the picker exists but is empty".
        priceLevelOptions: [{ name: 'Wholesale' }, { name: 'Retail' }],

        kind: 'credit',
        nextQuotationNo: 'AUTO', nextSalesOrderNo: 'AUTO', nextPurchaseOrderNo: 'AUTO',
        nextDeliveryNoteNo: 'AUTO', nextReceiptNoteNo: 'AUTO', nextReturnNoteNo: 'AUTO',
    };
}

function render(view) {
    return ejs.renderFile(path.join(__dirname, '..', 'views', view, 'create.ejs'), locals(), { async: false });
}

for (const [view, p] of Object.entries(FORMS)) {
    test(`${view}: renders the Price Level picker, populated`, async () => {
        const html = await render(view);
        assert.match(html, new RegExp(`id="${p}-price-level"`), 'Price Level select missing');
        assert.match(html, />Wholesale</, 'rate cards not listed in the picker');
        assert.match(html, />Standard rate</, 'no way back to the item\'s own price');
    });

    test(`${view}: renders the party closing-balance line`, async () => {
        const html = await render(view);
        assert.match(html, new RegExp(`id="${p}-party-balance"`), 'balance line missing');
    });

    test(`${view}: renders the print-detail block and its hidden input`, async () => {
        const html = await render(view);
        // 26 fields across buyer / consignee / dispatch / order.
        const fields = html.match(new RegExp(`class="[^"]*${p}-vd`, 'g')) || [];
        assert.equal(fields.length, 26, `expected 26 detail fields, got ${fields.length}`);
        assert.match(html, new RegExp(`id="${p}-voucher-details"`), 'hidden voucher_details input missing');
        assert.match(html, new RegExp(`id="${p}-consignee-copy"`), '"Same as buyer" button missing');
        // The block posts as ONE object, not 26 loose columns.
        assert.match(html, /name="voucher_details_json"/);
    });
}

for (const [view, p] of Object.entries(FORMS)) {
    test(`${view}: Godown suggests the real godowns and prefills the only one`, async () => {
        const html = await render(view);
        assert.match(html, new RegExp(`id="${p}-godown-options"`), 'godown datalist missing');
        // The single godown in these locals is a Tally godown, so a new line
        // should start there rather than blank.
        assert.match(html, new RegExp(`class="${p}-godown"[^>]*value="Main"`),
            'single godown was not prefilled onto the line');
    });

    test(`${view}: the Unit box is editable, with the units in use suggested`, async () => {
        const html = await render(view);
        assert.match(html, new RegExp(`id="${p}-unit-options"`), 'unit datalist missing');
        // A read-only unit cannot be fixed when Tally's item master has none,
        // which leaves the printed line with no unit at all.
        assert.ok(!new RegExp(`class="${p}-unit" readonly`).test(html), 'Unit box is still read-only');
    });
}

test('a plain cloud location is never offered as a godown', async () => {
    // Stock sits in a Tally GODOWN. A cloud location that is not one would be
    // accepted by the form and rejected by Tally on sync.
    const l = locals();
    l.locationOptions = [{ id: 1, name: 'Head Office', is_tally_godown: false }];
    const html = await ejs.renderFile(
        path.join(__dirname, '..', 'views', 'quotations', 'create.ejs'), l, { async: false });
    const list = html.slice(html.indexOf('id="q-godown-options"'));
    assert.ok(!/Head Office/.test(list.slice(0, 300)), 'a non-godown location was offered');
});

test('the Price Level picker is omitted, not empty, when the company uses none', async () => {
    // A dead control is worse than no control: it says "you can pick a rate
    // card" to a company that has none.
    const l = locals();
    l.priceLevelOptions = [];
    const html = await ejs.renderFile(
        path.join(__dirname, '..', 'views', 'quotations', 'create.ejs'), l, { async: false });
    assert.ok(!/id="q-price-level"/.test(html), 'empty picker was rendered anyway');
});
