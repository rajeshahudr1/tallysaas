'use strict';

/**
 * api/Validators/customerUser.js
 *
 * Joi schemas for the Customer-User (customer portal login) endpoints. Mirrors
 * the sales-person login/assignment validators:
 *
 *   loginSchema   — POST /customers/:id/login    { email, password?, role_id, status? }
 *   catalogSchema — PUT  /customers/:id/catalog  { categories: [{ category_id,
 *                    discount_pct, addition_pct, product_ids? }] }
 *
 * Pricing rule the catalog feeds (applied server-side on product list + invoice
 * create for the linked login):
 *   rate = sales_price × (1 − discount_pct/100) × (1 + addition_pct/100)
 */

const Joi = require('joi');

const reqFkId = Joi.number().integer().positive();

/** POST /api/v1/customers/:id/login — same contract as the sales-person login. */
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
 * PUT /api/v1/customers/:id/catalog
 * Replaces the customer's ENTIRE catalog assignment. Each entry assigns one
 * category with its two pricing knobs; `product_ids` (optional) narrows the
 * category to specific products — omitted/empty = the whole category.
 */
const catalogSchema = Joi.object({
    categories: Joi.array().items(Joi.object({
        category_id:  reqFkId.required().messages({
            'any.required':    'category_id is required for each catalog entry.',
            'number.base':     'category_id must be a positive number.',
            'number.positive': 'category_id must be a positive number.',
        }),
        discount_pct: Joi.number().min(0).max(100).precision(2).default(0).messages({
            'number.min': 'Discount % must be between 0 and 100.',
            'number.max': 'Discount % must be between 0 and 100.',
        }),
        addition_pct: Joi.number().min(0).max(1000).precision(2).default(0).messages({
            'number.min': 'Addition % must be 0 or more.',
            'number.max': 'Addition % is too large.',
        }),
        product_ids:  Joi.array().items(reqFkId).default([]),
    }).custom((entry, helpers) => {
        // EITHER a discount OR an addition per category — never both.
        if ((entry.discount_pct || 0) > 0 && (entry.addition_pct || 0) > 0) {
            return helpers.error('any.custom');
        }
        return entry;
    }).messages({
        'any.custom': 'Set either Discount % or Addition % for a category — not both.',
    })).default([]).messages({
        'array.base': 'categories must be a list.',
    }),
});

module.exports = {
    loginSchema,
    catalogSchema,
};
