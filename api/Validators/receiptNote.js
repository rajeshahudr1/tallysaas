'use strict';

/**
 * api/Validators/receiptNote.js
 *
 * Joi schemas for the receipt-notes resource. Mirrors deliveryNote.js — see
 * that file's header comment for the rationale. Server-managed columns (id,
 * company_id, note_no when blank, all money totals, cgst/sgst/igst,
 * round_off, receipt_status, converted_invoice_id, status, tally_*,
 * created_by, timestamps, deleted_at) are intentionally NOT accepted from
 * the body; the totals are computed by ReceiptNoteController.computeTotals
 * inside the write transaction. NEVER trust client-sent totals —
 * `.unknown(false)` (Joi's default) drops them silently if sent.
 *
 * A receipt note's party is a SUPPLIER (`supplier_id`) — there is no
 * `sales_person_id`; receiving goods is not tied to a salesman.
 *
 * Schemas:
 *   createReceiptNoteSchema — POST/PUT /receipt-notes (supplier_id required)
 *   listReceiptNoteSchema   — GET  /receipt-notes       (pagination + filters)
 */

const Joi = require('joi');

// Reusable optional positive-integer FK.
const fkId = Joi.number().integer().positive();
// Optional FK that also accepts an EXPLICIT null/'' (API clients send
// "location_id": null for "none" — omit-only would 422 on that).
const optFkId = fkId.allow(null, '');

// Reusable optional short/long text — trimmed, blank/null allowed.
const optText = (max) => Joi.string().trim().max(max).allow('', null);

/**
 * A single receipt-note line. The money columns (taxable / gst_amount /
 * amount) are NOT accepted here — the controller computes them
 * authoritatively from quantity / rate / discount_pct / gst_rate /
 * tax_inclusive.
 */
const itemSchema = Joi.object({
    product_id:    fkId.allow(null, ''),
    description:   optText(2000),
    hsn:           optText(20),
    quantity:      Joi.number().greater(0).precision(2).required().messages({
        'number.base':     'Item quantity is required.',
        'number.greater':  'Item quantity must be greater than 0.',
        'any.required':    'Item quantity is required.',
    }),
    unit:          optText(30),
    rate:          Joi.number().min(0).precision(2).required().messages({
        'number.base':  'Item rate is required.',
        'number.min':   'Item rate must be 0 or more.',
        'any.required': 'Item rate is required.',
    }),
    discount_pct:  Joi.number().min(0).max(100).precision(2).default(0),
    gst_rate:      Joi.number().min(0).precision(2).default(0),
    godown:        optText(120),
    tax_inclusive: Joi.boolean().default(false),
});

const itemsArray = Joi.array().items(itemSchema).min(1).required().messages({
    'array.min':    'At least one line item is required.',
    'array.base':   'At least one line item is required.',
    'any.required': 'At least one line item is required.',
});

/**
 * POST /api/v1/receipt-notes (also used for PUT — the shape is the same).
 * `supplier_id` and at least one item are required; `note_no` is optional —
 * the controller generates one when blank. `purchase_order_id` is optional —
 * a receipt note may be received against a purchase order or stand alone.
 */
const createReceiptNoteSchema = Joi.object({
    supplier_id:       fkId.required().messages({
        'any.required':    'Supplier is required.',
        'number.base':     'Supplier is required.',
        'number.positive': 'Supplier is required.',
    }),
    location_id:       optFkId,
    purchase_order_id: optFkId,

    note_no:           optText(60),
    note_date:         Joi.date().iso().allow(null, ''),
    received_date:     Joi.date().iso().allow(null, ''),
    ledger_name:       optText(120),
    notes:             optText(2000),

    items:             itemsArray,
});

/**
 * GET /api/v1/receipt-notes (query string)
 * Pagination + the filters the list handler reads. Param names match
 * listPurchaseOrderSchema (page/per_page/search/date_from/date_to) — the
 * shared web `apiList()` helper only understands those. `receipt_status` is
 * the receipt-note-only lifecycle filter (pending/invoiced/cancelled); it is
 * deliberately NOT named `status` — that name is reserved app-wide for the
 * Tally-sync lifecycle.
 */
const listReceiptNoteSchema = Joi.object({
    page:            Joi.number().integer().min(1).default(1),
    per_page:        Joi.number().integer().min(1).max(100).default(10),
    search:          Joi.string().trim().max(191).allow('', null),
    date_from:       Joi.date().iso().allow('', null),
    date_to:         Joi.date().iso().allow('', null),
    receipt_status:  Joi.string().valid('pending', 'invoiced', 'cancelled', 'all').allow(''),
});

module.exports = {
    createReceiptNoteSchema,
    listReceiptNoteSchema,
};
