'use strict';

/**
 * Controllers/Tenant/CostCentreController.js
 *
 * Tally's cost-centre reports, over the synced allocation rows:
 *
 *   summary        one row per cost centre — what was booked against it
 *   ledger-breakup one cost centre split by the LEDGER each amount hit
 *   group-breakup  one cost centre split by the ledger's GROUP
 *
 * A cost allocation carries a signed amount (Tally's own sign), a ledger name
 * and the cost centre, keyed to the voucher. Nothing here re-signs anything:
 * the whole point of a cost report is to show what Tally recorded.
 *
 * Read-only.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

/** Date-range + company scope shared by all three reports. */
function scope(req) {
    const binds = [req.companyId];
    let where = 'a.company_id = ?';
    if (req.query.from) { where += ' and v.voucher_date >= ?'; binds.push(req.query.from); }
    if (req.query.to)   { where += ' and v.voucher_date <= ?'; binds.push(req.query.to); }
    return { where, binds };
}

/** GET /cost-centres/summary — every cost centre with its total. */
async function summary(req, res) {
    try {
        const { where, binds } = scope(req);
        const sql = `
            select a.cost_centre as name,
                   max(a.cost_category) as category,
                   count(distinct a.voucher_guid) as vouchers,
                   sum(a.amount) as amount
              from tally_cost_allocations a
              left join tally_vouchers v
                     on v.company_id = a.company_id and v.guid = a.voucher_guid
             where ${where} and a.cost_centre is not null and a.cost_centre <> ''
             group by a.cost_centre
             order by sum(a.amount) desc
        `;
        const result = await db.raw(sql, binds);
        return respond(res, result.rows, { report: 'summary', label: 'Cost Centre Summary' });
    } catch (err) {
        console.error('costCentres.summary error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /cost-centres/breakup?by=ledger|group&centre=<name>
 *
 * `centre` is optional: without it the breakup covers every cost centre, which
 * is what "Ledger Breakup" means at the top level in Tally.
 */
async function breakup(req, res) {
    const by = String(req.query.by || 'ledger').trim().toLowerCase();
    if (by !== 'ledger' && by !== 'group') {
        return R.errorResponse(res, 'Unknown breakup.', 422);
    }
    try {
        const { where, binds } = scope(req);
        let extraWhere = '';
        const centre = String(req.query.centre || '').trim();
        if (centre) { extraWhere = ' and a.cost_centre = ?'; binds.push(centre); }

        // The GROUP breakup reads the ledger's parent from the Tally ledger
        // master — the allocation row itself only knows the ledger name.
        const keyExpr = by === 'group'
            ? "coalesce(tl.parent, '(No Group)')"
            : 'a.ledger_name';
        const join = by === 'group'
            ? `left join tally_ledgers tl
                      on tl.company_id = a.company_id
                     and lower(tl.name) = lower(a.ledger_name)`
            : '';

        const sql = `
            select ${keyExpr} as name,
                   count(distinct a.voucher_guid) as vouchers,
                   sum(a.amount) as amount
              from tally_cost_allocations a
              left join tally_vouchers v
                     on v.company_id = a.company_id and v.guid = a.voucher_guid
              ${join}
             where ${where}${extraWhere}
             group by ${keyExpr}
             order by sum(a.amount) desc
        `;
        const result = await db.raw(sql, binds);
        return respond(res, result.rows, {
            report: by === 'group' ? 'group-breakup' : 'ledger-breakup',
            label: by === 'group' ? 'Group Breakup' : 'Ledger Breakup',
            centre: centre || null,
        });
    } catch (err) {
        console.error(`costCentres.breakup(${by}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

function respond(res, rows, meta) {
    const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const out = (rows || []).map((r) => ({
        name: r.name,
        category: r.category || null,
        vouchers: Number(r.vouchers) || 0,
        amount: money(r.amount),
    }));
    return R.successResponse(res, {
        data: out,
        meta: {
            ...meta,
            rows: out.length,
            total_amount: money(out.reduce((s, r) => s + r.amount, 0)),
        },
    });
}

module.exports = { summary, breakup };
