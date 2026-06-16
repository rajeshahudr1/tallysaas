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
