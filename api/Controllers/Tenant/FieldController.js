'use strict';

/**
 * api/Controllers/Tenant/FieldController.js
 *
 * Field-Sales (SFA) endpoints for the LOGGED-IN salesman. Phase 1 exposes the
 * salesman's own dashboard: the locations (beats) assigned to them, the count of
 * customers they own in each, the invoices THEY created there, and a headline
 * tally of their invoices by approval_status (draft / pending / approved /
 * rejected). Phase 2 will add GPS visit / coverage figures to each location card.
 *
 *   GET /field/my-dashboard
 *
 * "Who is the salesman" is resolved by locationScope middleware (req.isSalesman /
 * req.salesPersonId — a user linked to a sales_persons row). A non-salesman
 * (admin) gets an is_salesman:false payload; they use the main dashboard instead.
 *
 * Conventions: company-scoped by req.companyId, every handler async + try/catch →
 * console.error + 500 envelope (matches the other tenant controllers).
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

// Default geofence radius (metres) for a check-in when the outlet has no
// per-customer override. ~200m tolerates GPS drift + a large outlet frontage.
const DEFAULT_GEOFENCE_M = 200;

/** Great-circle (haversine) distance in METRES between two lat/lng points. */
function distanceMeters(lat1, lng1, lat2, lng2) {
    const R_EARTH = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R_EARTH * Math.asin(Math.sqrt(a)));
}

/** Today's date as YYYY-MM-DD (server local). */
function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

/** Is the current time inside the HH:MM..HH:MM window? (handles midnight cross). */
function withinWindow(from, to) {
    const parse = (s) => {
        const [h, m] = String(s || '').split(':').map((x) => parseInt(x, 10) || 0);
        return h * 60 + m;
    };
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const f = parse(from), t = parse(to);
    if (f === t) return true;                 // no restriction
    if (f < t) return cur >= f && cur <= t;   // normal same-day window
    return cur >= f || cur <= t;              // window crosses midnight
}

/** Per-license GPS settings (null if none). */
async function gpsSettingsFor(licenseId) {
    if (!licenseId) return null;
    return db('gps_settings').where({ license_id: licenseId }).first();
}

/**
 * GET /field/my-dashboard — the logged-in salesman's home. Returns their
 * assigned locations (with per-location customer + invoice tallies) and an
 * overall stats block used by the app/web salesman dashboard.
 */
