'use strict';

/**
 * Tenant migration 006 — repair Dr/Cr on already-imported voucher entries.
 *
 * The agent read a ledger entry's ISDEEMEDPOSITIVE with a DESCENDING tag search,
 * so when that entry nested a BILLALLOCATIONS / BANKALLOCATIONS / COSTCENTRE
 * allocation — each carrying its OWN ISDEEMEDPOSITIVE — the NESTED flag won and
 * the leg's Dr/Cr was inverted. The parser is fixed (tally_connector.py now
 * derives Dr/Cr from the amount sign, which Tally makes authoritative: a debit
 * is stored NEGATIVE), but rows already in the database still carry the wrong
 * flag, and nothing re-imports them because their AlterID has not changed.
 *
 * Measured on a live 4,442-voucher book before the fix:
 *     2,233 vouchers did not balance · Trial Balance out by ₹32.28 lakh
 *     2,529 of 25,461 legs (10%) had is_debit disagreeing with the amount sign
 * and after deriving Dr/Cr from the amount sign, ALL 4,442 balance to ₹0.00.
 *
 * This only rewrites `is_debit`; no amount is touched. A row where the flag and
 * the sign already agree is left alone, so the migration is a no-op on a healthy
 * database (licence 1 above: 0 rows).
 */

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable('tally_voucher_entries'))) return;

    const { rows: [before] } = await knex.raw(`
        SELECT count(*)::int AS bad FROM tally_voucher_entries
        WHERE amount <> 0 AND is_debit <> (amount < 0)
    `);
    if (!before.bad) return;

    // Tally's amount sign is the authority: negative = debit. Zero-amount legs
    // are left as-is — the sign cannot decide them, and they move no money.
    const repaired = await knex.raw(`
        UPDATE tally_voucher_entries SET is_debit = (amount < 0)
        WHERE amount <> 0 AND is_debit <> (amount < 0)
    `);
    console.warn(`  ! tally_voucher_entries: repaired Dr/Cr on ${repaired.rowCount} leg(s)`);

    const { rows: [after] } = await knex.raw(`
        SELECT count(*)::int AS unbalanced FROM (
            SELECT voucher_guid, sum(CASE WHEN is_debit THEN abs(amount) ELSE -abs(amount) END) AS net
            FROM tally_voucher_entries GROUP BY company_id, voucher_guid
        ) t WHERE abs(net) > 0.01
    `);
    console.warn(`  ! tally_voucher_entries: ${after.unbalanced} voucher(s) still unbalanced after repair`);
};

exports.down = async function down() {
    // Deliberately irreversible. The previous values were wrong — restoring them
    // would re-break the books. Re-running the pull rebuilds these rows from
    // Tally in any case.
};
