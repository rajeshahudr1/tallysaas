'use strict';

/**
 * api/Helpers/bankReconcile.js
 *
 * Import bank-statement lines and auto-match them to payment / receipt vouchers.
 * A CREDIT (money in, amount > 0) matches a RECEIPT; a DEBIT (money out,
 * amount < 0) matches a PAYMENT — by absolute amount + a ±3-day date window,
 * skipping vouchers already matched to another bank line.
 */

const db = require('../config/db').db;

// pg returns a `date` column as a Date OBJECT — String(date).slice(0,10) would
// give "Wed Jun 10". Coerce a Date or a raw string to a clean 'YYYY-MM-DD'.
function toYmd(v) {
    if (!v) return null;
    if (v instanceof Date) {
        return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    }
    const s = String(v);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

/** Find the best unmatched payment/receipt for a bank line, or null. */
async function findMatch(conn, companyId, bankTxn) {
    const abs = Math.abs(Number(bankTxn.amount) || 0);
    if (abs <= 0 || !bankTxn.txn_date) return null;
    const type = bankTxn.direction === 'credit' ? 'receipt' : 'payment';
    const date = toYmd(bankTxn.txn_date);

    // Voucher ids of this type already claimed by a bank line.
    const claimed = conn('bank_transactions')
        .where({ company_id: companyId, matched_type: type })
        .whereNotNull('matched_id').whereNull('deleted_at')
        .select('matched_id');

    const cand = await conn('payments')
        .where({ company_id: companyId, type })
        .whereNull('deleted_at')
        .where('amount', abs)
        .whereRaw('abs(payment_date - ?::date) <= 3', [date])
        .whereNotIn('id', claimed)
        .orderByRaw('abs(payment_date - ?::date) asc', [date])
        .first('id');
    return cand ? cand.id : null;
}

/** Insert statement rows + auto-match each. rows: [{txn_date, description, reference, amount}]
 * (amount SIGNED: + credit / − debit). Returns { imported, matched }. */
async function importAndMatch(companyId, rows, batch) {
    let imported = 0, matched = 0;
    await db.transaction(async (trx) => {
        for (const r of rows) {
            const amount = Number(r.amount) || 0;
            if (!amount) continue;
            const direction = amount >= 0 ? 'credit' : 'debit';
            const [bt] = await trx('bank_transactions').insert({
                company_id:  companyId,
                txn_date:    r.txn_date || null,
                description: r.description || null,
                reference:   r.reference || null,
                amount,
                direction,
                status:      'unmatched',
                batch,
            }).returning('*');
            imported += 1;

            const mid = await findMatch(trx, companyId, bt);
            if (mid) {
                await trx('bank_transactions').where('id', bt.id).update({
                    status:      'matched',
                    matched_type: direction === 'credit' ? 'receipt' : 'payment',
                    matched_id:  mid,
                    matched_at:  new Date(),
                });
                matched += 1;
            }
        }
    });
    return { imported, matched };
}

module.exports = { importAndMatch, findMatch };
