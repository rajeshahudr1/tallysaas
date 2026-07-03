'use strict';

/**
 * Validators for the "Share with Accountant" feature. The invite mirrors the
 * user-create rules (name + email + a >=8-char password) so a CA login is held
 * to the same security floor as any other account.
 */

const Joi = require('joi');

const inviteAccountantSchema = Joi.object({
    name:     Joi.string().trim().min(1).max(191).required().messages({
        'string.empty': 'Name is required.',
        'any.required': 'Name is required.',
    }),
    email:    Joi.string().trim().lowercase().email({ tlds: false }).max(191).required().messages({
        'string.email': 'Enter a valid email address.',
        'any.required': 'Email is required.',
    }),
    password: Joi.string().min(8).max(128).required().messages({
        'string.min':   'Password must be at least 8 characters.',
        'any.required': 'Password is required.',
    }),
    // Optional — the company may pick a role to assign; blank → the safe auto
    // "Accountant" (read-only) role.
    role_id:  Joi.number().integer().positive().optional().allow('', null),
});

module.exports = { inviteAccountantSchema };
