'use strict';

/**
 * api/Validators/customerGroup.js
 *
 * Joi schemas for the customer_groups resource. Mirrors the `customer_groups`
 * table (migration 20260101000010) — the fields a client may set. Server-managed
 * columns (id, company_id, timestamps, deleted_at) are intentionally NOT accepted
 * from the body; they are stamped by the controller / crudController factory.
 *
 * The table is deliberately minimal (company_id + name + timestamps +
 * soft-delete), so `name` is the only writable column.
 *
 * Schemas:
 *   createCustomerGroupSchema — POST  /customer-groups   (name required)
 *   updateCustomerGroupSchema — PUT   /customer-groups/:id (all optional; >=1 enforced)
 *   listCustomerGroupSchema   — GET   /customer-groups   (query: pagination + filters)
 *
 * Conventions:
 *   • `name` is trimmed; max 150 matches the column width string('name', 150).
 *   • list filters mirror the crudController.list inputs (search / status /
 *     page / per_page). `status` is accepted for parity with the shared list
 *     pattern even though this table has no status column — the factory only
 *     applies the filter when present, so it is a harmless no-op here.
 */

const Joi = require('joi');

/**
 * POST /api/v1/customer-groups
 * `name` is the only field — and it is required. `.required()` lives on name so
 * the 422 fires before we touch the DB.
 */
const createCustomerGroupSchema = Joi.object({
    name: Joi.string().trim().min(1).max(150).required().messages({
        'string.empty': 'Customer group name is required.',
        'any.required': 'Customer group name is required.',
        'string.max':   'Customer group name is too long.',
    }),
});

/**
 * PUT /api/v1/customer-groups/:id
 * Every field is optional (partial update) but the body must carry at least one
 * updatable field — `.min(1)` rejects an empty PUT. No defaults here: omitting a
 * field leaves the stored value untouched (the controller's buildUpdate only
 * patches keys that are present).
 */
const updateCustomerGroupSchema = Joi.object({
    name: Joi.string().trim().min(1).max(150).messages({
        'string.empty': 'Customer group name is required.',
        'string.max':   'Customer group name is too long.',
    }),
}).min(1).messages({
    'object.min': 'Provide at least one field to update.',
});

/**
 * GET /api/v1/customer-groups (query string)
 * Pagination + the filters the crudController.list reads (search / status /
 * page / per_page). Unknown query keys are stripped by Joi's default behaviour
 * once the schema validates, keeping the list handler's inputs predictable.
 */
const listCustomerGroupSchema = Joi.object({
    search:   Joi.string().trim().max(150).allow('', null),
    status:   Joi.string().trim().max(50),
    page:     Joi.number().integer().min(1).default(1),
    per_page: Joi.number().integer().min(1).max(100).default(20),
});

module.exports = {
    createCustomerGroupSchema,
    updateCustomerGroupSchema,
    listCustomerGroupSchema,
};
