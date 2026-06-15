'use strict';

/**
 * api/Middlewares/validate.js
 *
 * Factory that turns a Joi schema into Express middleware. Validates the
 * request body / query / params BEFORE the controller runs and replaces the
 * source with Joi's sanitised output (trimmed strings, lowercased emails,
 * applied defaults). On failure it emits the 422 envelope and aborts the chain.
 *
 *   const { validate } = require('../Middlewares/validate');
 *   const { loginSchema } = require('../Validators/auth');
 *
 *   router.post('/login', validate(loginSchema), AuthController.login);
 *   router.get ('/customers', validate(listCustomerSchema, 'query'), Customers.list);
 *
 * Single-message policy: `abortEarly: true` stops on the first violation and
 * returns ONE message in `msg`, matching the envelope shape clients expect.
 */

const R = require('../Helpers/response');

const VALID_SOURCES = new Set(['body', 'query', 'params']);

/**
 * Build an Express middleware that validates one request source against a Joi
 * schema.
 *
 * @param {import('joi').Schema} schema
 * @param {'body'|'query'|'params'} [source='body']
 * @returns {(req, res, next) => void}
 */
function validate(schema, source = 'body') {
    if (!schema || typeof schema.validate !== 'function') {
        throw new TypeError('validate(schema) requires a Joi schema');
    }
    if (!VALID_SOURCES.has(source)) {
        throw new TypeError(`validate(schema, source) — source must be one of: ${[...VALID_SOURCES].join(', ')}`);
    }

    return function validateMiddleware(req, res, next) {
        const { error, value } = schema.validate(req[source] || {}, { abortEarly: true });
        if (error) {
            return R.errorResponse(res, error.details[0].message, 422);
        }
        // Replace the source so controllers see normalised data.
        req[source] = value;
        return next();
    };
}

module.exports = { validate };
