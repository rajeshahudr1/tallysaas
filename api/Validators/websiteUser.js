'use strict';

/**
 * api/Validators/websiteUser.js
 *
 * Joi schemas for the Website-User (third-party API user) endpoints. A website
 * user is a FRESH customers row (is_website_user=true) + a login + an auto
 * api_token, sharing the customer-user catalog assignment. Extra pricing knobs:
 *   cash_extra_pct   — extra % on the rate when an invoice is paid in cash
 *   online_extra_pct — extra % when paid online
 */

const Joi = require('joi');

const reqFkId = Joi.number().integer().positive();
const pct = Joi.number().min(0).max(1000).precision(2);

/** POST /api/v1/website-users — create the user + login + token atomically. */
const createWebsiteUserSchema = Joi.object({
    name: Joi.string().trim().min(1).max(191).required().messages({
        'string.empty': 'Name is required.',
        'any.required': 'Name is required.',
    }),
    email: Joi.string().email({ tlds: { allow: false } }).lowercase().trim().max(191).required().messages({
        'string.email': 'Please enter a valid email address.',
        'any.required': 'Email is required.',
        'string.empty': 'Email is required.',
    }),
    password: Joi.string().min(8).max(255).required().messages({
        'string.min':   'Password must be at least 8 characters.',
        'any.required': 'Password is required.',
        'string.empty': 'Password is required.',
    }),
    role_id: reqFkId.required().messages({
        'any.required': 'Login role is required.',
        'number.base':  'Login role is required.',
    }),
    mobile:           Joi.string().trim().max(30).allow('', null),
    cash_extra_pct:   pct.default(0),
    online_extra_pct: pct.default(0),
    status:           Joi.string().valid('Active', 'Inactive', 'Blocked').default('Active'),
});

/** PUT /api/v1/website-users/:id — patch profile / pricing / login. */
const updateWebsiteUserSchema = Joi.object({
    name:             Joi.string().trim().min(1).max(191),
    email:            Joi.string().email({ tlds: { allow: false } }).lowercase().trim().max(191),
    password:         Joi.string().min(8).max(255).allow('', null),
    role_id:          reqFkId,
    mobile:           Joi.string().trim().max(30).allow('', null),
    cash_extra_pct:   pct,
    online_extra_pct: pct,
    status:           Joi.string().valid('Active', 'Inactive', 'Blocked'),
}).min(1).messages({ 'object.min': 'Provide at least one field to update.' });

module.exports = { createWebsiteUserSchema, updateWebsiteUserSchema };
