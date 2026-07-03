'use strict';

const Joi = require('joi');

const rowSchema = Joi.object({
    txn_date:    Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null, ''),
    description: Joi.string().max(500).allow('', null),
    reference:   Joi.string().max(191).allow('', null),
    amount:      Joi.number().required(),   // signed: + credit / − debit
}).unknown(true);

const importBankSchema = Joi.object({
    rows: Joi.array().items(rowSchema).min(1).max(5000).required().messages({
        'array.min':    'No rows to import.',
        'any.required': 'No rows to import.',
    }),
});

module.exports = { importBankSchema };
