'use strict';

/**
 * api/Helpers/entitlements.js
 *
 * Per-license module/permission ENTITLEMENTS — the set of permissions a
 * license's roles may be granted (license_permissions table, Phase C).
 *
 * Rule: if a license has explicit license_permissions rows, those define the
 * entitled set. If it has NONE, the license is treated as entitled to ALL
 * permissions (so existing licenses without explicit grants keep working). The
 * Super Admin restricts a license by inserting an explicit subset; new licenses
 * are granted ALL on creation (LicenseController.create → grantAllToLicense).
 *
 * A license-admin building a custom role may only assign permissions inside this
 * entitled set — enforced server-side when setting role permissions.
 */

const db = require('../config/db').db;

/** Every permission id in the catalogue (the "ALL" fallback). */
async function allPermissionIds(conn) {
    const rows = await (conn || db)('permissions').select('id');
    return rows.map((r) => r.id);
}

/**
 * The permission ids a license is entitled to. Explicit grants if any, else ALL.
 * Pass a trx as `conn` to read within a transaction.
 */
async function licensePermissionIds(licenseId, conn) {
    const c = conn || db;
    if (!licenseId) return allPermissionIds(c);
    const rows = await c('license_permissions').where('license_id', licenseId).select('permission_id');
    if (rows.length) return rows.map((r) => r.permission_id);
    return allPermissionIds(c);
}

/** The permission slugs a license is entitled to (for filtering role grants). */
async function licensePermissionSlugs(licenseId, conn) {
    const c = conn || db;
    const ids = await licensePermissionIds(licenseId, c);
    if (!ids.length) return [];
    const rows = await c('permissions').whereIn('id', ids).select('slug');
    return rows.map((r) => r.slug);
}

/**
 * Grant ALL current permissions to a license (delete-then-insert = idempotent).
 * Called on license creation so a fresh license is explicitly all-access; the
 * Super Admin can then restrict it.
 */
async function grantAllToLicense(conn, licenseId) {
    const c = conn || db;
    const perms = await c('permissions').select('id');
    await c('license_permissions').where('license_id', licenseId).del();
    if (perms.length) {
        await c('license_permissions').insert(
            perms.map((p) => ({ license_id: licenseId, permission_id: p.id })),
        );
    }
}

module.exports = {
    allPermissionIds,
    licensePermissionIds,
    licensePermissionSlugs,
    grantAllToLicense,
};
