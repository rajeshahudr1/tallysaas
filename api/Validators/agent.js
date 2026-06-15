'use strict';

/**
 * api/Validators/agent.js — Joi schemas for the Python sync agent endpoints.
 */

const Joi = require('joi');

const activateSchema = Joi.object({
    license_key:   Joi.string().trim().max(60).required(),
    machine_id:    Joi.string().trim().max(191).required(),
    agent_version: Joi.string().trim().max(40).allow('', null),
});

const heartbeatSchema = Joi.object({
    agent_version: Joi.string().trim().max(40).allow('', null),
});

module.exports = { activateSchema, heartbeatSchema };
