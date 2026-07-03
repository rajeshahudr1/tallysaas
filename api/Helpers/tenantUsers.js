'use strict';

/**
 * api/Helpers/tenantUsers.js
 *
 * Dual-write helpers for LICENSED users under the per-license DB split. A user
 * straddles two databases:
 *   • MASTER (tallysaas_master.users) — the LOGIN identity + password + a
 *     denormalised role_slug. This is what auth reads (login / session / seat
 *     enforcement), across every licence.
 *   • TENANT (tally_lic_<id>.users) — a same-id MIRROR so business FKs resolve
 *     (created_by, sales_persons.user_id, approvals, the tenant user list, …).
 *
 * Every user-creating flow (Users, Accountant invite, Sales-person login) MUST
 * write BOTH, keep the id identical, and reconcile the licence seats on master —
 * so this centralises that instead of each controller re-deriving it (and
 * silently 500ing when a reconcile hit the tenant db instead of master).
 */

const masterDb = require('../config/masterDb').db;
const { getKnexForLicense } = require('../config/tenantDb');
const { reconcileLicenseSeatsTx } = require('./seats');

const DEFAULT_RETURN = ['id', 'company_id', 'license_id', 'role_id', 'name', 'email',
    'mobile', 'status', 'approval_status', 'location_id', 'created_at'];

/**
 * Is this email already a LOGIN (any licence's master.users) or a sales person of
 * THIS licence (tenant.sales_persons)? The email is the global login identity, so
 * the users check spans ALL licences (master); sales_persons is per-licence.
 * Soft-deleted rows are ignored. Pass exceptUserId / exceptSalesPersonId to skip
 * the same person's own rows when editing.
 */
async function emailTakenAcrossPlanes(email, licenseId, opts = {}) {
    const e = String(email || '').trim().toLowerCase();
    if (!e) return false;

    const uq = masterDb('users').whereNull('deleted_at').whereRaw('lower(email) = ?', [e]);
    if (opts.exceptUserId) uq.whereNot('id', opts.exceptUserId);
    if (await uq.first('id')) return true;

    if (licenseId) {
        const tdb = getKnexForLicense(licenseId);
        const sq = tdb('sales_persons').whereNull('deleted_at').whereRaw('lower(email) = ?', [e]);
        if (opts.exceptSalesPersonId) sq.whereNot('id', opts.exceptSalesPersonId);
        if (await sq.first('id')) return true;
    }
    return false;
}

/**
 * Create a licensed user across both planes. `base` is the shared column set
 * (NO id, NO role_slug) and MUST carry license_id. Writes master first (mints the
 * id), mirrors into the tenant at the SAME id, reconciles the licence seats (which
 * may flip the new user Inactive when over the seat cap) and mirrors the resulting
 * status back. If the tenant mirror insert fails, the orphan master login is
 * rolled back so no login exists without a tenant identity.
 *
 * @returns the created master row (returning cols) with its post-reconcile status.
 */
async function createLicensedUser(base, roleSlug, returningCols) {
    const licenseId = base.license_id || null;
    const tenantDb = licenseId ? getKnexForLicense(licenseId) : null;
    const cols = returningCols || DEFAULT_RETURN;

    const [mu] = await masterDb('users').insert({ ...base, role_slug: roleSlug }).returning(cols);

    if (tenantDb) {
        try {
            await tenantDb('users').insert({ id: mu.id, ...base });
            // Keep the tenant sequence ahead of the id we forced in.
            await tenantDb.raw("SELECT setval(pg_get_serial_sequence('users','id'), (SELECT COALESCE(MAX(id),1) FROM users))");
        } catch (err) {
            // Cross-DB partial failure: the master login was created but the tenant
            // mirror failed. Roll the orphan master row back (best-effort) so we
            // never leave a login with no tenant identity, then surface the error.
            await masterDb('users').where('id', mu.id).del().catch(() => {});
            throw err;
        }
    }

    if (licenseId) {
        await reconcileLicenseSeatsTx(licenseId);     // reconciles master + mirrors ALL statuses to tenant
        const fresh = await masterDb('users').where('id', mu.id).first('status');
        if (fresh) mu.status = fresh.status;
    }
    return mu;
}

/**
 * Patch an existing licensed user on BOTH planes (login role/status/email/password
 * on master + the tenant mirror), then optionally reconcile the licence seats.
 * `patchFor(knex)` builds the update object per-plane so it can use knex.raw
 * (e.g. an email tombstone on revoke). Returns the fresh master status.
 */
async function patchLicensedUser(userId, licenseId, patchFor, opts = {}) {
    const tenantDb = licenseId ? getKnexForLicense(licenseId) : null;

    await masterDb('users').where('id', userId).update(patchFor(masterDb));
    if (tenantDb) {
        await tenantDb('users').where('id', userId).update(patchFor(tenantDb))
            .catch((e) => console.error('[tenantUsers] tenant mirror patch failed:', e && e.message));
    }
    if (opts.reconcile !== false && licenseId) {
        await reconcileLicenseSeatsTx(licenseId);   // reconciles + mirrors statuses
    }
    const fresh = await masterDb('users').where('id', userId).first('status');
    return fresh ? fresh.status : null;
}

module.exports = {
    emailTakenAcrossPlanes,
    createLicensedUser,
    patchLicensedUser,
};
