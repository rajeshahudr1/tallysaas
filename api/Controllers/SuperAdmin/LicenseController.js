'use strict';

/**
 * api/Controllers/SuperAdmin/LicenseController.js
 *
 * Super-Admin license management. A license = one Tally install / customer.
 * The secret key is shown EXACTLY ONCE (on create); afterwards only the
 * non-secret prefix is visible.
 *
 *   create        POST   /super-admin/licenses
 *   list          GET    /super-admin/licenses
 *   resetMachine  POST   /super-admin/licenses/:id/reset-machine
 *   suspend       POST   /super-admin/licenses/:id/suspend
 *   activate      POST   /super-admin/licenses/:id/activate
 */

const R          = require('../../Helpers/response');
const licenseKey = require('../../Helpers/licenseKey');
const db         = require('../../config/db').db;

const NOT_FOUND = 'License not found.';

async function create(req, res) {
    try {
        const b = req.body;
        const { key, prefix, hash } = licenseKey.generate();

        const [row] = await db('licenses').insert({
            license_key_hash: hash,
            key_prefix:       prefix,
            holder_name:      b.holder_name,
            tally_serial:     b.tally_serial || null,
            plan:             b.plan || 'standard',
            max_companies:    b.max_companies != null ? b.max_companies : 5,
            max_users:        b.max_users != null ? b.max_users : 10,
            valid_until:      b.valid_until || null,
            status:           'active',
            created_by:       req.user ? req.user.sub : null,
        }).returning('*');

        // The clear key is returned ONLY here — store it safely now.
        return R.successResponse(res, {
            license_key: key,                 // shown once
            license: {
                id: row.id, key_prefix: row.key_prefix, holder_name: row.holder_name,
                plan: row.plan, max_companies: row.max_companies, max_users: row.max_users,
                valid_until: row.valid_until, status: row.status,
            },
        }, 'License created. Copy the key now — it will not be shown again.');
    } catch (err) {
        console.error('LicenseController.create error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

async function list(req, res) {
    try {
        const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
        const perPage = Math.min(100, parseInt(req.query.per_page, 10) || 20);

        // Qualify deleted_at — the join below also has a deleted_at column.
        const base = db('licenses').whereNull('licenses.deleted_at');
        const [{ count }] = await base.clone().count({ count: '*' });

        const rows = await base.clone()
            .leftJoin('companies', function () {
                this.on('companies.license_id', 'licenses.id').andOnNull('companies.deleted_at');
            })
            .groupBy('licenses.id')
            .select(
                'licenses.id', 'licenses.key_prefix', 'licenses.holder_name', 'licenses.tally_serial',
                'licenses.plan', 'licenses.max_companies', 'licenses.max_users', 'licenses.valid_until',
                'licenses.status', 'licenses.machine_id', 'licenses.machine_bound_at',
                'licenses.last_seen_at', 'licenses.agent_version', 'licenses.created_at',
            )
            .count({ companies_count: 'companies.id' })
            .orderBy('licenses.id', 'desc')
            .limit(perPage).offset((page - 1) * perPage);

        return R.successResponse(res, {
            data: rows,
            meta: { total: Number(count), page, per_page: perPage },
        });
    } catch (err) {
        console.error('LicenseController.list error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

async function resetMachine(req, res) {
    try {
        const lic = await db('licenses').where('id', req.params.id).whereNull('deleted_at').first();
        if (!lic) return R.errorResponse(res, NOT_FOUND, 404);
        await db('licenses').where('id', lic.id).update({
            machine_id: null, machine_bound_at: null, updated_at: new Date(),
        });
        return R.successResponse(res, { id: lic.id }, 'Machine binding reset. The agent can be activated on a new machine.');
    } catch (err) {
        console.error('LicenseController.resetMachine error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

async function setStatus(req, res, status, msg) {
    try {
        const lic = await db('licenses').where('id', req.params.id).whereNull('deleted_at').first();
        if (!lic) return R.errorResponse(res, NOT_FOUND, 404);
        await db('licenses').where('id', lic.id).update({ status, updated_at: new Date() });
        return R.successResponse(res, { id: lic.id, status }, msg);
    } catch (err) {
        console.error('LicenseController.setStatus error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

const suspend  = (req, res) => setStatus(req, res, 'suspended', 'License suspended.');
const activate = (req, res) => setStatus(req, res, 'active', 'License re-activated.');

module.exports = { create, list, resetMachine, suspend, activate };