async function myDashboard(req, res) {
    try {
        const companyId = req.companyId;
        const spId      = req.salesPersonId;
        const userId    = req.user && req.user.sub;

        // Not a salesman → nothing to scope (admins use the main dashboard).
        if (!req.isSalesman || !spId) {
            return R.successResponse(res, {
                is_salesman: false,
                locations:   [],
                stats:       {},
            });
        }

        // Assigned locations (beats).
        const locations = await db('sales_person_locations as spl')
            .join('locations as l', 'l.id', 'spl.location_id')
            .where('spl.sales_person_id', spId)
            .where('spl.company_id', companyId)
            .whereNull('l.deleted_at')
            .select('l.id', 'l.name', 'l.city', 'l.state', 'l.status')
            .orderBy('l.name');
        const locIds = locations.map((l) => l.id);

        // Customers assigned to this salesman, per location.
        const custByLoc = {};
        if (locIds.length) {
            const rows = await db('sales_person_customers')
                .where('sales_person_id', spId)
                .where('company_id', companyId)
                .whereIn('location_id', locIds)
                .select('location_id')
                .count('id as c')
                .groupBy('location_id');
            rows.forEach((r) => { custByLoc[r.location_id] = Number(r.c) || 0; });
        }

        // Invoices THIS salesman created, per location (count + value).
        const invByLoc = {};
        if (locIds.length) {
            const rows = await db('invoices')
                .where('company_id', companyId)
                .where('type', 'sales')
                .whereNull('deleted_at')
                .where('created_by', userId)
                .whereIn('location_id', locIds)
                .select('location_id')
                .count('id as cnt')
                .sum('total as total')
                .groupBy('location_id');
            rows.forEach((r) => {
                invByLoc[r.location_id] = { count: Number(r.cnt) || 0, total: Number(r.total) || 0 };
            });
        }

        const locationCards = locations.map((l) => ({
            id:          l.id,
            name:        l.name,
            city:        l.city,
            state:       l.state,
            status:      l.status,
            customers:   custByLoc[l.id] || 0,
            invoices:    (invByLoc[l.id] || {}).count || 0,
            sales_value: (invByLoc[l.id] || {}).total || 0,
        }));

        // My invoice tally by approval_status (+ approved sale value).
        const statusRows = await db('invoices')
            .where('company_id', companyId)
            .where('type', 'sales')
            .whereNull('deleted_at')
            .where('created_by', userId)
            .select('approval_status')
            .count('id as c')
            .sum('total as t')
            .groupBy('approval_status');

        const byStatus = { draft: 0, pending: 0, approved: 0, rejected: 0 };
        let approvedValue = 0;
        statusRows.forEach((r) => {
            const k = r.approval_status;
            if (byStatus[k] != null) byStatus[k] = Number(r.c) || 0;
            if (k === 'approved') approvedValue = Number(r.t) || 0;
        });

        const totalCustomers = Object.values(custByLoc).reduce((a, b) => a + b, 0);

        // Today's attendance + coverage (Phase 2 GPS tracking).
        const day = todayStr();
        const [attendance, visitedRow] = await Promise.all([
            db('field_attendance')
                .where({ company_id: companyId, sales_person_id: spId, day })
                .first('start_at', 'end_at', 'status'),
            db('field_visits')
                .where({ company_id: companyId, sales_person_id: spId })
                .whereRaw('checkin_at::date = ?', [day])
                .countDistinct('customer_id as c').first(),
        ]);
        const visitedToday = Number(visitedRow && visitedRow.c) || 0;
        const coveragePct = totalCustomers > 0
            ? Math.round((visitedToday / totalCustomers) * 100) : 0;

        return R.successResponse(res, {
            is_salesman:     true,
            sales_person_id: spId,
            locations:       locationCards,
            attendance: {
                started:  !!(attendance && attendance.start_at),
                ended:    !!(attendance && attendance.end_at),
                start_at: attendance ? attendance.start_at : null,
                end_at:   attendance ? attendance.end_at : null,
            },
            stats: {
                locations:      locations.length,
                customers:      totalCustomers,
                today_visited:  visitedToday,
                coverage_pct:   coveragePct,
                draft:          byStatus.draft,
                pending:        byStatus.pending,
                approved:       byStatus.approved,
                rejected:       byStatus.rejected,
                approved_value: approvedValue,
            },
        });
    } catch (err) {
        console.error('field.myDashboard error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /field/day/start — the salesman punches IN for the day (GPS). Idempotent:
 * a second call the same day just returns the open row.
 */
async function startDay(req, res) {
    if (!req.isSalesman || !req.salesPersonId) {
        return R.errorResponse(res, 'Only a field salesman can mark attendance.', 403);
    }
    try {
        const b = req.body || {};
        const day = todayStr();
        const existing = await db('field_attendance')
            .where({ company_id: req.companyId, sales_person_id: req.salesPersonId, day })
            .first();
        if (existing) return R.successResponse(res, existing, 'Day already started.');
        const [row] = await db('field_attendance').insert({
            company_id:      req.companyId,
            sales_person_id: req.salesPersonId,
            user_id:         req.user && req.user.sub ? req.user.sub : null,
            day,
            start_at:        db.fn.now(),
            start_lat:       b.lat != null ? Number(b.lat) : null,
            start_lng:       b.lng != null ? Number(b.lng) : null,
            status:          'open',
        }).returning('*');
        return R.successResponse(res, row, 'Day started. Have a great day!');
    } catch (err) {
        console.error('field.startDay error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** POST /field/day/end — the salesman punches OUT for the day (GPS). */
async function endDay(req, res) {
    if (!req.isSalesman || !req.salesPersonId) {
        return R.errorResponse(res, 'Only a field salesman can mark attendance.', 403);
    }
    try {
        const b = req.body || {};
        const day = todayStr();
        const existing = await db('field_attendance')
            .where({ company_id: req.companyId, sales_person_id: req.salesPersonId, day })
            .first();
        if (!existing) return R.errorResponse(res, 'Start your day first.', 422);
        const [row] = await db('field_attendance').where({ id: existing.id }).update({
            end_at:     db.fn.now(),
            end_lat:    b.lat != null ? Number(b.lat) : null,
            end_lng:    b.lng != null ? Number(b.lng) : null,
            status:     'closed',
            updated_at: db.fn.now(),
        }).returning('*');
        return R.successResponse(res, row, 'Day ended.');
    } catch (err) {
        console.error('field.endDay error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /field/visits/checkin — the salesman checks IN at a customer outlet. The
 * server compares the phone GPS to the outlet's saved coords and flags whether
 * it was WITHIN the geofence (genuine visit) or too far (possible fake).
 * Body: { customer_id, lat, lng, note? }.
 */
async function checkin(req, res) {
    if (!req.isSalesman || !req.salesPersonId) {
        return R.errorResponse(res, 'Only a field salesman can check in.', 403);
    }
    try {
        const b = req.body || {};
        const customerId = Number(b.customer_id) || null;
        if (!customerId) return R.errorResponse(res, 'Customer is required.', 422);
        const lat = b.lat != null ? Number(b.lat) : null;
        const lng = b.lng != null ? Number(b.lng) : null;

        const cust = await db('customers')
            .where({ id: customerId, company_id: req.companyId }).whereNull('deleted_at')
            .first('latitude', 'longitude', 'geo_radius_m', 'location_id');
        if (!cust) return R.errorResponse(res, 'Customer not found.', 404);

        // Prefer the salesman's per-location assignment for the visit's location.
        const assign = await db('sales_person_customers')
            .where({ company_id: req.companyId, sales_person_id: req.salesPersonId, customer_id: customerId })
            .first('location_id');

        let distance = null;
        let within = false;
        if (lat != null && lng != null) {
            if (cust.latitude != null && cust.longitude != null) {
                distance = distanceMeters(lat, lng, Number(cust.latitude), Number(cust.longitude));
                const radius = Number(cust.geo_radius_m) || DEFAULT_GEOFENCE_M;
                within = distance <= radius;
            } else {
                // First check-in with no saved outlet coords → GEOTAG the outlet
                // with this GPS (auto-capture). This visit counts as verified, and
                // every later visit is measured against it. Admins can correct it
                // later. Removes the need for a separate coordinate-entry screen.
                await db('customers').where({ id: customerId, company_id: req.companyId })
                    .update({ latitude: lat, longitude: lng, updated_at: db.fn.now() });
                distance = 0;
                within = true;
            }
        }

        const [row] = await db('field_visits').insert({
            company_id:         req.companyId,
            sales_person_id:    req.salesPersonId,
            user_id:            req.user && req.user.sub ? req.user.sub : null,
            customer_id:        customerId,
            location_id:        (assign && assign.location_id) || cust.location_id || null,
            checkin_at:         db.fn.now(),
            checkin_lat:        lat,
            checkin_lng:        lng,
            checkin_distance_m: distance,
            checkin_within:     within,
            note:               (b.note || '').toString().trim().slice(0, 500) || null,
            status:             'open',
        }).returning('*');

        const msg = within
            ? 'Checked in — location verified.'
            : distance == null
                ? 'Checked in.'
                : `Checked in — but you appear ${distance}m from the outlet.`;
        return R.successResponse(res, row, msg);
    } catch (err) {
        console.error('field.checkin error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** POST /field/visits/:id/checkout — close an open visit (GPS). */
async function checkout(req, res) {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, 'Visit not found.', 404);
        const b = req.body || {};
        const q = db('field_visits').where({ id, company_id: req.companyId }).whereNull('deleted_at');
        if (req.isSalesman) q.where('sales_person_id', req.salesPersonId);
        const visit = await q.first();
        if (!visit) return R.errorResponse(res, 'Visit not found.', 404);
        if (visit.status === 'closed') return R.successResponse(res, visit, 'Already checked out.');
        const [row] = await db('field_visits').where({ id }).update({
            checkout_at: db.fn.now(),
            checkout_lat: b.lat != null ? Number(b.lat) : null,
            checkout_lng: b.lng != null ? Number(b.lng) : null,
            status:       'closed',
            updated_at:   db.fn.now(),
        }).returning('*');
        return R.successResponse(res, row, 'Checked out.');
    } catch (err) {
        console.error('field.checkout error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /field/visits — visit log. A salesman sees ONLY their own visits; an admin
 * sees the whole company (optional ?date=YYYY-MM-DD & ?sales_person_id filters).
 */
async function visits(req, res) {
    try {
        let q = db('field_visits as v')
            .leftJoin('customers as c', 'c.id', 'v.customer_id')
            .leftJoin('locations as l', 'l.id', 'v.location_id')
            .leftJoin('sales_persons as sp', 'sp.id', 'v.sales_person_id')
            .where('v.company_id', req.companyId).whereNull('v.deleted_at');
        if (req.isSalesman) {
            q = q.where('v.sales_person_id', req.salesPersonId);
        } else if (req.query.sales_person_id) {
            q = q.where('v.sales_person_id', Number(req.query.sales_person_id));
        }
        if (req.query.date) q = q.whereRaw('v.checkin_at::date = ?', [req.query.date]);
        const rows = await q.orderBy('v.checkin_at', 'desc').limit(200).select(
            'v.id', 'v.checkin_at', 'v.checkout_at', 'v.checkin_distance_m',
            'v.checkin_within', 'v.note', 'v.status',
            'c.name as customer', 'l.name as location', 'sp.name as sales_person',
        );
        return R.successResponse(res, { data: rows });
    } catch (err) {
        console.error('field.visits error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /field/gps-config — the salesman's app reads the ACTIVE tracking config
 * (super-admin per-license settings) + whether we're inside the time window +
 * their assigned beats/areas for the part-visit picker. Non-salesman → disabled.
 */
async function gpsConfig(req, res) {
    try {
        if (!req.isSalesman || !req.salesPersonId) {
            return R.successResponse(res, { enabled: false });
        }
        const co = await db('companies').where('id', req.companyId).first('license_id');
        const s = await gpsSettingsFor(co && co.license_id);
        if (!s || !s.gps_enabled) return R.successResponse(res, { enabled: false });
        const locations = await db('sales_person_locations as spl')
            .join('locations as l', 'l.id', 'spl.location_id')
            .where('spl.sales_person_id', req.salesPersonId).where('spl.company_id', req.companyId)
            .whereNull('l.deleted_at').select('l.id', 'l.name').orderBy('l.name');
        return R.successResponse(res, {
            enabled: true,
            track_hourly: !!s.track_hourly,
            hourly_interval_min: Number(s.hourly_interval_min) || 60,
            track_part_visit: !!s.track_part_visit,
            track_on_create: !!s.track_on_create,
            time_from: s.time_from,
            time_to: s.time_to,
            min_move_m: Number(s.min_move_m) || 100,
            within_window: withinWindow(s.time_from, s.time_to),
            locations,
        });
    } catch (err) {
        console.error('field.gpsConfig error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /field/locations — record a location ping. Enforces the master toggle +
 * time window server-side, and DE-DUPES: a 'hourly' ping within min_move_m of the
 * last point is skipped (the same standing location is never re-stored).
 * Body: { lat, lng, source, accuracy?, part_visit_id? }.
 */
async function ping(req, res) {
    try {
        if (!req.isSalesman || !req.salesPersonId) {
            return R.errorResponse(res, 'Only a field salesman can send location.', 403);
        }
        const b = req.body || {};
        const lat = Number(b.lat), lng = Number(b.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return R.errorResponse(res, 'lat/lng are required.', 422);
        }
        const source = ['hourly', 'part_visit', 'create', 'checkin'].includes(b.source) ? b.source : 'hourly';
        const co = await db('companies').where('id', req.companyId).first('license_id');
        const s = await gpsSettingsFor(co && co.license_id);
        if (!s || !s.gps_enabled) return R.successResponse(res, { skipped: 'disabled' });
        if (!withinWindow(s.time_from, s.time_to)) return R.successResponse(res, { skipped: 'out_of_window' });

        // Server-side change detection (defence-in-depth on top of the app's).
        const last = await db('field_locations')
            .where({ company_id: req.companyId, sales_person_id: req.salesPersonId })
            .orderBy('id', 'desc').first('lat', 'lng');
        let moved = null;
        if (last && last.lat != null) {
            moved = distanceMeters(lat, lng, Number(last.lat), Number(last.lng));
            // Only the periodic 'hourly' source is de-duped; explicit events always store.
            if (source === 'hourly' && moved < (Number(s.min_move_m) || 100)) {
                return R.successResponse(res, { skipped: 'no_move', moved });
            }
        }
        const [row] = await db('field_locations').insert({
            company_id:      req.companyId,
            sales_person_id: req.salesPersonId,
            user_id:         req.user && req.user.sub ? req.user.sub : null,
            lat, lng, source,
            accuracy_m:      b.accuracy != null ? Number(b.accuracy) : null,
            moved_m:         moved,
            part_visit_id:   b.part_visit_id ? Number(b.part_visit_id) : null,
        }).returning('id');
        return R.successResponse(res, { id: row && row.id ? row.id : row, moved });
    } catch (err) {
        console.error('field.ping error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** POST /field/part-visits — a salesman logs visiting a picked beat/area + GPS. */
async function partVisit(req, res) {
    try {
        if (!req.isSalesman || !req.salesPersonId) {
            return R.errorResponse(res, 'Only a field salesman can log a part visit.', 403);
        }
        const b = req.body || {};
        const locationId = Number(b.location_id) || null;
        const lat = b.lat != null ? Number(b.lat) : null;
        const lng = b.lng != null ? Number(b.lng) : null;
        const [pv] = await db('part_visits').insert({
            company_id:      req.companyId,
            sales_person_id: req.salesPersonId,
            user_id:         req.user && req.user.sub ? req.user.sub : null,
            location_id:     locationId,
            lat, lng,
            note: (b.note || '').toString().trim().slice(0, 300) || null,
        }).returning('id');
        const pvId = pv && pv.id ? pv.id : pv;
        if (lat != null && lng != null) {
            await db('field_locations').insert({
                company_id: req.companyId, sales_person_id: req.salesPersonId,
                user_id: req.user && req.user.sub ? req.user.sub : null,
                lat, lng, source: 'part_visit', part_visit_id: pvId,
            }).catch(() => {});
        }
        return R.successResponse(res, { id: pvId }, 'Part visit logged.');
    } catch (err) {
        console.error('field.partVisit error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** GET /field/locations — the tracking trail (salesman=own, admin=all + filters). */
async function locations(req, res) {
    try {
        let q = db('field_locations as f')
            .leftJoin('sales_persons as sp', 'sp.id', 'f.sales_person_id')
            .where('f.company_id', req.companyId);
        if (req.isSalesman) q = q.where('f.sales_person_id', req.salesPersonId);
        else if (req.query.sales_person_id) q = q.where('f.sales_person_id', Number(req.query.sales_person_id));
        if (req.query.date) q = q.whereRaw('f.captured_at::date = ?', [req.query.date]);
        const rows = await q.orderBy('f.id', 'desc').limit(500).select(
            'f.id', 'f.lat', 'f.lng', 'f.source', 'f.moved_m', 'f.accuracy_m', 'f.captured_at', 'sp.name as sales_person');
        return R.successResponse(res, { data: rows });
    } catch (err) {
        console.error('field.locations error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    myDashboard,
    startDay,
    endDay,
    checkin,
    checkout,
    visits,
    gpsConfig,
    ping,
    partVisit,
    locations,
};
