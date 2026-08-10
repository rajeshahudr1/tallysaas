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
const { GST_STATES, GST_REGISTRATION_TYPES } = require('../config/gstStates');

// Allowed lifecycle states — matches the customers.status default ('Active').
const STATUSES = ['Active', 'Inactive', 'Blocked'];

// Allow-lists for the Tally party fields — keeps garbage out of state /
// gst_registration_type rather than accepting free text.
const STATE_NAMES = GST_STATES.map((s) => s.name);
const BALANCE_TYPES = ['Cr', 'Dr'];

// `state` is only restricted to the GST_STATES allow-list when the customer's
// country is India — those codes drive the CGST/SGST-vs-IGST split and are
// meaningless for any other country, whose states aren't in gstStates.js at
// all. Everywhere else `state` is free text. `country` defaults to '' (i.e.
// not India) so an omitted country does NOT fall back into the GST allow-list.
const stateField = Joi.string().trim().max(100).allow('', null)
    .when('country', {
        is: Joi.string().trim().valid('India'),
        then: Joi.valid(...STATE_NAMES),
    });

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
    // Credit PERIOD, in days. No default: null means "no agreed terms", which
    // is a different statement from "zero days of credit" — a voucher form
    // reads null as "no default due date" and the Parties list prints a dash.
    credit_days:      Joi.number().integer().min(0).max(3650).allow(null),

    status:           Joi.string().valid(...STATUSES).default('Active'),

    billing_address:  optText(2000),
    shipping_address: optText(2000),

    is_tally_ledger:  Joi.boolean().default(true),

    ledger_group:          optText(191),
    opening_balance_type:  Joi.string().valid(...BALANCE_TYPES).default('Cr'),
    country:                optText(64),
    state:                   stateField,
    city:                    optText(120),
    pincode:                optText(12),
    gst_registration_type:  Joi.string().trim().max(40).valid(...GST_REGISTRATION_TYPES).allow('', null),

    notes:            optText(2000),
    internal_remarks: optText(2000),
    custom_fields:    Joi.object().unknown(true).allow(null),

    // Starred on the Parties screen. Cloud-only — Tally has no such field.
    is_favourite:     Joi.boolean(),
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
    credit_days:      Joi.number().integer().min(0).max(3650).allow(null),

    status:           Joi.string().valid(...STATUSES),

    billing_address:  optText(2000),
    shipping_address: optText(2000),

    is_tally_ledger:  Joi.boolean(),

    ledger_group:          optText(191),
    opening_balance_type:  Joi.string().valid(...BALANCE_TYPES),
    country:                optText(64),
    state:                   stateField,
    city:                    optText(120),
    pincode:                optText(12),
    gst_registration_type:  Joi.string().trim().max(40).valid(...GST_REGISTRATION_TYPES).allow('', null),

    notes:            optText(2000),
    internal_remarks: optText(2000),
    custom_fields:    Joi.object().unknown(true).allow(null),

    // Starred on the Parties screen. Cloud-only — Tally has no such field.
    is_favourite:     Joi.boolean(),
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
    // Incremental sync: 1 = updated today, or an ISO date/datetime cutoff.
    last_update: Joi.alternatives().try(Joi.valid('1', 1), Joi.string().isoDate()).allow('', null),
}).unknown(true);   // allow filter params (location/sales_person/group/gst/dates)

module.exports = {
    createCustomerSchema,
    updateCustomerSchema,
    listCustomerSchema,
    STATUSES,
};
