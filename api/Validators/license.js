'use strict';

/**
 * api/Validators/license.js — Joi schemas for Super-Admin license management.
 */

const Joi = require('joi');

const createLicenseSchema = Joi.object({
    holder_name:   Joi.string().trim().max(191).required(),
    tally_serial:  Joi.string().trim().max(60).allow('', null),
    plan:          Joi.string().trim().max(40).default('standard'),
    max_companies: Joi.number().integer().min(1).max(1000).default(5),
    max_users:     Joi.number().integer().min(1).max(10000).default(10),
    valid_until:   Joi.date().iso().allow('', null),
});

const listLicenseSchema = Joi.object({
    page:     Joi.number().integer().min(1).default(1),
    per_page: Joi.number().integer().min(1).max(100).default(20),
});

module.exports = { createLicenseSchema, listLicenseSchema };
