'use strict';

/** api/Validators/journal.js — Journal voucher (create + list). */

const Joi = require('joi');

const STATUSES = ['pending_tally', 'sent_to_tally', 'created', 'failed'];

const VCH_TYPES = ['Journal', 'Contra', 'Credit Note', 'Debit Note'];

const createJournalSchema = Joi.object({
    vch_type:     Joi.string().valid(...VCH_TYPES).default('Journal'),
    journal_date: Joi.string().trim().max(20).required(),
    dr_ledger:    Joi.string().trim().min(1).max(191).required(),
    cr_ledger:    Joi.string().trim().min(1).max(191).required(),
    amount:       Joi.number().positive().required(),
    narration:    Joi.string().trim().max(500).allow('', null),
});

const listJournalSchema = Joi.object({
    search:   Joi.string().trim().max(191).allow('', null),
    status:   Joi.string().valid(...STATUSES),
    page:     Joi.number().integer().min(1).default(1),
    per_page: Joi.number().integer().min(1).max(100).default(20),
});

module.exports = { createJournalSchema, listJournalSchema, STATUSES, VCH_TYPES };
