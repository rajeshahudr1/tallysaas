'use strict';

/**
 * api/Validators/customer.js
 *
 * Joi schemas for the customers resource. Mirrors the `customers` table
 * (migration 20260101000011) — the fields a client may set. Server-managed
 * columns (id, company_id, tally_guid, tally_synced_at, timestamps, deleted_at)
 * are intentionally NOT accepted from the body; they are stamped by the
 * controller / crudController factory.
 *
 * Schemas:
 *   createCustomerSchema — POST  /customers   (name required; rest optional)
 *   updateCustomerSchema — PUT   /customers/:id (all optional; ≥1 enforced)
 *   listCustomerSchema   — GET   /customers   (query: pagination + filters)
 *
 * Conventions:
 *   • emails are trimmed + lower-cased; blank optional strings are allowed via
 *     `.allow('', null)` so a client can clear a field by sending an empty value.
 *   • money fields (opening_balance / credit_limit) are non-negative numbers.
 *   • `status` is constrained to the Active | Inactive | Blocked set the table
 *     defaults around.
 *   • FK ids (location_id / sales_person_id / customer_group_id) are positive
 *     integers; existence is enforced by the DB FK, not here.
 */

const Joi = require('joi');

// Allowed lifecycle states — matches the customers.status default ('Active').
const STATUSES = ['Active', 'Inactive', 'Blocked'];

// Reusable optional positive-integer FK (nullable so a client can detach it).
const fkId = Joi.number().integer().positive().allow(null);

// Reusable optional short text — trimmed, blank/null allowed to clear.
const optText = (max) => Joi.string().trim().max(max).allow('', null);

/**
 * POST /api/v1/customers
 * `name` is the only required field; everything else is optional. `.required()`
 * lives on name so the 422 fires before we touch the DB.
 */
const createCustomerSchema = Joi.object({
    name: Joi.string().trim().min(1).max(191).required().messages({
        'string.empty': 'Customer name is required.',
        'any.required': 'Customer name is required.',
        'string.max':   'Customer name is too long.',
    }),

    mobile:           optText(30),
    alternate_mobile: optText(30),
    email:            Joi.string().email({ tlds: { allow: false } }).lowercase().trim().max(191).allow('', null),
    gst_number:       optText(30),
    pan_number:       optText(30),

    location_id:       fkId,
    sales_person_id:   fkId,
    customer_group_id: fkId,

    opening_balance:  Joi.number().min(0).precision(2).default(0),
    credit_limit:     Joi.number().min(0).precision(2).default(0),

    status:           Joi.string().valid(...STATUSES).default('Active'),

    billing_address:  optText(2000),
    shipping_address: optText(2000),

    is_tally_ledger:  Joi.boolean().default(true),

    notes:            optText(2000),
    internal_remarks: optText(2000),
    custom_fields:    Joi.object().unknown(true).allow(null),
});

/**
 * PUT /api/v1/customers/:id
 * Every field is optional (partial update) but the body must carry at least one
 * updatable field — `.min(1)` rejects an empty PUT. No defaults here: omitting a
 * field leaves the stored value untouched (the controller's buildUpdate only
 * patches keys that are present).
 */
const updateCustomerSchema = Joi.object({
    name:             Joi.string().trim().min(1).max(191),
    mobile:           optText(30),
    alternate_mobile: optText(30),
    email:            Joi.string().email({ tlds: { allow: false } }).lowercase().trim().max(191).allow('', null),
    gst_number:       optText(30),
    pan_number:       optText(30),

    location_id:       fkId,
    sales_person_id:   fkId,
    customer_group_id: fkId,

    opening_balance:  Joi.number().min(0).precision(2),
    credit_limit:     Joi.number().min(0).precision(2),

    status:           Joi.string().valid(...STATUSES),

    billing_address:  optText(2000),
    shipping_address: optText(2000),

    is_tally_ledger:  Joi.boolean(),

    notes:            optText(2000),
    internal_remarks: optText(2000),
    custom_fields:    Joi.object().unknown(true).allow(null),
}).min(1).messages({
    'object.min': 'Provide at least one field to update.',
});

/**
 * GET /api/v1/customers (query string)
 * Pagination + the filters the crudController.list reads (search / status /
 * page / per_page). Unknown query keys are stripped by Joi's default behaviour
 * once the schema validates, keeping the list handler's inputs predictable.
 */
const listCustomerSchema = Joi.object({
    search:   Joi.string().trim().max(191).allow('', null),
    status:   Joi.string().valid(...STATUSES),
    page:     Joi.number().integer().min(1).default(1),
    per_page: Joi.number().integer().min(1).max(100).default(20),
    sort:     Joi.string().trim().max(40).allow('', null),
    order:    Joi.string().trim().lowercase().valid('asc', 'desc').allow('', null),
}).unknown(true);   // allow filter params (location/sales_person/group/gst/dates)

module.exports = {
    createCustomerSchema,
    updateCustomerSchema,
    listCustomerSchema,
    STATUSES,
};
