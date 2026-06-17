'use strict';

/**
 * api/Validators/role.js — tenant (license-admin) custom-role management (Phase C).
 */

const Joi = require('joi');

const slugList = Joi.array().items(Joi.string().trim().max(100)).default([]);

const createRoleSchema = Joi.object({
    name:  Joi.string().trim().min(1).max(100).required().messages({
        'string.empty': 'Role name is required.',
        'any.required': 'Role name is required.',
    }),
    slugs: slugList,   // optional initial permission slugs (filtered to entitled)
    // Super-admin only: target license for the new role (omitted/null = a global
    // TEMPLATE role). Ignored for license-admins (their own license is used).
    license_id: Joi.number().integer().positive().allow(null),
});

const updateRoleSchema = Joi.object({
    name: Joi.string().trim().min(1).max(100).required().messages({
        'string.empty': 'Role name is required.',
        'any.required': 'Role name is required.',
    }),
});

const setRolePermissionsSchema = Joi.object({
    slugs: slugList,
});

module.exports = { createRoleSchema, updateRoleSchema, setRolePermissionsSchema };
