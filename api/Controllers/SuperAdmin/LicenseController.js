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

const crypto       = require('node:crypto');
const R            = require('../../Helpers/response');
const licenseKey   = require('../../Helpers/licenseKey');
const passwords    = require('../../Helpers/passwords');
const entitlements = require('../../Helpers/entitlements');
const db           = require('../../config/db').db;

const NOT_FOUND = 'License not found.';

// A readable 12-char temp password (used when the caller doesn't supply one).
function tempPassword() {
    const raw = crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
    return (raw + 'a1B2c3D4').slice(0, 12);
}

// "YYYY-MM-DD" for a Date / ms / ISO input.
function isoDate(d) {
    return new Date(d).toISOString().slice(0, 10);
}

/**
 * POST /super-admin/licenses
 *
 * Creates a license AND its default "license-admin" user (the customer's super
 * user) in one transaction, so the customer can log in immediately:
 *   • license  — key generated; the clear key is returned ONCE (activates the agent).
 *   • admin    — role 'company-admin' (full permissions), company_id NULL so they
 *                can access EVERY company under this license, status 'Active'.
 *   • seat     — an active subscription is auto-created (AUTO-APPROVED), so the
 *                login subscription-gate passes without a separate approval step.
 * The admin password is taken from the body, or auto-generated + returned once.
 */
async function create(req, res) {
    try {
        const b = req.body;

        // The default admin needs the system 'company-admin' role (full perms).
        const adminRole = await db('roles')
            .where('slug', 'company-admin').whereNull('company_id').first();
        if (!adminRole) {
            return R.errorResponse(res, 'Server misconfigured: the company-admin role is missing. Run the seeds.', 500);
        }

        // Clearer than surfacing a raw unique-violation on users.email.
        const taken = await db('users').whereRaw('lower(email) = ?', [b.admin_email]).first('id');
        if (taken) {
            return R.errorResponse(res, 'A user with that admin email already exists.', 422);
        }

        const { key, prefix, hash } = licenseKey.generate();
        const generatedPw  = !(b.admin_password && b.admin_password.trim());
        const clearPassword = generatedPw ? tempPassword() : b.admin_password.trim();
        const passwordHash  = await passwords.hash(clearPassword);

        const today = isoDate(Date.now());
        // Seat window tracks the license expiry; if the license never expires,
        // default the seat to +10y so the admin can always sign in.
        const subValidUntil = b.valid_until
            ? isoDate(b.valid_until)
            : isoDate(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);

        const out = await db.transaction(async (trx) => {
            const [lic] = await trx('licenses').insert({
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

            const [admin] = await trx('users').insert({
                company_id:      null,           // NULL = all companies under this license
                license_id:      lic.id,
                role_id:         adminRole.id,
                name:            (b.admin_name && b.admin_name.trim()) || b.holder_name,
                email:           b.admin_email,
                mobile:          b.admin_mobile || null,
                password_hash:   passwordHash,
                status:          'Active',
                approval_status: 'approved',     // the default admin is auto-approved
                approved_at:     new Date(),
                approved_by:     req.user ? req.user.sub : null,
            }).returning(['id', 'name', 'email', 'approval_status']);

            await trx('subscriptions').insert({
                user_id:     admin.id,
                plan:        lic.plan,
                valid_from:  today,
                valid_until: subValidUntil,
                status:      'active',           // the auto-approved seat
            });

            // Entitle the new license to ALL modules by default; the Super Admin
            // can restrict it later from the license's permissions screen.
            await entitlements.grantAllToLicense(trx, lic.id);

            return { lic, admin };
        });

        // The clear key (always) + the temp password (only if auto-generated) are
        // returned ONCE — store them safely now.
        return R.successResponse(res, {
            license_key: key,
            admin_login: {
                email:    out.admin.email,
                password: generatedPw ? clearPassword : undefined,
            },
            license: {
                id: out.lic.id, key_prefix: out.lic.key_prefix, holder_name: out.lic.holder_name,
                plan: out.lic.plan, max_companies: out.lic.max_companies, max_users: out.lic.max_users,
                valid_until: out.lic.valid_until, status: out.lic.status,
            },
        }, `License + admin created. Copy the key${generatedPw ? ' and admin password' : ''} now — shown only once.`);
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
