'use strict';

/**
 * api/Validators/company.js
 *
 * Validation for the tenant company endpoints (list + create). A company is
 * registered UNDER the caller's license; the controller stamps license_id +
 * a unique slug and enforces the license's max_companies cap.
 */

const Joi = require('joi');

const STATUSES = ['Active', 'Inactive', 'Blocked'];

const createCompanySchema = Joi.object({
    name:           Joi.string().trim().min(2).max(191).required(),
    mobile:         Joi.string().trim().max(30).allow('', null),
    email:          Joi.string().trim().lowercase().email({ tlds: false }).max(191).allow('', null),
    gst_number:     Joi.string().trim().max(30).allow('', null),
    pan_number:     Joi.string().trim().max(20).allow('', null),
    financial_year: Joi.string().trim().max(20).allow('', null),
    address:        Joi.string().trim().max(500).allow('', null),
    status:         Joi.string().valid(...STATUSES).default('Active'),
});

const listCompanySchema = Joi.object({
    search:   Joi.string().trim().max(191).allow('', null),
    status:   Joi.string().valid(...STATUSES),
    page:     Joi.number().integer().min(1).default(1),
    per_page: Joi.number().integer().min(1).max(100).default(20),
    sort:     Joi.string().trim().max(40).allow('', null),
    order:    Joi.string().trim().lowercase().valid('asc', 'desc').allow('', null),
});

module.exports = { createCompanySchema, listCompanySchema, STATUSES };
