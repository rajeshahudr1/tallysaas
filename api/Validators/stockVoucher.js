'use strict';

/**
 * api/Validators/stockVoucher.js
 *
 * Joi schemas for the Stock Journal and Physical Stock resources. Both are
 * GOODS vouchers (no ledger / GST / money totals), so these schemas are
 * intentionally simpler than delivery-note/sales-order's — see
 * Validators/deliveryNote.js for the pattern this mirrors. Server-managed
 * columns (id, company_id, voucher_no when blank, status, tally_*,
 * created_by, timestamps, deleted_at) are NOT accepted from the body.
 */

const Joi = require('joi');

const fkId = Joi.number().integer().positive();
const optText = (max) => Joi.string().trim().max(max).allow('', null);

/**
 * One stock-journal line — either a `source` (stock consumed / moved out) or
 * a `destination` (stock produced / moved in) row. `rate` is optional and
 * carries no money effect on the header (there is none).
 */
const stockJournalItemSchema = Joi.object({
    product_id: fkId.required().messages({
        'any.required':    'Item product is required.',
        'number.base':     'Item product is required.',
        'number.positive': 'Item product is required.',
    }),
    direction: Joi.string().valid('source', 'destination').required().messages({
        'any.required':  'Item direction is required.',
        'any.only':      'Item direction must be source or destination.',
    }),
    godown: optText(120),
    quantity: Joi.number().greater(0).precision(2).required().messages({
        'number.base':    'Item quantity is required.',
        'number.greater': 'Item quantity must be greater than 0.',
        'any.required':   'Item quantity is required.',
    }),
    rate: Joi.number().min(0).precision(2).allow(null, ''),
});

const stockJournalItemsArray = Joi.array().items(stockJournalItemSchema).min(1).required().messages({
    'array.min':    'At least one line item is required.',
    'array.base':   'At least one line item is required.',
    'any.required': 'At least one line item is required.',
});

/** POST /stock-journals */
const createStockJournalSchema = Joi.object({
    voucher_no:   optText(60),
    journal_date: Joi.date().iso().allow(null, ''),
    narration:    optText(2000),
    items:        stockJournalItemsArray,
});

/** GET /stock-journals (query string) */
const listStockJournalSchema = Joi.object({
    page:      Joi.number().integer().min(1).default(1),
    per_page:  Joi.number().integer().min(1).max(100).default(10),
    search:    Joi.string().trim().max(191).allow('', null),
    date_from: Joi.date().iso().allow('', null),
    date_to:   Joi.date().iso().allow('', null),
});

/** One physical-stock count line. */
const physicalStockItemSchema = Joi.object({
    product_id:  fkId.required().messages({
        'any.required':    'Item product is required.',
        'number.base':     'Item product is required.',
        'number.positive': 'Item product is required.',
    }),
    counted_qty: Joi.number().required().messages({
        'any.required': 'Counted quantity is required.',
        'number.base':  'Counted quantity is required.',
    }),
    godown:      optText(120),
});

const physicalStockItemsArray = Joi.array().items(physicalStockItemSchema).min(1).required().messages({
    'array.min':    'At least one line item is required.',
    'array.base':   'At least one line item is required.',
    'any.required': 'At least one line item is required.',
});

/** POST /physical-stock */
const createPhysicalStockSchema = Joi.object({
    voucher_no: optText(60),
    count_date: Joi.date().iso().allow(null, ''),
    notes:      optText(2000),
    items:      physicalStockItemsArray,
});

/** GET /physical-stock (query string) */
const listPhysicalStockSchema = Joi.object({
    page:      Joi.number().integer().min(1).default(1),
    per_page:  Joi.number().integer().min(1).max(100).default(10),
    date_from: Joi.date().iso().allow('', null),
    date_to:   Joi.date().iso().allow('', null),
});

module.exports = {
    createStockJournalSchema,
    listStockJournalSchema,
    createPhysicalStockSchema,
    listPhysicalStockSchema,
};
