'use strict';

/**
 * api/Helpers/voucherNumber.js
 *
 * Voucher numbering: TLR_26_27_4 — app prefix, financial year, serial.
 *
 * The three parts each answer a question you actually ask of a voucher number:
 * WHERE it came from (TLR), WHICH books it belongs to (26_27 — India's Apr–Mar
 * financial year, not the calendar year), and WHICH one it is (a serial that
 * restarts every year, so it stays a number a human can say out loud).
 *
 * The serial is derived from what is already saved (the highest serial on this
 * company's vouchers for this prefix + year), never from a counter table:
 * a counter and the rows can disagree — after a restore, an import, or a
 * deleted row — and then the number the form promised is not the number that
 * gets saved.
 *
 * Because it is derived, it is a PREVIEW, not a reservation. Two people on the
 * create screen at the same second both see …_4. That is why the save path
 * calls this again inside its transaction and the number column carries a
 * unique index: the second one lands on _5. The form's job is to show a
 * realistic number, not to hold one.
 */

const APP_PREFIX = 'TLR';

/** Indian financial year (1 April – 31 March) as "26_27". */
function financialYearLabel(date) {
    const d = date ? new Date(date) : new Date();
    const dt = Number.isNaN(d.getTime()) ? new Date() : d;
    // Jan–Mar still belong to the year that started the previous April.
    const startYear = dt.getMonth() >= 3 ? dt.getFullYear() : dt.getFullYear() - 1;
    const yy = (n) => String(n % 100).padStart(2, '0');
    return `${yy(startYear)}_${yy(startYear + 1)}`;
}

/** "TLR_26_27_" — everything before the serial. */
function voucherNoPrefix(date, prefix) {
    return `${prefix || APP_PREFIX}_${financialYearLabel(date)}_`;
}

/**
 * The next serial for {company, table, column} under this prefix.
 *
 * `qb` is a knex instance OR a transaction — the save path passes its trx so
 * the read sits inside the same transaction as the insert.
 *
 * Only rows whose number is exactly `<prefix><digits>` count. A custom number
 * someone typed by hand ("REV-2") is deliberately ignored: it is not part of
 * this series, and letting it in would either break the parse or jump the
 * series to a number nobody chose.
 */
async function nextVoucherNo(qb, { companyId, table, column, date, prefix }) {
    const head = voucherNoPrefix(date, prefix);
    const rows = await qb(table)
        .where('company_id', companyId)
        .where(column, 'like', `${head}%`)
        .select(column);

    let max = 0;
    const re = new RegExp(`^${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
    for (const r of rows) {
        const m = re.exec(String(r[column] || ''));
        if (m) {
            const n = Number(m[1]);
            if (n > max) max = n;
        }
    }
    return `${head}${max + 1}`;
}

module.exports = { APP_PREFIX, financialYearLabel, voucherNoPrefix, nextVoucherNo };
