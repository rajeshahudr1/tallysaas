'use strict';

/**
 * api/Validators/auth.js
 *
 * Joi schemas for the authentication endpoints. Used via the `validate(schema)`
 * middleware, which runs these BEFORE the controller and replaces the request
 * source with Joi's sanitised output (trimmed strings, lower-cased emails).
 *
 * Schemas:
 *   loginSchema          — POST /auth/login   { email, password }
 *   forgotPasswordSchema — POST /auth/forgot  { email }   (wired in a later phase)
 *
 * Notes:
 *   • `email` is `.lowercase().trim()` so the controller's `lower(email)` lookup
 *     always matches the lower-cased value stored in the users table.
 *   • `password` keeps a generous-but-sane min length; the real strength policy
 *     lives at sign-up, not login. A 6-char floor just rejects obvious junk.
 *   • Messages are phrased for end users — the validate middleware surfaces the
 *     first one verbatim in the 422 envelope's `msg`.
 */

const Joi = require('joi');

// Shared email rule — single definition so login and forgot-password agree on
// normalisation (trim + lowercase) and the on-screen message.
const emailRule = Joi.string()
    .email({ tlds: { allow: false } })   // accept any TLD; we don't gate on a TLD allow-list
    .lowercase()
    .trim()
    .max(191)
    .required()
    .messages({
        'string.email': 'Please enter a valid email address.',
        'string.empty': 'Email is required.',
        'any.required':  'Email is required.',
        'string.max':    'Email is too long.',
    });

/**
 * POST /api/v1/auth/login
 *   { email: <valid email>, password: <string, min 6> }
 */
const loginSchema = Joi.object({
    email:    emailRule,
    password: Joi.string()
        .min(6)
        .max(255)
        .required()
        .messages({
            'string.empty': 'Password is required.',
            'string.min':   'Password must be at least 6 characters.',
            'string.max':   'Password is too long.',
            'any.required': 'Password is required.',
        }),
});

/**
 * POST /api/v1/auth/forgot-password
 *   { email: <valid email> }
 */
const forgotPasswordSchema = Joi.object({
    email: emailRule,
});

module.exports = {
    loginSchema,
    forgotPasswordSchema,
};
