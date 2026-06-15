'use strict';

/**
 * api/Validators/invoice.js
 *
 * Joi schemas for the invoices resource (sales + purchase vouchers). Mirrors the
 * `invoices` (migration 20260101000016) and `invoice_items` (20260101000017)
 * tables — but only the fields a client may set. Server-managed columns
 * (id, company_id, invoice_no, all money totals, cgst/sgst/igst, round_off,
 * tally_*, created_by, timestamps, deleted_at) are intentionally NOT accepted
 * from the body; they are computed / stamped by the InvoiceController inside the
 * write transaction. NEVER trust client-sent totals.
 *
 * Schemas:
 *   createSalesInvoiceSchema    — POST /invoices/sales    (customer_id required)
 *   createPurchaseInvoiceSchema — POST /invoices/purchase (supplier_id required,
 *                                                          + supplier_bill_no)
 *   listInvoiceSchema           — GET  /invoices/...       (pagination + filters)
 *
 * Conventions:
 *   • FK ids are positive integers; existence is enforced by the DB FK, not here.
 *   • blank optional strings are allowed via `.allow('', null)` so a client can
 *     omit / clear a field.
 *   • items is an array with at least one line; per-line quantity > 0 and
 *     rate >= 0 are required, discount_pct (0..100) and gst_rate default to 0.
 *   • `status` walks the Tally sync lifecycle and defaults to 'pending_tally'.
 */

const Joi = require('joi');

// Invoice sync-lifecycle states — matches invoices.status default.
const STATUSES = ['pending_tally', 'sent_to_tally', 'created', 'failed'];

// Reusable optional positive-integer FK.
const fkId = Joi.number().integer().positive();

// Reusable optional short/long text — trimmed, blank/null allowed.
const optText = (max) => Joi.string().trim().max(max).allow('', null);

/**
 * A single invoice line. The money columns (taxable / gst_amount / amount) are
 * NOT accepted here — the controller computes them authoritatively from
 * quantity / rate / discount_pct / gst_rate.
 */
const itemSchema = Joi.object({
    product_id:   fkId.allow(null),
    description:  optText(2000),
    hsn:          optText(20),
    quantity:     Joi.number().greater(0).precision(2).required().messages({
        'number.base':     'Item quantity is required.',
        'number.greater':  'Item quantity must be greater than 0.',
        'any.required':    'Item quantity is required.',
    }),
    unit:         optText(30),
    rate:         Joi.number().min(0).precision(2).required().messages({
        'number.base':  'Item rate is required.',
        'number.min':   'Item rate must be 0 or more.',
        'any.required': 'Item rate is required.',
    }),
    discount_pct: Joi.number().min(0).max(100).precision(2).default(0),
    gst_rate:     Joi.number().min(0).precision(2).default(0),
});

const itemsArray = Joi.array().items(itemSchema).min(1).required().messages({
    'array.min':    'At least one line item is required.',
    'array.base':   'At least one line item is required.',
    'any.required': 'At least one line item is required.',
});

/**
 * POST /api/v1/invoices/sales
 * `customer_id`, `invoice_date` and at least one item are required.
 */
const createSalesInvoiceSchema = Joi.object({
    customer_id:     fkId.required().messages({
        'any.required':    'Customer is required.',
        'number.base':     'Customer is required.',
        'number.positive': 'Customer is required.',
    }),
    location_id:     fkId,
    sales_person_id: fkId,

    invoice_date:    Joi.date().iso().required().messages({
        'date.base':    'Invoice date is required.',
        'date.format':  'Invoice date must be an ISO date.',
        'any.required': 'Invoice date is required.',
    }),
    due_date:        Joi.date().iso().allow(null),
    notes:           optText(2000),

    status:          Joi.string().valid(...STATUSES).default('pending_tally'),

    items:           itemsArray,
});

/**
 * POST /api/v1/invoices/purchase
 * Same shape as sales but keyed on `supplier_id` (required) instead of
 * customer_id, carries an optional `supplier_bill_no`, and has no
 * sales_person_id.
 */
const createPurchaseInvoiceSchema = Joi.object({
    supplier_id:      fkId.required().messages({
        'any.required':    'Supplier is required.',
        'number.base':     'Supplier is required.',
        'number.positive': 'Supplier is required.',
    }),
    location_id:      fkId,
    supplier_bill_no: optText(60),

    invoice_date:     Joi.date().iso().required().messages({
        'date.base':    'Invoice date is required.',
        'date.format':  'Invoice date must be an ISO date.',
        'any.required': 'Invoice date is required.',
    }),
    due_date:         Joi.date().iso().allow(null),
    notes:            optText(2000),

    status:           Joi.string().valid(...STATUSES).default('pending_tally'),

    items:            itemsArray,
});

/**
 * GET /api/v1/invoices/{sales,purchase} (query string)
 * Pagination + the filters the list handlers read. customer_id / supplier_id
 * narrow to a party; date_from / date_to bound invoice_date.
 */
const listInvoiceSchema = Joi.object({
    search:      Joi.string().trim().max(191).allow('', null),
    status:      Joi.string().valid(...STATUSES),
    page:        Joi.number().integer().min(1).default(1),
    per_page:    Joi.number().integer().min(1).max(100).default(10),
    customer_id: fkId,
    supplier_id: fkId,
    date_from:   Joi.date().iso(),
    date_to:     Joi.date().iso(),
});

module.exports = {
    createSalesInvoiceSchema,
    createPurchaseInvoiceSchema,
    listInvoiceSchema,
    STATUSES,
};
