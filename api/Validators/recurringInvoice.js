'use strict';

const Joi = require('joi');

const dateField = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
    .messages({ 'string.pattern.base': 'Date must be YYYY-MM-DD.' })
    .allow(null).empty('');

const customerField = Joi.number().integer().positive().allow(null).empty('');

const base = {
    customer_id: customerField,
    title:       Joi.string().trim().min(1).max(191),
    description: Joi.string().trim().max(500).allow('', null),
    amount:      Joi.number().min(0),
    gst_rate:    Joi.number().min(0).max(100),
    frequency:   Joi.string().valid('monthly', 'quarterly', 'yearly'),
    due_days:    Joi.number().integer().min(0).max(365),
    start_date:  dateField,
    next_run_date: dateField,   // editable directly (reschedule)
    end_date:    dateField,
    status:      Joi.string().valid('Active', 'Paused'),
};

const createRecurringSchema = Joi.object({
    ...base,
    title:      base.title.required().messages({ 'any.required': 'Title is required.' }),
    amount:     base.amount.required().messages({ 'any.required': 'Amount is required.' }),
    frequency:  base.frequency.default('monthly'),
    gst_rate:   base.gst_rate.default(0),
    due_days:   base.due_days.default(0),
    start_date: dateField.required().messages({ 'any.required': 'Start date is required.' }),
    status:     base.status.default('Active'),
});

const updateRecurringSchema = Joi.object(base);

module.exports = { createRecurringSchema, updateRecurringSchema };
