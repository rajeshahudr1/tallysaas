'use strict';

/**
 * api/Helpers/tallyReconciliation.js
 *
 * Proves — per ledger, in rupees — that what the cloud CALCULATES equals what
 * Tally REPORTS. This is the calculation safety net: a sync can succeed, log no
 * errors and still leave the books wrong (a dropped AlterID window, a voucher
 * whose double entry did not balance, a ledger renamed mid-sync). Nothing in the
 * pipeline noticed any of that, because every part of it was individually fine.
 *
 * Two independent numbers exist for every ledger:
 *
 *   REPORTED   tally_ledgers.closing_balance — Tally's own authoritative figure
 *              (opening + all postings + inventory valuation), captured verbatim.
 *   DERIVED    opening_balance + Σ signed(tally_voucher_entries) — what the cloud
 *              reconstructs from the mirrored double entry.
 *
 * They are computed from DIFFERENT data by DIFFERENT paths, so agreement is
 * strong evidence the mirror is complete, and any disagreement localises the
 * problem to a named ledger instead of "the totals look off".
 *
 * SIGN — the trap here. Tally stores balances INVERTED relative to accounting:
 * a debit posts ISDEEMEDPOSITIVE=Yes with a NEGATIVE amount, and
 * opening_balance / closing_balance follow the same inverted convention (a cash
 * ledger's Dr balance is stored negative). We work debit-positive throughout,
 * so BOTH stored balances are flipped with the same accountingBalance() the
 * ledger screens use — comparing a stored balance against a debit-positive sum
 * directly reports every revenue and expense ledger as doubly wrong.
 *
 * PURE — no db access. Query builders are provided separately.
 */

const { accountingBalance } = require('./ledgerGroups');

// Below this, a difference is float noise from summing thousands of postings,
// not a real gap. One paisa.
const TOLERANCE = 0.01;

function r2(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
}

/** One posting as a debit-positive figure (see the sign note above). */
function signed(entry) {
    const amt = Math.abs(Number((entry && entry.amount) || 0));
    return (entry && entry.is_debit) ? amt : -amt;
}

/**
 * Compare Tally's reported closing balance against the cloud's derived one.
 *
 * @param {Array<{name, opening_balance, closing_balance}>} ledgers  tally_ledgers
 * @param {Array<{ledger_name, amount, is_debit}>} entries           tally_voucher_entries
 * @param {{tolerance?: number}} [opts]
 * @returns {{ok, checked, mismatched, total_difference, mismatches, unknown_ledgers}}
 *   `mismatches` is ordered by |difference| desc — the biggest problem first.
 */
function reconcileLedgers(ledgers, entries, opts = {}) {
    const tolerance = opts.tolerance != null ? Number(opts.tolerance) : TOLERANCE;

    // Σ postings per ledger NAME (entries carry the name, not an id).
    const movement = new Map();
    for (const e of entries || []) {
        const name = String((e && e.ledger_name) || '').trim();
        if (!name) continue;
        movement.set(name, (movement.get(name) || 0) + signed(e));
    }

    const mismatches = [];
    let checked = 0;
    const seen = new Set();

    for (const l of ledgers || []) {
        const name = String((l && l.name) || '').trim();
        if (!name) continue;
        seen.add(name);
        checked += 1;

        // Flip both out of Tally's inverted storage into debit-positive, so they
        // are on the same footing as the summed postings below.
        const opening = accountingBalance(l.opening_balance);
        const reported = accountingBalance(l.closing_balance);
        const derived = r2(opening + (movement.get(name) || 0));
        const difference = r2(derived - reported);

        if (Math.abs(difference) > tolerance) {
            mismatches.push({
                ledger: name,
                opening: r2(opening),
                movement: r2(movement.get(name) || 0),
                derived,
                reported: r2(reported),
                difference,
            });
        }
    }

    // Postings naming a ledger that is not in tally_ledgers at all. This is a
    // REAL defect, not a rounding one: the ledger master was missed or was
    // renamed after its vouchers synced, so its balance appears nowhere.
    const unknown = [];
    for (const [name, amount] of movement) {
        if (!seen.has(name)) unknown.push({ ledger: name, movement: r2(amount) });
    }

    mismatches.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
    unknown.sort((a, b) => Math.abs(b.movement) - Math.abs(a.movement));

    return {
        ok: mismatches.length === 0 && unknown.length === 0,
        checked,
        mismatched: mismatches.length,
        total_difference: r2(mismatches.reduce((s, m) => s + Math.abs(m.difference), 0)),
        mismatches,
        unknown_ledgers: unknown,
    };
}

/**
 * Check that every voucher's double entry BALANCES (Σ debits = Σ credits).
 *
 * An unbalanced voucher means the mirror lost a leg — usually a ledger entry
 * nested somewhere the parser did not look. It never surfaces as an error
 * because each leg imported fine on its own; it only shows up later as a Trial
 * Balance that will not tie.
 *
 * @param {Array<{voucher_guid, voucher_no, voucher_type, amount, is_debit}>} entries
 */
