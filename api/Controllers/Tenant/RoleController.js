'use strict';

/**
 * api/Controllers/Tenant/RoleController.js
 *
 * Read-only roles list — backs the Role dropdown on the Add/Edit User form
 * (the user create endpoint needs a role_id). Roles are GLOBAL (not
 * company-scoped); the Super Admin role is excluded so tenant admins can't
 * mint a platform super-admin. Returns the standard { data, meta } envelope
 * so the web tier's fetchOptions() helper can consume it directly.
 */

const R  = require('../../Helpers/response');
const db = require('../../config/db').db;

async function list(req, res) {
    try {
        const rows = await db('roles')
            .whereNot('slug', 'super-admin')
            .orderBy('id', 'asc')
            .select('id', 'name', 'slug');

        return R.successResponse(res, {
            data: rows,
            meta: { total: rows.length, page: 1, per_page: rows.length },
        });
    } catch (err) {
        console.error('RoleController.list error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

module.exports = { list };
