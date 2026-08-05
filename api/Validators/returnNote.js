'use strict';

/**
 * api/Validators/returnNote.js
 *
 * Joi schemas for the Credit Note / Debit Note resource
 * (ReturnNoteController). Mirrors deliveryNote.js — see that file's header
 * comment for the rationale. Server-managed columns (id, company_id,
 * invoice_no, type, tally_voucher_type, tally_optional, status, all money
 * totals, cgst/sgst/igst, round_off, approval_status, tally_*, created_by,
 * timestamps, deleted_at) are intentionally NOT accepted from the body; the
 * totals are computed by ReturnNoteController.computeTotals inside the
 * write transaction. NEVER trust client-sent totals — `.unknown(false)`
 * (Joi's default) drops them silently if sent.
 *
 * A note is keyed on customer_id when kind='credit' (mirrors a sales
 * invoice) or supplier_id when kind='debit' (mirrors a purchase invoice) —
 * both are accepted here and the controller picks the one it needs per
 * `kind`, matching InvoiceController.createByType's isSales branching.
 *
 * Schemas:
 *   createReturnNoteSchema — POST/PUT /credit-notes and /debit-notes
 *   listReturnNoteSchema   — GET  /credit-notes and /debit-notes (query)
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
 * A single note line. The money columns (taxable / gst_amount / amount) are
 * NOT accepted here — the controller computes them authoritatively from
 * quantity / rate / discount_pct / gst_rate / tax_inclusive.
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
    tax_inclusive: Joi.boolean().default(false),
});

const itemsArray = Joi.array().items(itemSchema).min(1).required().messages({
    'array.min':    'At least one line item is required.',
    'array.base':   'At least one line item is required.',
    'any.required': 'At least one line item is required.',
});

/**
 * POST /api/v1/credit-notes and /api/v1/debit-notes (also used for PUT — the
 * shape is the same). `customer_id`/`supplier_id` are both optional here —
 * the controller requires whichever one matches `kind` and 422s otherwise,
 * mirroring InvoiceController's per-type required party. `against_invoice_id`
 * is optional — a note may stand alone or reference the bill it corrects.
 */
const createReturnNoteSchema = Joi.object({
    customer_id:        optFkId,
    supplier_id:         optFkId,
    location_id:         optFkId,
    against_invoice_id:  optFkId,

    invoice_date:         Joi.date().iso().allow(null, ''),
    supplier_bill_no:     optText(60),
    notes:                optText(2000),

    items:                itemsArray,
});

/**
 * GET /api/v1/credit-notes and /api/v1/debit-notes (query string)
 * Pagination + the filters the list handler reads. Param names match
 * listDeliveryNoteSchema (page/per_page/search/date_from/date_to) — the
 * shared web `apiList()` helper only understands those.
 */
const listReturnNoteSchema = Joi.object({
    page:             Joi.number().integer().min(1).default(1),
    per_page:         Joi.number().integer().min(1).max(100).default(10),
    search:           Joi.string().trim().max(191).allow('', null),
    date_from:        Joi.date().iso().allow('', null),
    date_to:          Joi.date().iso().allow('', null),
});

module.exports = {
    createReturnNoteSchema,
    listReturnNoteSchema,
};