function reconcileVouchers(entries, opts = {}) {
    const tolerance = opts.tolerance != null ? Number(opts.tolerance) : TOLERANCE;
    const byVoucher = new Map();

    for (const e of entries || []) {
        const guid = String((e && e.voucher_guid) || '').trim();
        if (!guid) continue;
        const v = byVoucher.get(guid) || {
            guid, voucher_no: e.voucher_no || null, voucher_type: e.voucher_type || null,
            net: 0, legs: 0,
        };
        v.net += signed(e);
        v.legs += 1;
        byVoucher.set(guid, v);
    }

    const unbalanced = [];
    for (const v of byVoucher.values()) {
        const net = r2(v.net);
        // A single-leg voucher cannot balance by construction; that is a lost
        // counter-leg, so report it explicitly rather than as "off by X".
        if (Math.abs(net) > tolerance || v.legs < 2) {
            unbalanced.push({
                guid: v.guid, voucher_no: v.voucher_no, voucher_type: v.voucher_type,
                legs: v.legs, difference: net,
                reason: v.legs < 2 ? 'only one ledger entry — a counter-leg is missing'
                                   : 'debits do not equal credits',
            });
        }
    }
    unbalanced.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

    return {
        ok: unbalanced.length === 0,
        checked: byVoucher.size,
        unbalanced: unbalanced.length,
        vouchers: unbalanced,
    };
}

/**
 * Check the Trial Balance identity: Σ debits = Σ credits across ALL postings.
 * The single cheapest whole-book health check there is.
 */
function reconcileTrialBalance(entries, opts = {}) {
    const tolerance = opts.tolerance != null ? Number(opts.tolerance) : TOLERANCE;
    let debit = 0;
    let credit = 0;
    for (const e of entries || []) {
        const amt = Math.abs(Number((e && e.amount) || 0));
        if (e && e.is_debit) debit += amt; else credit += amt;
    }
    const difference = r2(debit - credit);
    return {
        ok: Math.abs(difference) <= tolerance,
        debit_total: r2(debit),
        credit_total: r2(credit),
        difference,
    };
}

// ── Query builders (the only db-aware part) ──────────────────
function ledgersQuery(db, companyId) {
    return db('tally_ledgers')
        .where('company_id', companyId).whereNull('deleted_at')
        .select('name', 'opening_balance', 'closing_balance');
}

/**
 * Postings for the check. Cancelled and OPTIONAL vouchers are excluded to match
 * Tally: it leaves both out of its registers and closing balances, so counting
 * them would produce a mismatch on every draft voucher in the company.
 */
function entriesQuery(db, companyId) {
    return db('tally_voucher_entries as e')
        .leftJoin('tally_vouchers as v', function join() {
            this.on('v.company_id', '=', 'e.company_id').andOn('v.guid', '=', 'e.voucher_guid');
        })
        .where('e.company_id', companyId)
        .where((w) => w.whereNull('v.guid')            // header not mirrored yet
            .orWhere((x) => x.where('v.is_cancelled', false)
                .where('v.is_optional', false)
                .whereNull('v.deleted_at')))
        .select('e.voucher_guid', 'e.voucher_no', 'e.voucher_type',
                'e.ledger_name', 'e.amount', 'e.is_debit');
}

/**
 * Which VOUCHER TYPES Tally defines vs which ones actually reached the cloud.
 *
 * Answers the question data alone cannot: "we have no Sales Orders — does this
 * company not raise any, or is our pull dropping them?" tally_voucher_types is
 * Tally's own list of every type defined for the company, so a type that is
 * defined but has zero synced vouchers is worth a look, and one that is defined,
 * NOT deactivated, and belongs to an order/inventory family is a likely gap.
 *
 * @returns {{types, missing, synced_only, ok}} `missing` = defined in Tally but
 *          nothing synced. Not automatically a defect — an unused type is normal.
 */
function compareVoucherTypes(definedTypes, syncedCounts) {
    const counts = new Map();
    for (const r of syncedCounts || []) {
        counts.set(String(r.voucher_type || '').trim().toLowerCase(), Number(r.vouchers) || 0);
    }
    const seen = new Set();
    const types = (definedTypes || []).map((t) => {
        const name = String(t.name || '').trim();
        const key = name.toLowerCase();
        seen.add(key);
        return {
            name,
            parent: t.parent || null,
            is_active: t.is_active !== false,
            synced: counts.get(key) || 0,
        };
    });
    // A type with vouchers but no master row — the voucher-type pull missed it.
    const syncedOnly = [];
    for (const [key, n] of counts) {
        if (key && !seen.has(key)) syncedOnly.push({ name: key, synced: n });
    }
    const missing = types.filter((t) => t.is_active && t.synced === 0);
    return {
        types: types.sort((a, b) => b.synced - a.synced),
        missing,
        synced_only: syncedOnly,
        ok: missing.length === 0 && syncedOnly.length === 0,
    };
}

