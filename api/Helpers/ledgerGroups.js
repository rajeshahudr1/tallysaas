'use strict';

/**
 * api/Helpers/ledgerGroups.js
 *
 * Classifies Tally ledgers into the buckets the dashboard and the Cash & Bank
 * screens work in: cash, bank, payables, receivables.
 *
 * Tally models accounts as a tree: a ledger names its immediate parent group,
 * and groups name their own parent, up to one of ~15 top-level primary groups.
 *
 * WHY WE DO NOT USE `primary_group`:
 *   Tally's PRIMARYGROUP for "Cash-in-hand" is "Current Assets" — the same
 *   answer it gives for "Sundry Debtors". Bucketing on it would lump cash and
 *   receivables together. What actually identifies a bucket is Tally's RESERVED
 *   group names, which sit partway up the chain. So we walk the parent chain
 *   and match ancestor NAMES against those reserved names, and only fall back
 *   to `primary_group` when the chain gives us nothing (a hand-made group whose
 *   parent was never synced).
 *
 * This means bucketing works off `tally_groups.parent`, which the agent has
 * always populated — no re-sync and no agent change is required.
 *
 * PURE — no db access, so it is unit-testable without a database.
 */

// Tally reserved group name → bucket. Matched case-insensitively after trimming.
const RESERVED = {
    'cash-in-hand':     'cash',
    'bank accounts':    'bank',
    'bank od a/c':      'bank',
    'bank occ a/c':     'bank',
    'sundry creditors': 'payables',
    'sundry debtors':   'receivables',
};

// Guard against a malformed group tree with a parent cycle.
const MAX_DEPTH = 20;

const BUCKETS = ['cash', 'bank', 'payables', 'receivables'];

/**
 * A stored tally_ledgers balance as a debit-positive accounting figure.
 *
 * CAREFUL — the column mirrors TALLY's sign, which is inverted: a DEBIT balance
 * is stored NEGATIVE (real data: Cash, an asset, sits at -4720072.06). Flipping
 * it here is what makes Cash read "Dr" and a creditor read "Cr", as Tally and
 * the reference product both print them.
 */
function accountingBalance(stored) {
    return -Number(stored || 0);
}

/** A single group name → its bucket, or null when it is not a reserved group. */
function bucketFor(groupName) {
    const key = String(groupName || '').trim().toLowerCase();
    return RESERVED[key] || null;
}

/**
 * Map every group name → its bucket (or null), by walking the parent chain and
 * taking the FIRST reserved ancestor. A group that is itself reserved buckets
 * to itself; a non-reserved top-level group (Current Assets, …) buckets to
 * null, so it can never double-count its children.
 *
 * @param {Array<{name:string,parent:string|null,primary_group:string|null}>} groups
 * @returns {Map<string, string|null>}
 */
function resolveBuckets(groups) {
    const byName = new Map();
    for (const g of groups || []) byName.set(g.name, g);

    const out = new Map();
    for (const g of groups || []) {
        let node = g;
        let depth = 0;
        let found = null;

        while (node && depth < MAX_DEPTH) {
            const b = bucketFor(node.name);
            if (b) { found = b; break; }
            node = byName.get(node.parent);
            depth += 1;
        }

        // Chain gave us nothing — accept a reserved name in primary_group if the
        // sync happened to record one.
        if (!found) found = bucketFor(g.primary_group);

        out.set(g.name, found);
    }
    return out;
}

/**
 * Map every group name → the primary group at the top of its parent chain.
 * Kept for reporting (Balance Sheet grouping); NOT used for bucketing — see the
 * note in this file's header.
 *
 * @returns {Map<string, string|null>}
 */
function resolvePrimaryGroups(groups) {
    const byName = new Map();
    for (const g of groups || []) byName.set(g.name, g);

    const out = new Map();
    for (const g of groups || []) {
        let node = g;
        let depth = 0;
        let found = null;
        while (node && depth < MAX_DEPTH) {
            if (node.primary_group) { found = node.primary_group; break; }
            node = byName.get(node.parent);
            depth += 1;
        }
        out.set(g.name, found);
    }
    return out;
}

/**
 * Sum ledger closing balances into { cash, bank, payables, receivables }.
 *
 * Creditor balances are negative in Tally's sign convention, so payables is
 * returned as an absolute (positive) figure — the screens show an amount owed,
 * not a signed balance. Receivables is likewise absolute.
 *
 * @param {Array<{parent:string|null,closing_balance:string|number|null}>} ledgers
 * @param {Array<{name,parent,primary_group}>} groups
 * @returns {{cash:number,bank:number,payables:number,receivables:number}}
 */
function sumBalances(ledgers, groups) {
    const bucketOf = resolveBuckets(groups);
    const out = { cash: 0, bank: 0, payables: 0, receivables: 0 };

    for (const l of ledgers || []) {
        const bucket = bucketOf.get(l.parent);
        if (!bucket) continue;
        out[bucket] += accountingBalance(l.closing_balance);
    }

    out.payables    = Math.abs(out.payables);
    out.receivables = Math.abs(out.receivables);
    return out;
}

module.exports = {
    BUCKETS, RESERVED, accountingBalance,
    bucketFor, resolveBuckets, resolvePrimaryGroups, sumBalances,
};
