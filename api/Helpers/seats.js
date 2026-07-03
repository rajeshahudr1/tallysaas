'use strict';

/**
 * api/Helpers/seats.js
 *
 * Count-based SEAT enforcement (no manual approval). A license allows
 * `max_users` ACTIVE users:
 *   • The LICENSE-ADMIN (role slug 'company-admin', license_id set, company_id
 *     NULL) is ALWAYS Active and counts as one seat. It is NEVER deactivated.
 *   • Among the OTHER non-deleted users of the license, the OLDEST by created_at
 *     (id asc as a tie-break) are Active up to the cap; the rest (the newest
 *     excess beyond the seat count) are system-DEACTIVATED (status = 'Inactive').
 *
 * Login is gated purely by users.status === 'Active' + an active in-date
 * subscription. So:
 *   • every user we flip to Active gets an active in-date subscription row
 *     provisioned (mirrors the old UserApprovalController.approve()),
 *   • every user we flip to Inactive has its active subscription expired
 *     (mirrors the old reject()).
 *
 * Runs INSIDE a transaction with a row lock on the license (forUpdate), so two
 * concurrent reconciles on the same license can't both pass the cap and
 * overshoot. Excludes soft-deleted rows everywhere. A null/absent max_users is
 * treated as UNLIMITED (everyone Active).
 *
 *   reconcileLicenseSeats(trx, licenseId) → { active, deactivated }
 */

const db = require('../config/db').db;
const masterDb = require('../config/masterDb').db;          // seats live in the master control plane
const { getKnexForLicense } = require('../config/tenantDb');  // for mirroring status to the tenant

// "YYYY-MM-DD" for a Date / ms / ISO input.
function isoDate(d) {
    return new Date(d).toISOString().slice(0, 10);
}

/**
 * Ensure the user has an active, in-date subscription row (idempotent). Mirrors
 * the seat-provisioning the old approve() did: uses the license plan + the
 * license valid_until (or ~10y when the license never expires).
 */
async function ensureActiveSubscription(trx, userId, license, today) {
    const existing = await trx('subscriptions')
        .where({ user_id: userId, status: 'active' })
        .where('valid_until', '>=', today)
        .first('id');
    if (existing) return;

    const validUntil = (license && license.valid_until)
        ? isoDate(license.valid_until)
        : isoDate(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000); // ~10y
    const plan = (license && license.plan) || 'standard';

    await trx('subscriptions').insert({
        user_id:     userId,
        plan,
        valid_from:  today,
        valid_until: validUntil,
        status:      'active',
    });
}

/** Expire/cancel any active subscription for the user (mirrors old reject()). */
async function expireActiveSubscription(trx, userId) {
    await trx('subscriptions')
        .where({ user_id: userId, status: 'active' })
        .update({ status: 'cancelled', updated_at: new Date() });
}

/**
 * Reconcile the Active/Inactive seat state of every user under a license.
 *
 * @param {import('knex').Knex.Transaction} trx — an OPEN transaction (the caller
 *        owns the commit). The license is locked FOR UPDATE here.
 * @param {number} licenseId
 * @returns {Promise<{active:number, deactivated:number}>}
 */
