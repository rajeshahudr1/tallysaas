'use strict';

/**
 * api/Controllers/SuperAdmin/GpsSettingsController.js
 *
 * Super-admin, per-license GPS tracking config (the salesman app reads it via
 * GET /field/gps-config). Controls the master switch, the four capture sources,
 * the hourly interval, the daily time window, and the min-move de-dup distance.
 *
 *   GET  /super-admin/gps-settings?license_id=
 *   POST /super-admin/gps-settings
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS = 'Oops..Something went wrong. Please try again.';

function bool(v, dflt = false) {
    if (v === true || v === 'true' || v === 'on' || v === '1' || v === 1) return true;
    if (v === false || v === 'false' || v === 'off' || v === '0' || v === 0) return false;
    return dflt;
}

const DEFAULTS = {
    gps_enabled: false, track_hourly: false, hourly_interval_min: 60,
    track_part_visit: true, track_on_create: false,
    time_from: '07:00', time_to: '20:00', min_move_m: 100,
};

async function get(req, res) {
    try {
        const licenseId = Number(req.query.license_id) || null;
        if (!licenseId) return R.errorResponse(res, 'license_id is required.', 422);
        const s = await db('gps_settings').where({ license_id: licenseId }).first();
        return R.successResponse(res, { settings: s || { ...DEFAULTS, license_id: licenseId } });
    } catch (err) {
        console.error('gpsSettings.get error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function save(req, res) {
    try {
        const b = req.body || {};
        const licenseId = Number(b.license_id);
        if (!licenseId) return R.errorResponse(res, 'license_id is required.', 422);

        const clampMin = (v, d) => {
            const n = parseInt(v, 10);
            return Number.isFinite(n) && n > 0 ? n : d;
        };
        const validTime = (v, d) => (/^\d{2}:\d{2}$/.test(String(v || '')) ? v : d);

        const patch = {
            license_id: licenseId,
            gps_enabled:         bool(b.gps_enabled, false),
            track_hourly:        bool(b.track_hourly, false),
            hourly_interval_min: clampMin(b.hourly_interval_min, 60),
            track_part_visit:    bool(b.track_part_visit, true),
            track_on_create:     bool(b.track_on_create, false),
            time_from:           validTime(b.time_from, '07:00'),
            time_to:             validTime(b.time_to, '20:00'),
            min_move_m:          clampMin(b.min_move_m, 100),
            updated_by:          req.user ? req.user.sub : null,
            updated_at:          new Date(),
        };
        const existing = await db('gps_settings').where({ license_id: licenseId }).first('id');
        if (existing) await db('gps_settings').where('id', existing.id).update(patch);
        else await db('gps_settings').insert(patch);
        return R.successResponse(res, { license_id: licenseId }, 'GPS tracking settings saved.');
    } catch (err) {
        console.error('gpsSettings.save error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

module.exports = { get, save };
