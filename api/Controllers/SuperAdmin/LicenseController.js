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
 *   get           GET    /super-admin/licenses/:id
 *   update        PUT    /super-admin/licenses/:id
 *   remove        DELETE /super-admin/licenses/:id
 *   resetMachine  POST   /super-admin/licenses/:id/reset-machine
 *   suspend       POST   /super-admin/licenses/:id/suspend
 *   activate      POST   /super-admin/licenses/:id/activate
 *   regenerate    POST   /super-admin/licenses/:id/regenerate
 */

const crypto       = require('node:crypto');
const R            = require('../../Helpers/response');
const licenseKey   = require('../../Helpers/licenseKey');
const keyCrypto    = require('../../Helpers/keyCrypto');
const passwords    = require('../../Helpers/passwords');
const entitlements = require('../../Helpers/entitlements');
const { reconcileLicenseSeatsTx } = require('../../Helpers/seats');
const db           = require('../../config/db').db;

const NOT_FOUND = 'License not found.';

// An agent is "connected" if its license heartbeat landed within this window.
// The agent beats every 60s, so 150s = 2.5 missed beats (matches SyncController).
const CONNECTED_WINDOW_MS = 150 * 1000;

// Columns SAFE to expose for a single license (NEVER license_key_hash).
const PUBLIC_COLUMNS = [
    'id', 'key_prefix', 'tally_serial', 'holder_name', 'plan',
    'max_companies', 'max_users', 'valid_until', 'status',
    'machine_id', 'machine_bound_at', 'last_seen_at', 'agent_version',
    'created_by', 'created_at', 'updated_at',
];

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
                // Reversibly-encrypted full key so a super-admin can REVEAL it
                // later (null when LICENSE_KEY_SECRET is unset → not revealable).
                license_key_enc:  keyCrypto.encryptKey(key),
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

/**
 * GET /super-admin/licenses/:id
 *
 * Full license detail (NEVER the license_key_hash) plus derived info:
 *   • companies_count + companies [{id,name,status}] under this license
 *   • users_count + users [{id,name,email,role,status}] under this license
 *   • agent_connected (last_seen_at within CONNECTED_WINDOW_MS), agent_version,
 *     machine_bound flag.
 */
