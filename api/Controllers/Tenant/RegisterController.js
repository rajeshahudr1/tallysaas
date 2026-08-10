'use strict';

/**
 * Controllers/Tenant/RegisterController.js
 *
 * The grouped register (`GET /<module>/grouped`) for every voucher family
 * that is NOT sales/purchase invoices — those keep their own handler in
 * InvoiceController because they also carry the Tally register snapshot.
 *
 * Each family is one config; the SQL lives in Helpers/voucherRegister so the
 * families cannot drift apart.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { groupedRegister } = require('../../Helpers/voucherRegister');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

/**
 * Credit / Debit notes live in `invoices` as a voucher TYPE, so they filter
 * on tally_voucher_type rather than on a table of their own. They carry no
 * `returnType` — a return register has nothing further to net off, so it
 * shows no Gross/Net toggle.
 */
const REGISTERS = {
    'credit-notes': {
        table: 'invoices', dateCol: 'invoice_date', amountCol: 'total',
        partyCol: 'customer_id', partyTable: 'customers',
        itemsTable: 'invoice_items', itemsFk: 'invoice_id',
        where: { type: 'sales', tally_voucher_type: 'Credit Note' },
        defaultType: 'Credit Note', approvalGate: true, tallyInventory: true,
        // Tally signs an inventory line by stock direction. A credit note is
        // goods coming BACK IN, so Tally writes it negative — but a Credit
        // Note register reports the VALUE RETURNED, which reads positive.
        tallyAmountSign: -1,
    },
    'debit-notes': {
        table: 'invoices', dateCol: 'invoice_date', amountCol: 'total',
        partyCol: 'supplier_id', partyTable: 'suppliers',
        itemsTable: 'invoice_items', itemsFk: 'invoice_id',
        where: { type: 'purchase', tally_voucher_type: 'Debit Note' },
        defaultType: 'Debit Note', approvalGate: true, tallyInventory: true,
        // A debit note is goods going back OUT, which Tally already writes
        // positive — the opposite of the purchase register it sits beside.
        tallyAmountSign: 1,
    },
    'sales-orders': {
        table: 'sales_orders', dateCol: 'order_date', amountCol: 'total',
        partyCol: 'customer_id', partyTable: 'customers', ledgerNameCol: 'ledger_name',
        itemsTable: 'sales_order_items', itemsFk: 'sales_order_id',
        defaultType: 'Sales Order',
    },
    'purchase-orders': {
        table: 'purchase_orders', dateCol: 'order_date', amountCol: 'total',
        partyCol: 'supplier_id', partyTable: 'suppliers', ledgerNameCol: 'ledger_name',
        itemsTable: 'purchase_order_items', itemsFk: 'purchase_order_id',
        defaultType: 'Purchase Order',
    },
    'delivery-notes': {
        table: 'delivery_notes', dateCol: 'note_date', amountCol: 'total',
        partyCol: 'customer_id', partyTable: 'customers', ledgerNameCol: 'ledger_name',
        itemsTable: 'delivery_note_items', itemsFk: 'delivery_note_id',
        defaultType: 'Delivery Note',
    },
    'receipt-notes': {
        table: 'receipt_notes', dateCol: 'note_date', amountCol: 'total',
        partyCol: 'supplier_id', partyTable: 'suppliers', ledgerNameCol: 'ledger_name',
        itemsTable: 'receipt_note_items', itemsFk: 'receipt_note_id',
        defaultType: 'Receipt Note',
    },
    // Receipts and payments have no inventory, so they offer only the three
    // header groupings — the same set LiveKeeping shows for them.
    receipts: {
        table: 'payments', dateCol: 'payment_date', amountCol: 'amount',
        partyCol: 'customer_id', partyTable: 'customers',
        where: { type: 'receipt' }, defaultType: 'Receipt',
        // `payments` has neither a voucher-type nor a location column: the
        // type comes from the synced voucher header, and the register is
        // company-wide.
        typeCol: null, locationCol: false,
    },
    payments: {
        table: 'payments', dateCol: 'payment_date', amountCol: 'amount',
        partyCol: 'supplier_id', partyTable: 'suppliers',
        where: { type: 'payment' }, defaultType: 'Payment',
        typeCol: null, locationCol: false,
    },
};

/** Express handler factory — one per module key. */
function grouped(moduleKey) {
    const cfg = REGISTERS[moduleKey];
    if (!cfg) throw new Error(`No register config for "${moduleKey}"`);
    return async function handler(req, res) {
        try {
            const { rows, meta } = await groupedRegister(db, req, cfg);
            return R.successResponse(res, { data: rows, meta });
        } catch (err) {
            if (err && err.status === 422) return R.errorResponse(res, err.message, 422);
            console.error(`register.grouped(${moduleKey}) error:`, err);
            return R.errorResponse(res, OOPS_MSG, 500);
        }
    };
}

module.exports = { REGISTERS, grouped };
