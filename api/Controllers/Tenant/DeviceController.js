'use strict';

/**
 * api/Controllers/Tenant/DeviceController.js
 *
 * The computers connected to this licence: list them, and disconnect one.
 *
 * WHY THIS EXISTS. `agents` made per-device revocation possible, but until
 * something can actually call it, a lost or stolen back-office PC can only be
 * dealt with by disabling the whole licence — which stops every other machine
 * too. This is the screen that makes the capability real.
 *
 * Devices are a LICENCE-level fact, so the rows live in the master control
 * plane while the caller arrives through the tenant middleware chain. Every
 * query here is therefore scoped to `req.user.license_id` explicitly and uses
 * masterDb, never the tenant handle.
 *
 * Exports { list, revoke }.
 */

const R        = require('../../Helpers/response');
const masterDb = require('../../config/masterDb').db;

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

// A device that has not phoned home in this long is shown as offline. The agent
// heartbeats every cycle (60s by default), so three minutes is several missed
// beats — long enough not to flicker on a slow network, short enough that a
// machine someone just switched off does not read as connected.
const OFFLINE_AFTER_MS = 3 * 60 * 1000;

function shape(row, now) {
    const seen = row.last_seen_at ? new Date(row.last_seen_at) : null;
    const online = !!seen && (now - seen.getTime()) < OFFLINE_AFTER_MS;
    return {
        id: Number(row.id),
        // Never the machine_id: it is a fingerprint hash, useless to a person
        // deciding which machine to disconnect, and it is an identifier we have
        // no reason to put on a screen.
        name: row.machine_name || 'Unnamed computer',
        agent_version: row.agent_version || null,
        status: row.status,
        online: row.status === 'active' && online,
        last_seen_at: row.last_seen_at || null,
        activated_at: row.activated_at || null,
        revoked_at: row.revoked_at || null,
        connected_by: row.user_name || null,
    };
}

/**
 * GET /devices — every computer ever connected to this licence.
 *
 * Revoked devices are INCLUDED rather than hidden. "This laptop was
 * disconnected on the 3rd" is exactly what someone checking after a theft needs
 * to see, and a row that silently disappears looks like it was never there.
 */
async function list(req, res) {
    try {
        const licenseId = req.user.license_id;
        if (!licenseId) return R.successResponse(res, { devices: [] }, 'Devices.');

        const rows = await masterDb('agents as a')
            .leftJoin('users as u', 'u.id', 'a.user_id')
            .where('a.license_id', licenseId)
            // Active first, then most-recently-seen: the machine someone is
            // looking for is almost always one of the live ones.
            .orderByRaw("case when a.status = 'active' then 0 else 1 end")
            .orderBy('a.last_seen_at', 'desc')
            .select('a.id', 'a.machine_name', 'a.agent_version', 'a.status',
                'a.last_seen_at', 'a.activated_at', 'a.revoked_at',
                'u.name as user_name');

        const now = Date.now();
        const devices = rows.map((r) => shape(r, now));
        return R.successResponse(res, {
            devices,
            active_count: devices.filter((d) => d.status === 'active').length,
            online_count: devices.filter((d) => d.online).length,
        }, 'Devices.');
    } catch (err) {
        console.error('DeviceController.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /devices/:id/revoke — disconnect one computer.
 *
 * The agent's token is long-lived by design (an expiring token would stop an
 * unattended service), so this flag IS the off switch: authenticateAgent checks
 * it on every request, and the next call from that machine fails.
 *
 * Not a delete. The row stays so the history of what was connected, by whom and
 * when it was cut off survives — which is the whole reason someone opens this
 * screen after a machine goes missing.
 */
async function revoke(req, res) {
    try {
        const licenseId = req.user.license_id;
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
            return R.errorResponse(res, 'Unknown device.', 404);
        }

        // Scoped to the caller's licence in the same query as the id lookup, so
        // a guessed id from another licence reads as "not found" rather than
        // revoking someone else's machine.
        const device = await masterDb('agents')
            .where({ id, license_id: licenseId })
            .first('id', 'machine_name', 'status');
        if (!device) return R.errorResponse(res, 'Unknown device.', 404);

        if (device.status !== 'active') {
            // Idempotent: revoking twice is not an error, and the second caller
            // wanted the same end state as the first.
            return R.successResponse(res, { id, status: device.status },
                'That computer is already disconnected.');
        }

        const now = new Date();
        await masterDb('agents').where('id', id).update({
            status: 'revoked',
            revoked_at: now,
            revoked_by: req.user.sub || null,
            updated_at: now,
        });

        console.error(`[DEVICE-REVOKE] license=${licenseId} agent=${id} `
            + `name=${device.machine_name || '?'} by=${req.user.sub}`);
        return R.successResponse(res, { id, status: 'revoked' },
            `${device.machine_name || 'That computer'} was disconnected.`);
    } catch (err) {
        console.error('DeviceController.revoke error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, revoke, OFFLINE_AFTER_MS, shape };