/** Tally's defined voucher types + how many of each actually synced. */
async function voucherTypeCoverage(db, companyId) {
    if (!(await db.schema.hasTable('tally_voucher_types'))) {
        return { unavailable: 'tally_voucher_types not migrated' };
    }
    const defined = await db('tally_voucher_types')
        .where('company_id', companyId).whereNull('deleted_at')
        .select('name', 'parent', 'is_active');
    if (!defined.length) {
        // The master has never synced, so there is nothing to compare against —
        // say so rather than reporting "no types missing", which reads as a pass.
        return { unavailable: 'no voucher types synced yet — run a sync first' };
    }
    const synced = await db('tally_voucher_entries')
        .where('company_id', companyId)
        .select('voucher_type').countDistinct('voucher_guid as vouchers')
        .groupBy('voucher_type');
    return compareVoucherTypes(defined, synced);
}

/**
 * DERIVED outstanding vs the figure TALLY itself reports, per party.
 *
 * Same shape of proof as reconcileLedgers, applied to ageing. The cloud derives
 * outstanding from the mirrored bill allocations; `tally_outstanding_bills`
 * holds Tally's own Bills Receivable / Payable verbatim. Two numbers from
 * different data by different paths — agreement is real evidence the ageing is
 * right, and disagreement names the party instead of "the ageing looks off".
 *
 * A party present on ONE side only is reported explicitly rather than skipped:
 * "we show a bill Tally does not" and "Tally shows a bill we lost" are the two
 * failures most worth catching, and both vanish under an inner-join comparison.
 *
 * @param {Array<{party, amount}>} derived   cloud-computed, one row per party
 * @param {Array<{party, amount}>} reported  rows from tally_outstanding_bills
 * @returns {{ok, parties, mismatches, missing_in_cloud, missing_in_tally, totals}}
 */
function reconcileOutstanding(derived, reported, opts = {}) {
    const tol = Number.isFinite(opts.tolerance) ? opts.tolerance : TOLERANCE;
    const sumBy = (rows) => {
        const m = new Map();
        for (const r of rows || []) {
            const key = String((r && r.party) || '').trim().toLowerCase();
            if (!key) continue;
            m.set(key, r2((m.get(key) || 0) + (Number(r.amount) || 0)));
        }
        return m;
    };
    const d = sumBy(derived);
    const t = sumBy(reported);

    const mismatches = [];
    const missingInCloud = [];   // Tally has it, we do not
    const missingInTally = [];   // we have it, Tally does not
    for (const [party, tallyAmt] of t) {
        if (!d.has(party)) { missingInCloud.push({ party, tally: tallyAmt }); continue; }
        const diff = r2(d.get(party) - tallyAmt);
        if (Math.abs(diff) > tol) {
            mismatches.push({ party, derived: d.get(party), tally: tallyAmt, difference: diff });
        }
    }
    for (const [party, derivedAmt] of d) {
        if (!t.has(party)) missingInTally.push({ party, derived: derivedAmt });
    }

    const total = (m) => r2([...m.values()].reduce((a, b) => a + b, 0));
    return {
        ok: !mismatches.length && !missingInCloud.length && !missingInTally.length,
        parties: d.size,
        mismatches,
        missing_in_cloud: missingInCloud,
        missing_in_tally: missingInTally,
        totals: { derived: total(d), tally: total(t), difference: r2(total(d) - total(t)) },
    };
}

/** Tally's own outstanding for one company, as [{party, amount}]. */
async function outstandingQuery(db, companyId, side = 'receivable') {
    if (!(await db.schema.hasTable('tally_outstanding_bills'))) return [];
    return db('tally_outstanding_bills')
        .where({ company_id: companyId, side })
        .select('party', 'amount');
}

/** Run all checks for one company. */
async function reconcileCompany(db, companyId, opts = {}) {
    const [ledgers, entries] = await Promise.all([
        ledgersQuery(db, companyId),
        entriesQuery(db, companyId),
    ]);
    return {
        company_id: companyId,
        ledgers: reconcileLedgers(ledgers, entries, opts),
        vouchers: reconcileVouchers(entries, opts),
        trial_balance: reconcileTrialBalance(entries, opts),
        voucher_types: await voucherTypeCoverage(db, companyId),
    };
}

module.exports = {
    TOLERANCE,
    reconcileLedgers,
    reconcileVouchers,
    reconcileTrialBalance,
    ledgersQuery,
    entriesQuery,
    compareVoucherTypes,
    voucherTypeCoverage,
    reconcileOutstanding,
    outstandingQuery,
    reconcileCompany,
};
