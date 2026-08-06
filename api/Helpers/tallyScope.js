'use strict';

/**
 * api/Helpers/tallyScope.js
 *
 * ONE definition of "which mirrored Tally rows still count", shared by every
 * read path.
 *
 * WHY THIS EXISTS: the agent never removes anything. `/agent/reconcile`
 * soft-deletes masters Tally stopped listing and `/agent/voucher-diff`
 * soft-deletes vouchers Tally no longer holds — both stamp `deleted_at` and
 * leave the row in place, so the audit trail survives and a mis-fired reconcile
 * is reversible. That is only half a delete: until every reader excludes those
 * rows, a ledger deleted in Tally keeps appearing on screen and a deleted
 * voucher's postings keep counting towards every balance and report. The cloud
 * then disagrees with Tally by exactly the deleted amount, with nothing in the
 * logs to show why.
 *
 * The voucher rule has THREE parts, not one — a posting counts only when its
 * header is not deleted, not cancelled and not optional. Tally itself leaves
 * cancelled and optional vouchers out of its registers and closing balances, so
 * a mirror that includes them mismatches on every draft voucher in the company.
 *
 * The header lives in `tally_vouchers` and the postings in
 * `tally_voucher_entries` / `tally_inventory_entries`, which carry no
 * `deleted_at` of their own — hence the join. A LEFT join with an explicit
 * "header not mirrored yet" branch keeps entries that arrived before their
 * header (the importer writes them in that order, so an inner join would make a
 * mid-sync read silently under-report).
 */

/**
 * Constrain a query already joined to a voucher header aliased `v` to the
 * vouchers that still count. Exported so a caller that builds its own join
 * (a raw CTE, a different alias set) can apply the identical rule.
 *
 * @param {import('knex').Knex.QueryBuilder} qb
 * @param {string} [alias='v']  the voucher-header alias in `qb`
 */
function whereVoucherLive(qb, alias = 'v') {
    return qb.where((w) => w
        .whereNull(`${alias}.guid`)                       // header not mirrored yet
        .orWhere((x) => x
            .where(`${alias}.is_cancelled`, false)
            .where(`${alias}.is_optional`, false)
            .whereNull(`${alias}.deleted_at`)));
}

/**
 * `tally_voucher_entries` (alias `e`) left-joined to its header (alias `v`) and
 * scoped to the live vouchers of one company. SELECT nothing — the caller picks
 * its own columns, which must be `e.`/`v.`-qualified.
 *
 * @param {import('knex')} db
 * @param {number} companyId
 * @returns {import('knex').Knex.QueryBuilder}
 */
function liveVoucherEntries(db, companyId) {
    return whereVoucherLive(
        db('tally_voucher_entries as e')
            .leftJoin('tally_vouchers as v', function join() {
                this.on('v.company_id', '=', 'e.company_id')
                    .andOn('v.guid', '=', 'e.voucher_guid');
            })
            .where('e.company_id', companyId),
    );
}

/**
 * The same scope for `tally_inventory_entries` (alias `e`) — the stock side of
 * the double entry, which a deleted voucher must drop out of too or item
 * movement and closing stock drift from Tally the same way balances do.
 *
 * @param {import('knex')} db
 * @param {number} companyId
 * @returns {import('knex').Knex.QueryBuilder}
 */
function liveInventoryEntries(db, companyId) {
    return whereVoucherLive(
        db('tally_inventory_entries as e')
            .leftJoin('tally_vouchers as v', function join() {
                this.on('v.company_id', '=', 'e.company_id')
                    .andOn('v.guid', '=', 'e.voucher_guid');
            })
            .where('e.company_id', companyId),
    );
}

/**
 * SQL fragment form, for the handful of reports that run a raw aggregate over
 * `tally_voucher_entries` instead of a builder. Kept here so the rule cannot
 * drift between the builder and the raw paths.
 *
 * Correlated rather than joined: it drops into an existing WHERE with no change
 * to the surrounding FROM.
 *
 * @param {string} [entriesAlias]  alias of tally_voucher_entries in the query
 */
function liveVoucherSql(entriesAlias = 'tally_voucher_entries') {
    return `not exists (
        select 1 from tally_vouchers v
         where v.company_id = ${entriesAlias}.company_id
           and v.guid = ${entriesAlias}.voucher_guid
           and (v.deleted_at is not null or v.is_cancelled = true or v.is_optional = true)
    )`;
}

module.exports = {
    whereVoucherLive,
    liveVoucherEntries,
    liveInventoryEntries,
    liveVoucherSql,
};