async function reconcileLicenseSeats(trx, licenseId) {
    if (!licenseId) return { active: 0, deactivated: 0 };

    // Row-lock the license so concurrent reconciles serialise on it.
    const license = await trx('licenses')
        .where('id', licenseId).whereNull('deleted_at')
        .forUpdate()
        .first('id', 'plan', 'valid_until', 'max_users');
    if (!license) return { active: 0, deactivated: 0 };

    const today = isoDate(Date.now());
    // null/absent max_users → unlimited seats.
    const maxUsers = (license.max_users == null) ? null : Number(license.max_users);

    // Identify the license-admin: role slug 'company-admin', this license,
    // company_id NULL. It is ALWAYS Active and counts as the first seat.
    // master.users carries a denormalised role_slug (roles live in tenant dbs),
    // so match it directly instead of joining the (tenant-only) roles table.
    const admin = await trx('users as u')
        .where('u.license_id', licenseId)
        .whereNull('u.company_id')
        .whereNull('u.deleted_at')
        .where('u.role_slug', 'company-admin')
        .orderBy('u.created_at', 'asc').orderBy('u.id', 'asc')
        .first('u.id', 'u.status');
    const adminId = admin ? admin.id : null;

    let active = 0;
    let deactivated = 0;

    // Force the license-admin Active + ensure its seat (NEVER deactivate it).
    if (adminId) {
        if (admin.status !== 'Active') {
            await trx('users').where('id', adminId)
                .update({ status: 'Active', updated_at: new Date() });
        }
        await ensureActiveSubscription(trx, adminId, license, today);
        active += 1;
    }

    // The OTHER non-deleted users of the license, oldest first (id asc tie-break).
    const others = await trx('users')
        .where('license_id', licenseId)
        .whereNull('deleted_at')
        .modify((qb) => { if (adminId) qb.whereNot('id', adminId); })
        .orderBy('created_at', 'asc').orderBy('id', 'asc')
        .select('id', 'status');

    // Seats left for the OTHER users (the admin already took one when present).
    const otherCap = (maxUsers == null)
        ? others.length                               // unlimited
        : Math.max(0, maxUsers - (adminId ? 1 : 0));

    for (let i = 0; i < others.length; i += 1) {
        const u = others[i];
        const shouldBeActive = i < otherCap;
        if (shouldBeActive) {
            if (u.status !== 'Active') {
                await trx('users').where('id', u.id)
                    .update({ status: 'Active', updated_at: new Date() });
            }
            await ensureActiveSubscription(trx, u.id, license, today);
            active += 1;
        } else {
            // Over the seat cap → system-deactivate. Only flip rows that are
            // currently Active (leave an admin-set 'Blocked' alone — Blocked is
            // already a non-login state and is not a seat we provisioned).
            if (u.status === 'Active') {
                await trx('users').where('id', u.id)
                    .update({ status: 'Inactive', updated_at: new Date() });
            }
            await expireActiveSubscription(trx, u.id);
            deactivated += 1;
        }
    }

    return { active, deactivated };
}

/**
 * Mirror every master.users status for a licence onto its tenant.users mirror
 * rows. Seats are a MASTER concern (subscriptions + master.users.status drive
 * login), but the tenant keeps a same-id user mirror for its FKs + user list —
 * this keeps that mirror's `status` column consistent after a reconcile. Cross-DB
 * (master read → tenant write), so it CANNOT share the reconcile's master txn;
 * best-effort, batched by status. `tenantDb` may be passed to reuse a knex.
 */
async function mirrorSeatStatusToTenant(licenseId, tenantDb) {
    if (!licenseId) return;
    const rows = await masterDb('users')
        .where('license_id', licenseId).whereNull('deleted_at')
        .select('id', 'status');
    if (!rows.length) return;
    const tdb = tenantDb || getKnexForLicense(licenseId);
    const byStatus = rows.reduce((m, r) => {
        (m[r.status] = m[r.status] || []).push(r.id);
        return m;
    }, {});
    for (const [status, ids] of Object.entries(byStatus)) {
        await tdb('users').whereIn('id', ids).update({ status, updated_at: new Date() });
    }
}

/**
 * Convenience wrapper: reconcile a licence's seats in its OWN master transaction
 * (the reconcile touches ONLY master-plane tables — licenses / users / subscriptions),
 * then mirror the resulting statuses onto the tenant user rows. Used by callers
 * (LicenseController.update, the user dual-write helper) that aren't already in a txn.
 */
async function reconcileLicenseSeatsTx(licenseId) {
    const result = await masterDb.transaction((trx) => reconcileLicenseSeats(trx, licenseId));
    await mirrorSeatStatusToTenant(licenseId).catch((e) =>
        console.error('[seats] mirror status to tenant failed:', e && e.message));
    return result;
}

module.exports = {
    reconcileLicenseSeats,
    reconcileLicenseSeatsTx,
    mirrorSeatStatusToTenant,
    // exported for the data migration / reuse
    ensureActiveSubscription,
    expireActiveSubscription,
    isoDate,
};
