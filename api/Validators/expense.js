'use strict';

const Joi = require('joi');

// A YYYY-MM-DD date; '' from a blank form field becomes "unset" (→ null column).
const dateField = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
    .messages({ 'string.pattern.base': 'Date must be YYYY-MM-DD.' })
    .allow(null).empty('');

// category_id: a positive int; '' (no category picked) → unset → null column.
const categoryField = Joi.number().integer().positive().allow(null).empty('');

const createExpenseSchema = Joi.object({
    category_id:  categoryField,
    vendor:       Joi.string().trim().max(191).allow('', null),
    expense_date: dateField,
    amount:       Joi.number().min(0).required().messages({ 'any.required': 'Amount is required.' }),
    payment_mode: Joi.string().trim().max(50).allow('', null),
    reference:    Joi.string().trim().max(100).allow('', null),
    notes:        Joi.string().trim().max(2000).allow('', null),
    status:       Joi.string().valid('Active', 'Inactive').default('Active'),
});

const updateExpenseSchema = Joi.object({
    category_id:  categoryField,
    vendor:       Joi.string().trim().max(191).allow('', null),
    expense_date: dateField,
    amount:       Joi.number().min(0),
    payment_mode: Joi.string().trim().max(50).allow('', null),
    reference:    Joi.string().trim().max(100).allow('', null),
    notes:        Joi.string().trim().max(2000).allow('', null),
    status:       Joi.string().valid('Active', 'Inactive'),
});

module.exports = { createExpenseSchema, updateExpenseSchema };
