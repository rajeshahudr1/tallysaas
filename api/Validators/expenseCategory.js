'use strict';

const Joi = require('joi');

const createExpenseCategorySchema = Joi.object({
    name:   Joi.string().trim().min(1).max(150).required().messages({
        'string.empty': 'Name is required.',
        'any.required': 'Name is required.',
    }),
    status: Joi.string().valid('Active', 'Inactive').default('Active'),
});

const updateExpenseCategorySchema = Joi.object({
    name:   Joi.string().trim().min(1).max(150),
    status: Joi.string().valid('Active', 'Inactive'),
});

module.exports = { createExpenseCategorySchema, updateExpenseCategorySchema };
