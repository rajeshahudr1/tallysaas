'use strict';

/**
 * api/Validators/salesOrder.js
 *
 * Joi schemas for the sales-orders resource. Mirrors quotation.js — see that
 * file's header comment for the rationale. Server-managed columns (id,
 * company_id, order_no when blank, all money totals, cgst/sgst/igst,
 * round_off, order_status, converted_invoice_id, status, tally_*, created_by,
 * timestamps, deleted_at) are intentionally NOT accepted from the body; the
 * totals are computed by SalesOrderController.computeTotals inside the write
 * transaction. NEVER trust client-sent totals — `.unknown(false)` (Joi's
 * default) drops them silently if sent.
 *
 * Schemas:
 *   createSalesOrderSchema — POST/PUT /sales-orders (customer_id required)
 *   listSalesOrderSchema   — GET  /sales-orders       (pagination + filters)
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
 * A single sales-order line. The money columns (taxable / gst_amount /
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
 * POST /api/v1/sales-orders (also used for PUT — the shape is the same).
 * `customer_id` and at least one item are required; `order_no` is optional —
 * the controller generates one when blank.
 */
const createSalesOrderSchema = Joi.object({
    customer_id:     fkId.required().messages({
        'any.required':    'Customer is required.',
        'number.base':     'Customer is required.',
        'number.positive': 'Customer is required.',
    }),
    location_id:     optFkId,
    sales_person_id: optFkId,

    order_no:        optText(60),
    order_date:      Joi.date().iso().allow(null, ''),
    due_on:          Joi.date().iso().allow(null, ''),
    ledger_name:     optText(120),
    notes:           optText(2000),

    items:           itemsArray,
});

/**
 * GET /api/v1/sales-orders (query string)
 * Pagination + the filters the list handler reads. Param names match
 * listQuotationSchema (page/per_page/search/date_from/date_to) — the shared
 * web `apiList()` helper only understands those. `order_status` is the
 * sales-order-only delivery-lifecycle filter (pending/partially_delivered/
 * delivered/cancelled); it is deliberately NOT named `status` — that name is
 * reserved app-wide for the Tally-sync lifecycle.
 */
const listSalesOrderSchema = Joi.object({
    page:         Joi.number().integer().min(1).default(1),
    per_page:     Joi.number().integer().min(1).max(100).default(10),
    search:       Joi.string().trim().max(191).allow('', null),
    date_from:    Joi.date().iso().allow('', null),
    date_to:      Joi.date().iso().allow('', null),
    order_status: Joi.string().valid('pending', 'partially_delivered', 'delivered', 'cancelled', 'all').allow(''),
    mine:         Joi.alternatives().try(Joi.valid('1', 1, true, false), Joi.boolean()).allow('', null),
});

module.exports = {
    createSalesOrderSchema,
    listSalesOrderSchema,
};
