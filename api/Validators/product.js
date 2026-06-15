'use strict';

/**
 * api/Validators/product.js
 *
 * Joi schemas for the products resource. Mirrors the `products` table
 * (migration 20260101000014) — the fields a client may set. Server-managed
 * columns (id, company_id, tally_guid, tally_synced_at, timestamps, deleted_at)
 * are intentionally NOT accepted from the body; they are stamped by the
 * controller / crudController factory.
 *
 * Schemas:
 *   createProductSchema — POST  /products      (name required; rest optional)
 *   updateProductSchema — PUT   /products/:id  (all optional; ≥1 enforced)
 *   listProductSchema   — GET   /products      (query: pagination + filters)
 *
 * Conventions:
 *   • blank optional strings are allowed via `.allow('', null)` so a client can
 *     clear a field by sending an empty value.
 *   • money fields (purchase_price / sales_price) and opening_stock are
 *     non-negative numbers defaulting to 0; gst_rate is a non-negative percent.
 *   • `status` is constrained to the Active | Inactive set the table defaults
 *     around.
 *   • `category_id` is a positive integer (nullable); existence is enforced by
 *     the DB FK, not here.
 */

const Joi = require('joi');

// Allowed lifecycle states — matches the products.status default ('Active').
const STATUSES = ['Active', 'Inactive'];

// Reusable optional positive-integer FK (nullable so a client can detach it).
const fkId = Joi.number().integer().positive().allow(null);

// Reusable optional short text — trimmed, blank/null allowed to clear.
const optText = (max) => Joi.string().trim().max(max).allow('', null);

/**
 * POST /api/v1/products
 * `name` is the only required field; everything else is optional. `.required()`
 * lives on name so the 422 fires before we touch the DB. Joi applies the table
 * defaults for the money/stock columns + status + is_tally_item.
 */
const createProductSchema = Joi.object({
    name: Joi.string().trim().min(1).max(191).required().messages({
        'string.empty': 'Product name is required.',
        'any.required': 'Product name is required.',
        'string.max':   'Product name is too long.',
    }),

    sku:            optText(100),
    unit:           optText(30),
    hsn_code:       optText(20),

    gst_rate:       Joi.number().min(0).precision(2).default(0),

    purchase_price: Joi.number().min(0).precision(2).default(0),
    sales_price:    Joi.number().min(0).precision(2).default(0),
    opening_stock:  Joi.number().min(0).precision(2).default(0),

    category_id:    fkId,

    status:         Joi.string().valid(...STATUSES).default('Active'),

    is_tally_item:  Joi.boolean().default(true),

    description:    optText(5000),
});

/**
 * PUT /api/v1/products/:id
 * Every field is optional (partial update) but the body must carry at least one
 * updatable field — `.min(1)` rejects an empty PUT. No defaults here: omitting a
 * field leaves the stored value untouched (the controller's buildUpdate only
 * patches keys that are present).
 */
const updateProductSchema = Joi.object({
    name:           Joi.string().trim().min(1).max(191),

    sku:            optText(100),
    unit:           optText(30),
    hsn_code:       optText(20),

    gst_rate:       Joi.number().min(0).precision(2),

    purchase_price: Joi.number().min(0).precision(2),
    sales_price:    Joi.number().min(0).precision(2),
    opening_stock:  Joi.number().min(0).precision(2),

    category_id:    fkId,

    status:         Joi.string().valid(...STATUSES),

    is_tally_item:  Joi.boolean(),

    description:    optText(5000),
}).min(1).messages({
    'object.min': 'Provide at least one field to update.',
});

/**
 * GET /api/v1/products (query string)
 * Pagination + the filters the crudController.list reads (search / status /
 * page / per_page). Unknown query keys are stripped by Joi's default behaviour
 * once the schema validates, keeping the list handler's inputs predictable.
 */
const listProductSchema = Joi.object({
    search:   Joi.string().trim().max(191).allow('', null),
    status:   Joi.string().valid(...STATUSES),
    page:     Joi.number().integer().min(1).default(1),
    per_page: Joi.number().integer().min(1).max(100).default(20),
    sort:     Joi.string().trim().max(40).allow('', null),
    order:    Joi.string().trim().lowercase().valid('asc', 'desc').allow('', null),
});

module.exports = {
    createProductSchema,
    updateProductSchema,
    listProductSchema,
    STATUSES,
};
