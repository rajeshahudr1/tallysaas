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

    // Default license-admin (the license's "super user") — created + auto-approved
    // alongside the license so the customer can log in immediately. Email is the
    // login id; password is optional (auto-generated + shown once if omitted).
    admin_name:     Joi.string().trim().max(191).allow('', null),
    admin_email:    Joi.string().email({ tlds: { allow: false } }).lowercase().trim().max(191).required().messages({
        'any.required':  'Admin email is required (the license-admin login).',
        'string.email':  'Admin email must be a valid email.',
    }),
    admin_mobile:   Joi.string().trim().max(30).allow('', null),
    admin_password: Joi.string().min(8).max(128).allow('', null),
});

// Edit (Super-Admin) — ONLY the mutable commercial fields. The key/hash, machine
// binding and status are intentionally NOT editable here (status → suspend/
// activate, machine → reset-machine). The controller additionally enforces that
// max_companies / max_users may not drop below the current usage counts.
const updateLicenseSchema = Joi.object({
    holder_name:   Joi.string().trim().max(191).required(),
    plan:          Joi.string().trim().max(40),
    max_companies: Joi.number().integer().min(1).max(1000),
    max_users:     Joi.number().integer().min(1).max(10000),
    valid_until:   Joi.date().iso().allow('', null),
});

const listLicenseSchema = Joi.object({
    page:     Joi.number().integer().min(1).default(1),
    per_page: Joi.number().integer().min(1).max(100).default(20),
});

module.exports = { createLicenseSchema, updateLicenseSchema, listLicenseSchema };
