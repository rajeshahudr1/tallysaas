'use strict';

/**
 * api/Validators/salesPerson.js
 *
 * Joi schemas for the sales_persons resource. Mirrors the `sales_persons` table
 * (migration 20260101000008) — the fields a client may set. Server-managed
 * columns (id, company_id, timestamps, deleted_at) are intentionally NOT
 * accepted from the body; they are stamped by the controller / crudController
 * factory.
 *
 * Schemas:
 *   createSalesPersonSchema — POST /sales-persons   (name required; rest optional)
 *   updateSalesPersonSchema — PUT  /sales-persons/:id (all optional; ≥1 enforced)
 *   listSalesPersonSchema   — GET  /sales-persons   (query: pagination + filters)
 *
 * Conventions:
 *   • emails are trimmed + lower-cased; blank optional strings are allowed via
 *     `.allow('', null)` so a client can clear a field by sending an empty value.
 *   • `status` is constrained to the Active | Inactive set the table defaults
 *     around (default 'Active').
 *   • `joining_date` is an ISO date; `user_id` is a positive integer (nullable),
 *     existence enforced by the DB FK, not here.
 */

const Joi = require('joi');

// Allowed lifecycle states — matches the sales_persons.status default ('Active').
const STATUSES = ['Active', 'Inactive'];

// Reusable optional positive-integer FK (nullable so a client can detach it).
const fkId = Joi.number().integer().positive().allow(null);

// Reusable optional short text — trimmed, blank/null allowed to clear.
const optText = (max) => Joi.string().trim().max(max).allow('', null);

/**
 * POST /api/v1/sales-persons
 * `name` is the only required field; everything else is optional. `.required()`
 * lives on name so the 422 fires before we touch the DB.
 */
const createSalesPersonSchema = Joi.object({
    name: Joi.string().trim().min(1).max(150).required().messages({
        'string.empty': 'Sales person name is required.',
        'any.required': 'Sales person name is required.',
        'string.max':   'Sales person name is too long.',
    }),

    employee_code: optText(50),
    mobile:        optText(30),
    email:         Joi.string().email({ tlds: { allow: false } }).lowercase().trim().max(191).allow('', null),
    joining_date:  Joi.date().iso().allow(null),

    user_id:       fkId,

    status:        Joi.string().valid(...STATUSES).default('Active'),
});

/**
 * PUT /api/v1/sales-persons/:id
 * Every field is optional (partial update) but the body must carry at least one
 * updatable field — `.min(1)` rejects an empty PUT. No defaults here: omitting a
 * field leaves the stored value untouched (the controller's buildUpdate only
 * patches keys that are present).
 */
const updateSalesPersonSchema = Joi.object({
    name:          Joi.string().trim().min(1).max(150),
    employee_code: optText(50),
    mobile:        optText(30),
    email:         Joi.string().email({ tlds: { allow: false } }).lowercase().trim().max(191).allow('', null),
    joining_date:  Joi.date().iso().allow(null),

    user_id:       fkId,

    status:        Joi.string().valid(...STATUSES),
}).min(1).messages({
    'object.min': 'Provide at least one field to update.',
});

/**
 * GET /api/v1/sales-persons (query string)
 * Pagination + the filters the crudController.list reads (search / status /
 * page / per_page). Unknown query keys are stripped by Joi's default behaviour
 * once the schema validates, keeping the list handler's inputs predictable.
 */
const listSalesPersonSchema = Joi.object({
    search:   Joi.string().trim().max(191).allow('', null),
    status:   Joi.string().valid(...STATUSES),
    page:     Joi.number().integer().min(1).default(1),
    per_page: Joi.number().integer().min(1).max(100).default(20),
    sort:     Joi.string().trim().max(40).allow('', null),
    order:    Joi.string().trim().lowercase().valid('asc', 'desc').allow('', null),
}).unknown(true);   // allow filter params (location / created dates)

// Reusable required positive-integer FK.
const reqFkId = Joi.number().integer().positive();

/**
 * POST /api/v1/sales-persons/:id/login
 * Create-or-update the LOGIN USER linked to this sales person. `email` + `role_id`
 * are always required. `password` is required only when CREATING the login (the
 * controller knows whether sales_persons.user_id is already set), so the schema
 * keeps it optional (min 8 when present) and the controller enforces the
 * "required on create" rule with a clear 422. `status` is optional (Active by
 * default on create; on update it patches the linked user's status).
 */
const loginSchema = Joi.object({
    email: Joi.string()
        .email({ tlds: { allow: false } })
        .lowercase()
        .trim()
        .max(191)
        .required()
        .messages({
            'string.email': 'Please enter a valid login email address.',
            'string.empty': 'Login email is required.',
            'any.required': 'Login email is required.',
            'string.max':   'Login email is too long.',
        }),

    // Optional here; the controller requires it when creating a brand-new login.
    password: Joi.string().min(8).max(255).allow('', null).messages({
        'string.min': 'Password must be at least 8 characters.',
        'string.max': 'Password is too long.',
    }),

    role_id: reqFkId.required().messages({
        'any.required':    'Login role is required.',
        'number.base':     'Login role is required.',
        'number.positive': 'Login role is required.',
    }),

    status: Joi.string().valid('Active', 'Inactive', 'Blocked'),
});

/**
 * PUT /api/v1/sales-persons/:id/locations
 * Replace this sales person's assigned locations. `location_ids` is an array of
 * positive integers (may be empty to clear all assignments). The controller
 * validates the ids belong to the caller's company.
 */
const assignLocationsSchema = Joi.object({
    location_ids: Joi.array().items(reqFkId).default([]).messages({
        'array.base': 'location_ids must be a list of location ids.',
    }),
});

/**
 * PUT /api/v1/sales-persons/:id/customers
 * Replace this sales person's assigned customers FOR ONE location. `location_id`
 * is required (must be one of the sales person's assigned locations); the
 * `customer_ids` array (may be empty to clear) lists the customers to assign in
 * that location. The controller validates membership of location + customers.
 */
const assignCustomersSchema = Joi.object({
    location_id: reqFkId.required().messages({
        'any.required':    'Location is required.',
        'number.base':     'Location is required.',
        'number.positive': 'Location is required.',
    }),
    customer_ids: Joi.array().items(reqFkId).default([]).messages({
        'array.base': 'customer_ids must be a list of customer ids.',
    }),
});

module.exports = {
    createSalesPersonSchema,
    updateSalesPersonSchema,
    listSalesPersonSchema,
    loginSchema,
    assignLocationsSchema,
    assignCustomersSchema,
    STATUSES,
};
