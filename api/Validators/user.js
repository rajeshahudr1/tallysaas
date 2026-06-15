'use strict';

/**
 * api/Validators/user.js
 *
 * Joi schemas for the tenant `users` resource. Mirrors the `users` table — but
 * only the fields a client may set when creating a user. Server-managed columns
 * (id, company_id, license_id, password_hash, last_login_at, timestamps,
 * deleted_at) are intentionally NOT accepted from the body; they are stamped /
 * derived by the UserController (company_id from req.companyId, license_id from
 * the caller's token, password_hash from the helper).
 *
 * Schemas:
 *   createUserSchema — POST /users   (name + email + role_id + password required)
 *   listUserSchema   — GET  /users   (query: pagination + filters)
 *
 * Conventions:
 *   • email is trimmed + lower-cased so the controller's existence check and the
 *     stored value always agree on casing.
 *   • role_id / location_id are positive integers; existence is enforced by the
 *     DB FK, not here.
 *   • `status` is constrained to the Active | Inactive | Blocked set and defaults
 *     to 'Active'.
 *   • password keeps an 8-char floor (this is account creation, not login).
 */

const Joi = require('joi');

// Allowed lifecycle states — matches the users.status default ('Active').
const STATUSES = ['Active', 'Inactive', 'Blocked'];

// Reusable optional positive-integer FK (nullable so a client can detach it).
const fkId = Joi.number().integer().positive().allow(null);

// Reusable optional short text — trimmed, blank/null allowed to clear.
const optText = (max) => Joi.string().trim().max(max).allow('', null);

/**
 * POST /api/v1/users
 * `name`, `email`, `role_id` and `password` are required; the rest is optional.
 * The required rules live on those fields so the 422 fires before we touch the DB.
 */
const createUserSchema = Joi.object({
    name: Joi.string().trim().min(1).max(191).required().messages({
        'string.empty': 'Name is required.',
        'any.required': 'Name is required.',
        'string.max':   'Name is too long.',
    }),

    email: Joi.string()
        .email({ tlds: { allow: false } })
        .lowercase()
        .trim()
        .max(191)
        .required()
        .messages({
            'string.email': 'Please enter a valid email address.',
            'string.empty': 'Email is required.',
            'any.required': 'Email is required.',
            'string.max':   'Email is too long.',
        }),

    mobile: optText(30),

    role_id: Joi.number().integer().positive().required().messages({
        'any.required':    'Role is required.',
        'number.base':     'Role is required.',
        'number.positive': 'Role is required.',
    }),

    password: Joi.string().min(8).max(255).required().messages({
        'string.empty': 'Password is required.',
        'string.min':   'Password must be at least 8 characters.',
        'string.max':   'Password is too long.',
        'any.required': 'Password is required.',
    }),

    status: Joi.string().valid(...STATUSES).default('Active'),

    location_id: fkId,
});

/**
 * GET /api/v1/users (query string)
 * Pagination + the filters the list handler reads (search / status / role_id /
 * page / per_page). Unknown query keys are stripped by Joi once the schema
 * validates, keeping the list handler's inputs predictable.
 */
const listUserSchema = Joi.object({
    search:   Joi.string().trim().max(191).allow('', null),
    status:   Joi.string().valid(...STATUSES),
    role_id:  Joi.number().integer().positive(),
    page:     Joi.number().integer().min(1).default(1),
    per_page: Joi.number().integer().min(1).max(100).default(20),
});

module.exports = {
    createUserSchema,
    listUserSchema,
    STATUSES,
};
