'use strict';

/**
 * api/Validators/category.js
 *
 * Joi schemas for the categories resource. Mirrors the `categories` table
 * (migration 20260101000013) — the fields a client may set. Server-managed
 * columns (id, company_id, timestamps, deleted_at) are intentionally NOT
 * accepted from the body; they are stamped by the controller / crudController
 * factory.
 *
 * Schemas:
 *   createCategorySchema — POST  /categories   (name required; rest optional)
 *   updateCategorySchema — PUT   /categories/:id (all optional; ≥1 enforced)
 *   listCategorySchema   — GET   /categories   (query: pagination + filters)
 *
 * Conventions:
 *   • `parent_id` is a nullable positive-integer self-FK (NULL = top-level);
 *     existence is enforced by the DB FK, not here.
 *   • `status` is constrained to the Active | Inactive set the table defaults
 *     around ('Active').
 */

const Joi = require('joi');

// Allowed lifecycle states — matches the categories.status default ('Active').
const STATUSES = ['Active', 'Inactive'];

// Reusable optional positive-integer FK (nullable so a category can be top-level).
const fkId = Joi.number().integer().positive().allow(null);

/**
 * POST /api/v1/categories
 * `name` is the only required field; everything else is optional. `.required()`
 * lives on name so the 422 fires before we touch the DB.
 */
const createCategorySchema = Joi.object({
    name: Joi.string().trim().min(1).max(150).required().messages({
        'string.empty': 'Category name is required.',
        'any.required': 'Category name is required.',
        'string.max':   'Category name is too long.',
    }),

    parent_id: fkId,

    status:    Joi.string().valid(...STATUSES).default('Active'),
});

/**
 * PUT /api/v1/categories/:id
 * Every field is optional (partial update) but the body must carry at least one
 * updatable field — `.min(1)` rejects an empty PUT. No defaults here: omitting a
 * field leaves the stored value untouched (the controller's buildUpdate only
 * patches keys that are present).
 */
const updateCategorySchema = Joi.object({
    name:      Joi.string().trim().min(1).max(150),
    parent_id: fkId,
    status:    Joi.string().valid(...STATUSES),
}).min(1).messages({
    'object.min': 'Provide at least one field to update.',
});

/**
 * GET /api/v1/categories (query string)
 * Pagination + the filters the crudController.list reads (search / status /
 * page / per_page). Unknown query keys are stripped by Joi's default behaviour
 * once the schema validates, keeping the list handler's inputs predictable.
 */
const listCategorySchema = Joi.object({
    search:   Joi.string().trim().max(150).allow('', null),
    status:   Joi.string().valid(...STATUSES),
    page:     Joi.number().integer().min(1).default(1),
    per_page: Joi.number().integer().min(1).max(100).default(20),
    sort:     Joi.string().trim().max(40).allow('', null),
    order:    Joi.string().trim().lowercase().valid('asc', 'desc').allow('', null),
});

module.exports = {
    createCategorySchema,
    updateCategorySchema,
    listCategorySchema,
    STATUSES,
};