async function get(req, res) {
    try {
        const lic = await db('licenses')
            .where('id', req.params.id).whereNull('deleted_at')
            .first(PUBLIC_COLUMNS);
        if (!lic) return R.errorResponse(res, NOT_FOUND, 404);

        // Reveal the FULL key to the super-admin when we can decrypt the stored
        // ciphertext. The encrypted blob is fetched SEPARATELY (never added to
        // PUBLIC_COLUMNS / the `lic` payload) and the hash is NEVER exposed.
        // Decrypt failures (missing secret / pre-encryption license / tampered
        // blob) degrade to key_available:false — never a 500.
        const encRow      = await db('licenses').where('id', lic.id).first('license_key_enc');
        const clearKey    = encRow ? keyCrypto.decryptKey(encRow.license_key_enc) : null;
        const keyAvailable = !!clearKey;

        // Companies ordered by the SAME rule the sync gate uses (created_at asc,
        // id asc) so we can mark the first max_companies as Syncing and the rest
        // as over-limit (computed on-the-fly — there is no stored sync flag).
        const companyRows = await db('companies')
            .where('license_id', lic.id).whereNull('deleted_at')
            .orderBy('created_at', 'asc').orderBy('id', 'asc')
            .select('id', 'name', 'status');
        const maxCompanies = lic.max_companies != null ? Number(lic.max_companies) : null;
        const companies = companyRows.map((c, i) => ({
            ...c,
            syncing: maxCompanies == null ? true : i < maxCompanies,
        }));

        // Users ordered by the SAME rule the seat reconcile uses (created_at asc,
        // id asc). Mark the license-admin (role slug company-admin, company_id
        // NULL) so the UI never lets the operator confuse it for a seat user.
        const users = await db('users')
            .leftJoin('roles', 'roles.id', 'users.role_id')
            .where('users.license_id', lic.id).whereNull('users.deleted_at')
            .orderBy('users.created_at', 'asc').orderBy('users.id', 'asc')
            .select(
                'users.id', 'users.name', 'users.email', 'users.status',
                'users.company_id', 'roles.name as role', 'roles.slug as role_slug',
            )
            .then((rows) => rows.map((u) => ({
                id: u.id, name: u.name, email: u.email, status: u.status,
                role: u.role,
                is_license_admin: u.role_slug === 'company-admin' && u.company_id == null,
            })));

        const lastSeen  = lic.last_seen_at ? new Date(lic.last_seen_at) : null;
        const connected = !!(lastSeen && (Date.now() - lastSeen.getTime()) <= CONNECTED_WINDOW_MS);

        return R.successResponse(res, {
            license:         lic,
            // Full plaintext key for the super-admin View, only when decryptable.
            key_available:   keyAvailable,
            ...(keyAvailable ? { license_key: clearKey } : {}),
            companies_count: companies.length,
            companies,
            users_count:     users.length,
            users,
            agent: {
                connected,
                agent_version: lic.agent_version || null,
                machine_bound: !!(lic.machine_id || lic.machine_bound_at),
                last_seen_at:  lic.last_seen_at || null,
            },
        });
    } catch (err) {
        console.error('LicenseController.get error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * PUT /super-admin/licenses/:id
 *
 * Edits ONLY the mutable commercial fields — holder_name, plan, max_companies,
 * max_users, valid_until. NEVER touches the key/hash, machine binding, or status
 * (status is changed via suspend/activate, machine via reset-machine). Caps may
 * not drop below the license's current companies/users counts (we'd otherwise be
 * over-subscribed). 404 when not found/deleted; 422 on bad input.
 */
async function update(req, res) {
    try {
        const lic = await db('licenses')
            .where('id', req.params.id).whereNull('deleted_at').first();
        if (!lic) return R.errorResponse(res, NOT_FOUND, 404);

        const b = req.body || {};

        // holder_name — required, non-empty.
        const holder = (b.holder_name == null ? '' : String(b.holder_name)).trim();
        if (!holder) return R.errorResponse(res, 'Holder name is required.', 422);

        // Current usage — the caps may not be set below these.
        const [{ count: compCount }] = await db('companies')
            .where('license_id', lic.id).whereNull('deleted_at').count({ count: '*' });
        const [{ count: userCount }] = await db('users')
            .where('license_id', lic.id).whereNull('deleted_at').count({ count: '*' });
        const companiesCount = Number(compCount) || 0;
        const usersCount     = Number(userCount) || 0;

        const patch = { holder_name: holder };

        if (b.plan != null) {
            const plan = String(b.plan).trim();
            if (!plan) return R.errorResponse(res, 'Plan cannot be empty.', 422);
            patch.plan = plan;
        }

        if (b.max_companies != null && b.max_companies !== '') {
            const mc = Number(b.max_companies);
            if (!Number.isInteger(mc) || mc <= 0) {
                return R.errorResponse(res, 'Max companies must be a whole number greater than 0.', 422);
            }
            if (mc < companiesCount) {
                return R.errorResponse(res, `Max companies cannot be below the ${companiesCount} companies already under this license.`, 422);
            }
            patch.max_companies = mc;
        }

        if (b.max_users != null && b.max_users !== '') {
            const mu = Number(b.max_users);
            if (!Number.isInteger(mu) || mu <= 0) {
                return R.errorResponse(res, 'Max users must be a whole number greater than 0.', 422);
            }
            if (mu < usersCount) {
                return R.errorResponse(res, `Max users cannot be below the ${usersCount} users already under this license.`, 422);
            }
            patch.max_users = mu;
        }

        if (Object.prototype.hasOwnProperty.call(b, 'valid_until')) {
            if (b.valid_until === '' || b.valid_until == null) {
                patch.valid_until = null;
            } else {
                const d = new Date(b.valid_until);
                if (isNaN(d.getTime())) return R.errorResponse(res, 'Valid until must be a valid date.', 422);
                patch.valid_until = isoDate(b.valid_until);
            }
        }

        patch.updated_at = new Date();
        await db('licenses').where('id', lic.id).update(patch);

        // SEAT auto-adjust: when max_users changed, re-evaluate which users are
        // Active vs Inactive (license-admin + the oldest up to the new cap stay
        // Active; the newest excess go Inactive — and vice-versa when the cap is
        // raised). Best-effort: a reconcile failure must NOT fail the license
        // save (the patch is already committed). max_companies needs NO persisted
        // change — sync gating is computed on-the-fly (see AgentController).
        if (Object.prototype.hasOwnProperty.call(patch, 'max_users')
            && Number(patch.max_users) !== Number(lic.max_users)) {
            try {
                await reconcileLicenseSeatsTx(lic.id);
            } catch (reErr) {
                console.error('LicenseController.update seat reconcile error:', reErr);
            }
        }

        const updated = await db('licenses').where('id', lic.id).first(PUBLIC_COLUMNS);
        return R.successResponse(res, { license: updated }, 'License updated.');
    } catch (err) {
        console.error('LicenseController.update error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * DELETE /super-admin/licenses/:id
 *
 * Soft-delete (deleted_at = now). Refuses (422) while the license still has any
 * non-deleted companies OR users, so tenant data is never orphaned — the caller
 * must remove/move them first. Allowed once the license is empty.
 */
async function remove(req, res) {
    try {
        const lic = await db('licenses')
            .where('id', req.params.id).whereNull('deleted_at').first('id');
        if (!lic) return R.errorResponse(res, NOT_FOUND, 404);

        const [{ count: compCount }] = await db('companies')
            .where('license_id', lic.id).whereNull('deleted_at').count({ count: '*' });
        const [{ count: userCount }] = await db('users')
            .where('license_id', lic.id).whereNull('deleted_at').count({ count: '*' });
        const companiesCount = Number(compCount) || 0;
        const usersCount     = Number(userCount) || 0;

        if (companiesCount > 0 || usersCount > 0) {
            const parts = [];
            if (companiesCount > 0) parts.push(`${companiesCount} compan${companiesCount === 1 ? 'y' : 'ies'}`);
            if (usersCount > 0)     parts.push(`${usersCount} user${usersCount === 1 ? '' : 's'}`);
            return R.errorResponse(res,
                `Cannot delete: this license still has ${parts.join(' and ')}. Remove or move them first.`, 422);
        }

        await db('licenses').where('id', lic.id).update({ deleted_at: new Date(), updated_at: new Date() });
        return R.successResponse(res, { id: lic.id }, 'License deleted.');
    } catch (err) {
        console.error('LicenseController.remove error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

/**
 * POST /super-admin/licenses/:id/regenerate
 *
 * Mints a BRAND-NEW key for an existing license — used for old licenses whose
 * clear key was never stored (created before encryption), or to rotate a key.
 * Uses the EXACT same generator/format as create() (licenseKey.generate), and
 * updates ONLY the key fields: license_key_hash + key_prefix + license_key_enc
 * (encrypted) + updated_at. Machine binding, status, companies and users are
 * left untouched. Returns the new full key ONCE in the envelope.
 *
 * 404 when the license is missing/deleted. Super-admin guarded at the route.
 */
async function regenerate(req, res) {
    try {
        const lic = await db('licenses')
            .where('id', req.params.id).whereNull('deleted_at').first('id');
        if (!lic) return R.errorResponse(res, NOT_FOUND, 404);

        // Same generator + format as create() — do not invent a new format.
        const { key, prefix, hash } = licenseKey.generate();

        await db('licenses').where('id', lic.id).update({
            license_key_hash: hash,
            key_prefix:       prefix,
            license_key_enc:  keyCrypto.encryptKey(key),
            updated_at:       new Date(),
        });

        // The new clear key is returned ONCE (it stays revealable via get()).
        return R.successResponse(res, {
            license_key: key,
            key_prefix:  prefix,
        }, 'New license key generated. Copy it now — and re-activate the agent with it.');
    } catch (err) {
        console.error('LicenseController.regenerate error:', err);
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

module.exports = { create, list, get, update, remove, resetMachine, suspend, activate, regenerate };
