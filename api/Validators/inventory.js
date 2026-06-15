'use strict';

/**
 * api/Validators/inventory.js — Stock-adjustment payload (POST /inventory/adjust).
 */

const Joi = require('joi');

const createAdjustmentSchema = Joi.object({
    product_id:  Joi.number().integer().positive().required(),
    location_id: Joi.number().integer().positive().allow(null),
    type:        Joi.string().valid('add', 'remove', 'set').required(),
    quantity:    Joi.number().min(0).required(),
    reason:      Joi.string().trim().max(120).allow('', null),
    notes:       Joi.string().trim().max(300).allow('', null),
    date:        Joi.string().trim().max(20).allow('', null),
});

module.exports = { createAdjustmentSchema };
