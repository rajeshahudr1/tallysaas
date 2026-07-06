'use strict';

/**
 * 20260101000039_normalize_seats_and_retire_approval.js
 *
 * DATA migration (no schema change). Manual approval is RETIRED — login is now
 * gated purely by users.status === 'Active' (the seat gate) + an active in-date
 * subscription. This normalises every existing license to that model:
 *
 *   1) Every non-deleted user → approval_status = 'approved' (the legacy column
 *      is kept but must stay consistent — always approved).
 *   2) The SAME seat reconciliation the runtime helper applies:
 *        • the license-admin (role slug 'company-admin', license_id set,
 *          company_id NULL) is forced Active and counts as the first seat,
 *        • the OTHER non-deleted users, oldest first (created_at asc, id asc),
 *          are Active up to max_users and the rest (newest excess) Inactive,
 *        • each Active user gets an active in-date subscription; each Inactive
 *          user's active subscription is expired/cancelled.
 *      A null/absent max_users is treated as UNLIMITED. The license-admin is
 *      NEVER deactivated.
 *
 * Reuses api/Helpers/seats.reconcileLicenseSeats, run with the migration's knex
 * (forUpdate is a harmless no-op outside a transaction; the migration runs
 * single-threaded so no concurrent reconcile races it).
 *
 * up() performs the one-way normalization. down() is a deliberate NO-OP — this
 * is an irreversible data fix (we cannot know which users were previously
 * pending/rejected, and re-introducing that state would break login).
 */

const { reconcileLicenseSeats } = require('../../Helpers/seats');

exports.up = async function up(knex) {
    // 1) Retire approval: every non-deleted user is approved.
    await knex('users').whereNull('deleted_at')
        .update({ approval_status: 'approved', updated_at: knex.fn.now() });

    // 2) Seat reconciliation per license (non-deleted licenses). Reuses the exact
    //    runtime helper so the migration and live behaviour can never drift.
    const licenses = await knex('licenses').whereNull('deleted_at').pluck('id');
    for (const licenseId of licenses) {
        await reconcileLicenseSeats(knex, licenseId);
    }
};

exports.down = async function down() {
    // Irreversible data fix: the previous pending/rejected/approval + status
    // state is not recoverable, and restoring it would re-break login. No-op.
};
