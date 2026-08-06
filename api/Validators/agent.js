'use strict';

/**
 * api/Validators/agent.js — Joi schemas for the Python sync agent endpoints.
 */

const Joi = require('joi');

// ── Agent sign-in (replaces licence-key activation) ──────────────
// EVERY rule lives here, never in the agent. The desktop app sends what was
// typed and renders whatever `msg` comes back, so wording and rules can change
// without shipping a new exe — which is the whole point of moving them server
// side. Messages are therefore written for the customer, not for a developer.

const machineIdRule = Joi.string().trim().max(191).required()
    .messages({ 'any.required': 'This computer could not be identified. Restart the app and try again.' });

const loginSchema = Joi.object({
    email: Joi.string().trim().lowercase().email({ tlds: false }).max(191).required()
        .messages({
            'string.email': 'Enter a valid email address.',
            'string.empty': 'Enter your email address.',
            'any.required': 'Enter your email address.',
        }),
    // No strength rule on sign-in — that belongs at sign-up. This only rejects
    // obviously empty input so a blank form does not cost a database lookup.
    password: Joi.string().min(1).max(255).required()
        .messages({
            'string.empty': 'Enter your password.',
            'any.required': 'Enter your password.',
        }),
    machine_id: machineIdRule,
    machine_name:  Joi.string().trim().max(191).allow('', null),
    agent_version: Joi.string().trim().max(40).allow('', null),
});

const verifySchema = Joi.object({
    challenge_id: Joi.string().trim().guid({ version: 'uuidv4' }).required()
        .messages({
            'string.guid': 'This code is no longer valid. Start again.',
            'any.required': 'This code is no longer valid. Start again.',
        }),
    // Exactly six digits. Stated here rather than in the agent so the length
    // can change server-side alone.
    code: Joi.string().trim().pattern(/^\d{6}$/).required()
        .messages({
            'string.pattern.base': 'Enter the 6-digit code from your email.',
            'string.empty': 'Enter the 6-digit code from your email.',
            'any.required': 'Enter the 6-digit code from your email.',
        }),
    machine_id: machineIdRule,
    machine_name:  Joi.string().trim().max(191).allow('', null),
    agent_version: Joi.string().trim().max(40).allow('', null),
});

const resendSchema = Joi.object({
    challenge_id: Joi.string().trim().guid({ version: 'uuidv4' }).required()
        .messages({
            'string.guid': 'This code is no longer valid. Start again.',
            'any.required': 'This code is no longer valid. Start again.',
        }),
});

const heartbeatSchema = Joi.object({
    agent_version:  Joi.string().trim().max(40).allow('', null),
    // Names of the companies currently OPEN in Tally (so the cloud can show
    // "currently open in Tally"). Optional — omitted when Tally is unreachable.
    open_companies: Joi.array().items(Joi.string().trim().max(191)).max(500).allow(null),
});

module.exports = { loginSchema, verifySchema, resendSchema, heartbeatSchema };
