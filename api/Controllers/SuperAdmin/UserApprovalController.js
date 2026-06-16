'use strict';

/**
 * api/Controllers/SuperAdmin/UserApprovalController.js
 *
 * Platform Super-Admin user-approval queue (per-user subscription billing).
 *
 * Company-admins create users who start `approval_status = 'pending'` and CANNOT
 * log in. The Super Admin reviews them here and APPROVES (which flips the flag,
 * provisions an active subscription seat, and enforces the license's max_users
 * cap) or REJECTS them.
 *
 *   listPending  GET  /super-admin/users/pending
 *   approve      POST /super-admin/users/:id/approve
 *   reject       POST /super-admin/users/:id/reject
 *
 * All routes are Super-Admin only (authenticate + requireSuperAdmin).
 */

const R  = require('../../Helpers/response');
const db = require('../../config/db').db;

const OOPS_MSG  = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND = 'User not found.';

// "YYYY-MM-DD" for a Date / ms / ISO input.
function isoDate(d) {
    return new Date(d).toISOString().slice(0, 10);
}

/** GET /super-admin/users/pending — users awaiting a seat, with license usage. */
async function listPending(req, res) {
    try {
        const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
        const perPage = Math.min(100, parseInt(req.query.per_page, 10) || 20);

        const base = db('users')
            .where('users.approval_status', 'pending')
            .whereNull('users.deleted_at');

        const [{ count }] = await base.clone().count({ count: 'users.id' });

        const rows = await base.clone()
            .leftJoin('roles as r',      'r.id', 'users.role_id')
            .leftJoin('companies as c',  'c.id', 'users.company_id')
            .leftJoin('licenses as l',   'l.id', 'users.license_id')
            .select(
                'users.id', 'users.name', 'users.email', 'users.mobile',
                'users.company_id', 'users.license_id', 'users.created_at',
                'r.name as role', 'c.name as company',
                'l.holder_name as license_holder', 'l.max_users as license_max_users',
                // Approved (live) seats already used under this user's license.
                // 'approved' is bound (not interpolated); the column refs are
                // static identifiers, not user input.
                db.raw(
                    '(select count(*) from users au where au.license_id = users.license_id ' +
                    'and au.approval_status = ? and au.deleted_at is null) as license_used_seats',
                    ['approved'],
                ),
            )
            .orderBy('users.id', 'desc')
            .limit(perPage).offset((page - 1) * perPage);

        return R.successResponse(res, {
            data: rows,
            meta: { total: Number(count), page, per_page: perPage },
        });
    } catch (err) {
        console.error('UserApprovalController.listPending error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /super-admin/users/:id/approve
 * Flips the user to approved, provisions an active subscription seat, and stamps
 * who/when. Enforces the license's max_users cap (counting already-approved
 * users under the same license). Idempotent on the subscription (won't duplicate
 * an existing active seat).
 */
async function approve(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND, 404);
    try {
        const user = await db('users').where('id', id).whereNull('deleted_at').first();
        if (!user) return R.errorResponse(res, NOT_FOUND, 404);
        if (user.approval_status === 'approved') {
            return R.errorResponse(res, 'This user is already approved.', 422);
        }

        const today = isoDate(Date.now());

        // Everything that depends on the seat count runs INSIDE the transaction
        // with a row lock on the license, so two concurrent approvals on the same
        // license can't both pass the cap check and overshoot max_users.
        // NOTE: approval_status is intentionally INDEPENDENT of `status` — we do
        // NOT force status='Active' here, so an admin's deliberate Inactive/Blocked
        // is respected (approval = billing seat; status = admin enable/disable).
        const result = await db.transaction(async (trx) => {
            let license = null;
            if (user.license_id) {
                license = await trx('licenses').where('id', user.license_id).forUpdate().first();
                if (license && license.max_users != null) {
                    const [{ used }] = await trx('users')
                        .where('license_id', user.license_id)
                        .where('approval_status', 'approved')
                        .whereNull('deleted_at')
                        .count({ used: 'id' });
                    if (Number(used) >= Number(license.max_users)) {
                        return { capped: Number(license.max_users) };   // no changes committed
                    }
                }
            }

            await trx('users').where('id', id).update({
                approval_status: 'approved',
                approved_at:     new Date(),
                approved_by:     req.user ? req.user.sub : null,
                updated_at:      new Date(),
            });

            const subValidUntil = (license && license.valid_until)
                ? isoDate(license.valid_until)
                : isoDate(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000); // ~10y, leap-year-approx
            const plan = (license && license.plan) || 'standard';

            // Provision the seat — but don't duplicate an already-active one.
            const existingSeat = await trx('subscriptions')
                .where({ user_id: id, status: 'active' })
                .where('valid_until', '>=', today)
                .first();
            if (!existingSeat) {
                await trx('subscriptions').insert({
                    user_id: id, plan, valid_from: today, valid_until: subValidUntil, status: 'active',
                });
            }
            return { capped: null };
        });

        if (result.capped != null) {
            return R.errorResponse(
                res,
                `Seat limit reached: this license allows ${result.capped} approved users. Increase the license max_users to approve more.`,
                422,
            );
        }
        return R.successResponse(res, { id, approval_status: 'approved' }, 'User approved. They can now sign in.');
    } catch (err) {
        console.error('UserApprovalController.approve error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** POST /super-admin/users/:id/reject — decline the seat request. */
async function reject(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, NOT_FOUND, 404);
    try {
        const user = await db('users').where('id', id).whereNull('deleted_at').first();
        if (!user) return R.errorResponse(res, NOT_FOUND, 404);

        await db.transaction(async (trx) => {
            await trx('users').where('id', id).update({
                approval_status: 'rejected',
                approved_at:     new Date(),
                approved_by:     req.user ? req.user.sub : null,
                updated_at:      new Date(),
            });
            // Revoke any live seat so a previously-approved-then-rejected user
            // leaves no orphaned active subscription (login is already blocked by
            // the approval gate; this keeps the billing data clean).
            await trx('subscriptions').where('user_id', id).where('status', 'active')
                .update({ status: 'cancelled', updated_at: new Date() });
        });

        return R.successResponse(res, { id, approval_status: 'rejected' }, 'User request rejected.');
    } catch (err) {
        console.error('UserApprovalController.reject error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { listPending, approve, reject };
