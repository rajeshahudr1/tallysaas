'use strict';

/**
 * api/Helpers/ledgerBalance.js
 *
 * Period-aware ledger balances, derived from the full double entry the agent
 * mirrors into `tally_voucher_entries`.
 *
 * WHY THIS EXISTS: `tally_ledgers.closing_balance` is a single snapshot as of
 * the last sync, so it cannot answer "what was this ledger's balance on 31 Jul,
 * and what moved during July?" — which is exactly what the Cash & Bank screens
 * and the dashboard's period picker ask. Replaying the postings does:
 *
 *   opening(from) = ledger opening balance + Σ signed(entries before `from`)
 *   closing(to)   = opening(from)          + Σ signed(entries within the range)
 *
 * Sign convention is Tally's: a debit is positive, a credit negative. So an
 * asset ledger (cash, bank, debtors) carries a positive balance = Dr, and a
 * liability ledger (creditors) a negative one = Cr.
 *
 * PURE — no db access, so it is unit-testable without a database.
 */

/**
 * One posting as a debit-positive accounting figure.
 *
 * CAREFUL — `tally_voucher_entries.amount` mirrors TALLY's sign, which is the
 * opposite of the accounting one: the agent's own note reads "a debit posts
 * ISDEEMEDPOSITIVE=Yes AMOUNT=-x, a credit No +x". So a debit is stored
 * NEGATIVE. We take the magnitude and re-sign it from `is_debit`, which also
 * keeps us right if a feed ever sends unsigned amounts.
 */
function signed(entry) {
    const amt = Math.abs(Number((entry && entry.amount) || 0));
    return (entry && entry.is_debit) ? amt : -amt;
}

// Normalise a date column (pg gives a Date, query params give a string) to
// 'YYYY-MM-DD' so range comparisons are plain string compares. Returns '' when
// there is no usable date.
function isoDay(v) {
    if (!v) return '';
    if (v instanceof Date) {
        const p = (n) => String(n).padStart(2, '0');
        return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    }
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
    return m ? m[1] : '';
}

/**
 * Replay one ledger's postings into opening / debit / credit / closing.
 *
 * @param {object} args
 * @param {number} [args.opening]  the ledger's opening balance (signed)
 * @param {Array<{voucher_date, amount, is_debit}>} [args.entries]
 * @param {string} [args.from]  'YYYY-MM-DD'; omit for "since the beginning"
 * @param {string} [args.to]    'YYYY-MM-DD'; omit for "up to the last entry"
 * @returns {{opening:number, debit:number, credit:number, closing:number}}
 */
function periodBalance(args) {
    const a = args || {};
    const from = isoDay(a.from);
    const to   = isoDay(a.to);

    let opening = Number(a.opening || 0);
    let debit   = 0;
    let credit  = 0;

    for (const e of a.entries || []) {
        const day = isoDay(e.voucher_date);

        // Before the range → folds into the opening balance.
        if (from && day && day < from) { opening += signed(e); continue; }
        // After the range → not our concern at all.
        if (to && day && day > to) continue;

        // In range (an undated entry counts as movement, never as opening —
        // we cannot claim it happened before a period we can't place it in).
        // Magnitudes, since the Dr and Cr columns are both positive totals.
        const amt = Math.abs(Number(e.amount || 0));
        if (e.is_debit) debit += amt; else credit += amt;
    }

    return { opening, debit, credit, closing: opening + debit - credit };
}

/**
 * Split a signed balance into the magnitude + the Dr/Cr marker the screens
 * print. A zero balance carries no marker, matching Tally.
 *
 * @param {number} balance
 * @returns {{amount:number, dc:'Dr'|'Cr'|''}}
 */
function drCr(balance) {
    const n = Number(balance || 0);
    if (n === 0) return { amount: 0, dc: '' };
    return { amount: Math.abs(n), dc: n > 0 ? 'Dr' : 'Cr' };
}

module.exports = { signed, isoDay, periodBalance, drCr };
