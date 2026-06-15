'use strict';

/**
 * api/Validators/payment.js
 *
 * Joi schemas for the payments resource — the payment & receipt vouchers stored
 * in the `payments` table (migration 20260101000018). A "payment" voucher is
 * money OUT to a supplier; a "receipt" voucher is money IN from a customer.
 * The two share every field except the party FK (supplier_id vs customer_id),
 * so they get sibling create schemas.
 *
 * Server-managed columns (id, company_id, type, party_type, voucher_no,
 * tally_voucher_no, created_by, timestamps, deleted_at) are NOT accepted from
 * the body; the PaymentController stamps them. In particular voucher_no and the
 * running sequence are computed server-side — never trusted from the client.
 *
 * Schemas:
 *   createPaymentSchema — POST /payments (supplier_id required; money out)
 *   createReceiptSchema — POST /receipts (customer_id required; money in)
 *   listPaymentSchema   — GET  /payments | /receipts (query: pagination + filters)
 *
 * Conventions mirror the customer/supplier validators:
 *   • FK ids are positive integers; existence is enforced by the DB FK, not here.
 *   • optional short text is trimmed, blank/null allowed via `.allow('', null)`.
 *   • `amount` is a strictly-positive numeric(16,2).
 *   • `status` walks the Tally sync lifecycle and defaults to 'pending_tally'.
 */

const Joi = require('joi');

// Allowed Tally sync lifecycle states — matches payments.status default.
const STATUSES = ['pending_tally', 'sent_to_tally', 'created', 'failed'];

// Reusable optional short text — trimmed, blank/null allowed to clear.
const optText = (max) => Joi.string().trim().max(max).allow('', null);

// Required positive-integer FK to the paying/receiving party.
const partyId = (label) => Joi.number().integer().positive().required().messages({
    'number.base':     `${label} is required.`,
    'number.integer':  `${label} is invalid.`,
    'number.positive': `${label} is invalid.`,
    'any.required':    `${label} is required.`,
});

// Required ISO calendar date (the voucher date drives the voucher_no year).
const paymentDate = Joi.date().iso().required().messages({
    'date.base':    'A valid payment date is required.',
    'date.format':  'Payment date must be an ISO date (YYYY-MM-DD).',
    'any.required': 'Payment date is required.',
});

// Required payment mode — free text (Cash / Bank / UPI / Cheque / NEFT-RTGS …).
const mode = Joi.string().trim().min(1).max(50).required().messages({
    'string.empty': 'Payment mode is required.',
    'any.required': 'Payment mode is required.',
    'string.max':   'Payment mode is too long.',
});

// Required strictly-positive money amount, numeric(16,2).
const amount = Joi.number().greater(0).precision(2).required().messages({
    'number.base':     'Amount is required.',
    'number.greater':  'Amount must be greater than 0.',
    'any.required':    'Amount is required.',
});

// The fields common to both payment and receipt vouchers (everything but the
// party FK). Spread into each create schema so they stay in lockstep.
const sharedVoucherFields = {
    payment_date: paymentDate,
    mode:         mode,
    amount:       amount,
    reference:    optText(100),
    bank_account: optText(100),
    notes:        optText(2000),
    status:       Joi.string().valid(...STATUSES).default('pending_tally'),
};

/**
 * POST /api/v1/payments — money OUT to a supplier.
 * `supplier_id` identifies the creditor being paid.
 */
const createPaymentSchema = Joi.object({
    supplier_id: partyId('Supplier'),
    ...sharedVoucherFields,
});

/**
 * POST /api/v1/receipts — money IN from a customer.
 * `customer_id` identifies the debtor the money was received from.
 */
const createReceiptSchema = Joi.object({
    customer_id: partyId('Customer'),
    ...sharedVoucherFields,
});

/**
 * GET /api/v1/payments | /api/v1/receipts (query string)
 * Pagination + the filters the list handlers read (search / status / mode /
 * page / per_page) plus an optional date range. Unknown query keys are stripped
 * by Joi once the schema validates, keeping the list inputs predictable.
 */
const listPaymentSchema = Joi.object({
    search:    Joi.string().trim().max(191).allow('', null),
    status:    Joi.string().valid(...STATUSES),
    mode:      Joi.string().trim().max(50).allow('', null),
    date_from: Joi.date().iso(),
    date_to:   Joi.date().iso(),
    page:      Joi.number().integer().min(1).default(1),
    per_page:  Joi.number().integer().min(1).max(100).default(20),
});

module.exports = {
    createPaymentSchema,
    createReceiptSchema,
    listPaymentSchema,
    STATUSES,
};
