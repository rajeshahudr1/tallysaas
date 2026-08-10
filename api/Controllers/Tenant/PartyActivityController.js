'use strict';

/**
 * Controllers/Tenant/PartyActivityController.js
 *
 * The follow-up trail on one party: list it, and add to it.
 *
 * There is deliberately no update and no delete. An activity records something
 * that happened — editing "customer said call back Tuesday" into something
 * else destroys the only evidence of what was actually agreed. A correction is
 * a new entry, which is also how the person reading the timeline expects it to
 * behave.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

/** Outcome → the label the UI shows. The key is what is stored. */
const OUTCOMES = {
    interested:        'Interested',
    not_interested:    'Not Interested',
    busy:              'Customer is busy',
    call_back:         'Call back later',
    follow_up:         'Follow Up',
    meeting_scheduled: 'Meeting Scheduled',
    payment_promised:  'Payment Promised',
    note:              'Note',
};

const PARTY_TABLE = { customer: 'customers', supplier: 'suppliers' };

/** Resolve + validate the party this request is about. */
async function resolveParty(req) {
    const type = String(req.params.type || req.query.party_type || 'customer').trim().toLowerCase();
    const table = PARTY_TABLE[type];
    if (!table) return { error: 'Unknown party type.' };
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return { error: 'Invalid party.' };
    const row = await db(table).where({ company_id: req.companyId, id })
        .whereNull('deleted_at').first('id', 'name');
    if (!row) return { error: 'Party not found.', notFound: true };
    return { type, id, name: row.name };
}

/** GET /parties/:type/:id/activities */
async function list(req, res) {
    try {
        const party = await resolveParty(req);
        if (party.error) return R.errorResponse(res, party.error, party.notFound ? 404 : 422);

        const rows = await db('party_activities as a')
            .leftJoin('users as u', 'u.id', 'a.created_by')
            .where({
                'a.company_id': req.companyId,
                'a.party_type': party.type,
                'a.party_id': party.id,
            })
            .orderBy('a.created_at', 'desc').orderBy('a.id', 'desc')
            .limit(200)
            .select('a.id', 'a.outcome', 'a.note', 'a.follow_up_on', 'a.created_at',
                'u.name as by_name');

        return R.successResponse(res, {
            data: rows.map((r) => ({
                id: r.id,
                outcome: r.outcome,
                outcome_label: OUTCOMES[r.outcome] || r.outcome,
                note: r.note || '',
                follow_up_on: r.follow_up_on,
                created_at: r.created_at,
                by: r.by_name || '',
            })),
            meta: {
                party: { type: party.type, id: party.id, name: party.name },
                total: rows.length,
                // The vocabulary the UI offers, so the two cannot drift apart.
                outcomes: Object.entries(OUTCOMES).map(([k, v]) => ({ value: k, label: v })),
            },
        });
    } catch (err) {
        console.error('partyActivity.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** POST /parties/:type/:id/activities */
async function create(req, res) {
    try {
        const party = await resolveParty(req);
        if (party.error) return R.errorResponse(res, party.error, party.notFound ? 404 : 422);

        const b = req.body || {};
        const outcome = String(b.outcome || '').trim();
        if (!OUTCOMES[outcome]) return R.errorResponse(res, 'Pick an outcome.', 422);

        const note = String(b.note || '').trim().slice(0, 2000);
        // A follow-up date is optional; an unparseable one is rejected rather
        // than quietly dropped, so a typo does not silently lose the reminder.
        let followUp = null;
        if (b.follow_up_on) {
            const m = /^\d{4}-\d{2}-\d{2}$/.exec(String(b.follow_up_on).trim());
            if (!m) return R.errorResponse(res, 'Follow-up date must be YYYY-MM-DD.', 422);
            followUp = m[0];
        }

        const [row] = await db('party_activities').insert({
            company_id: req.companyId,
            party_type: party.type,
            party_id: party.id,
            outcome,
            note: note || null,
            follow_up_on: followUp,
            created_by: (req.user && req.user.sub) || null,
        }).returning('id');

        return R.successResponse(res,
            { id: row ? (row.id || row) : null },
            'Activity logged.');
    } catch (err) {
        console.error('partyActivity.create error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, create, OUTCOMES };
