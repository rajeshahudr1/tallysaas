'use strict';

/**
 * api/Validators/location.js
 *
 * Joi schemas for the locations resource. Mirrors the `locations` table
 * (migration 20260101000005) — the fields a client may set. Server-managed
 * columns (id, company_id, tally_guid, tally_synced_at, timestamps, deleted_at)
 * are intentionally NOT accepted from the body; they are stamped by the
 * controller / crudController factory.
 *
 * Schemas:
 *   createLocationSchema — POST  /locations    (name required; rest optional)
 *   updateLocationSchema — PUT   /locations/:id (all optional; ≥1 enforced)
 *   listLocationSchema   — GET   /locations    (query: pagination + filters)
 *
 * Conventions:
 *   • blank optional strings are allowed via `.allow('', null)` so a client can
 *     clear a field by sending an empty value.
 *   • `status` is constrained to the Active | Inactive set the table defaults
 *     around.
 *   • `is_tally_godown` is a boolean flag (defaults to true on create) marking
 *     the location as a Tally godown for stock sync.
 */

const Joi = require('joi');

// Allowed lifecycle states — matches the locations.status default ('Active').
const STATUSES = ['Active', 'Inactive'];

// Reusable optional short text — trimmed, blank/null allowed to clear.
const optText = (max) => Joi.string().trim().max(max).allow('', null);

/**
 * POST /api/v1/locations
 * `name` is the only required field; everything else is optional. `.required()`
 * lives on name so the 422 fires before we touch the DB.
 */
const createLocationSchema = Joi.object({
    name: Joi.string().trim().min(1).max(150).required().messages({
        'string.empty': 'Location name is required.',
        'any.required': 'Location name is required.',
        'string.max':   'Location name is too long.',
    }),

    code:    optText(50),
    city:    optText(100),
    state:   optText(100),
    pincode: optText(12),
    mobile:  optText(30),
    manager: optText(150),

    status:  Joi.string().valid(...STATUSES).default('Active'),

    is_tally_godown: Joi.boolean().default(true),
});

/**
 * PUT /api/v1/locations/:id
 * Every field is optional (partial update) but the body must carry at least one
 * updatable field — `.min(1)` rejects an empty PUT. No defaults here: omitting a
 * field leaves the stored value untouched (the controller's buildUpdate only
 * patches keys that are present).
 */
const updateLocationSchema = Joi.object({
    name:    Joi.string().trim().min(1).max(150),
    code:    optText(50),
    city:    optText(100),
    state:   optText(100),
    pincode: optText(12),
    mobile:  optText(30),
    manager: optText(150),

    status:  Joi.string().valid(...STATUSES),

    is_tally_godown: Joi.boolean(),
}).min(1).messages({
    'object.min': 'Provide at least one field to update.',
});

/**
 * GET /api/v1/locations (query string)
 * Pagination + the filters the crudController.list reads (search / status /
 * page / per_page). Unknown query keys are stripped by Joi's default behaviour
 * once the schema validates, keeping the list handler's inputs predictable.
 */
const listLocationSchema = Joi.object({
    search:   Joi.string().trim().max(150).allow('', null),
    status:   Joi.string().valid(...STATUSES),
    page:     Joi.number().integer().min(1).default(1),
    per_page: Joi.number().integer().min(1).max(100).default(20),
    sort:     Joi.string().trim().max(40).allow('', null),
    order:    Joi.string().trim().lowercase().valid('asc', 'desc').allow('', null),
});

module.exports = {
    createLocationSchema,
    updateLocationSchema,
    listLocationSchema,
    STATUSES,
};
