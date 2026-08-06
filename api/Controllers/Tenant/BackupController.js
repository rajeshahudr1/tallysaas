'use strict';

/**
 * api/Controllers/Tenant/BackupController.js
 *
 * Data Backup — cloud side (Task 1 of 3). The actual copy only happens on the
 * machine where Tally lives, because that is the only machine that can see
 * BOTH the Tally data folder and the destination the customer chose. The
 * cloud's job is narrow and deliberate:
 *
 *   • STORE THE INTENT  — `license_backup_settings`, one row per license:
 *     enabled?, destination_path, frequency/run_at (agent-local schedule),
 *     keep_copies (retention).
 *   • STORE THE OUTCOME — `backup_runs`: every run the agent attempted,
 *     written by the AGENT (see AgentController.recordBackupRun). The cloud
 *     never invents or upgrades a run's status — a run the agent never
 *     reported back stays whatever it last was, never silently 'success'.
 *   • QUEUE THE REQUEST — "back up now" goes through the SAME agent_commands
 *     channel as 'open_company' (AgentCommandController), not a new one.
 *
 * What this file deliberately does NOT do: validate `destination_path`. That
 * path is meaningless to the cloud — it exists only on the agent's machine —
 * so pretending to check it (exists? writable? enough space?) would be a
 * false promise. The only cloud-side rule is "not empty". Real validation is
 * the agent's job, every run.
 *
 * Exports: { getSettings, updateSettings, listRuns, runNow, copiesToDelete }
 */

const db       = require('../../config/db').db;
const masterDb = require('../../config/masterDb').db;
const R        = require('../../Helpers/response');

const OOPS = 'Oops..Something went wrong. Please try again.';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

const FREQUENCIES = ['daily', 'weekly'];

/**
 * Pure retention rule: given existing copies at the destination (oldest to
 * newest — `existing[0]` is the OLDEST) and how many to keep, return the
 * copies that should be deleted, oldest first. Never deletes down to zero:
 * `keep <= 0` is refused outright (a backup that erases everything is not a
 * backup), so nothing is returned to delete.
 *
 * This is the SAME rule the Python agent re-implements locally (it is the
 * one doing the actual deleting, since only it can see the destination
 * folder) — written and tested here once so the rule has one source of truth.
 */
function copiesToDelete(existing, keep) {
    const list = Array.isArray(existing) ? existing : [];
    const k = Number(keep);
    if (!Number.isFinite(k) || k <= 0) return [];
    if (list.length <= k) return [];
    return list.slice(0, list.length - k);
}

function parsePagination(query) {
    let page = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_LIMIT;
    if (perPage > MAX_LIMIT) perPage = MAX_LIMIT;
    return { page, perPage };
}

function resolveLicenseId(req) {
    const isSuper = req.user && req.user.role_slug === 'super-admin';
    let licenseId = req.user && req.user.license_id;
    if (isSuper) {
        const explicit = Number((req.body && req.body.license_id) || (req.query && req.query.license_id) || 0);
        if (Number.isInteger(explicit) && explicit > 0) licenseId = explicit;
    }
    return licenseId || null;
}

function shapeSettings(row, licenseId) {
    if (!row) {
        // No row yet → the agent-facing default: disabled, no destination.
        return {
            license_id: licenseId,
            enabled: false,
            destination_path: null,
            frequency: 'daily',
            run_at: '02:00:00',
            keep_copies: 7,
            updated_at: null,
        };
    }
    return {
        license_id: row.license_id,
        enabled: !!row.enabled,
        destination_path: row.destination_path || null,
        frequency: row.frequency || 'daily',
        run_at: row.run_at,
        keep_copies: Number(row.keep_copies),
        updated_at: row.updated_at,
    };
}

/**
 * GET /backup/settings
 */
async function getSettings(req, res) {
    try {
        const licenseId = resolveLicenseId(req);
        if (!licenseId) {
            return R.errorResponse(res, 'Only a licensed account can view backup settings.', 422);
        }
        const row = await masterDb('license_backup_settings').where('license_id', licenseId).first();
        return R.successResponse(res, shapeSettings(row, licenseId));
    } catch (err) {
        console.error('BackupController.getSettings error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/**
 * PUT /backup/settings
 * body: { enabled?, destination_path?, frequency?, run_at?, keep_copies? }
 *
 * Cloud-side checks stay deliberately shallow — see the file header. The only
 * things enforced here:
 *   • destination_path, when provided, must not be blank (the agent does the
 *     real existence/writability check on its own machine).
 *   • keep_copies, when provided, must be >= 1 (0 means "keep nothing", which
 *     is refused — see copiesToDelete).
 *   • frequency, when provided, must be 'daily' | 'weekly'.
 */
async function updateSettings(req, res) {
    try {
        const licenseId = resolveLicenseId(req);
        if (!licenseId) {
            return R.errorResponse(res, 'Only a licensed account can change backup settings.', 422);
        }

        const body = req.body || {};
        const patch = { updated_at: new Date() };

        if (Object.prototype.hasOwnProperty.call(body, 'destination_path')) {
            const dest = String(body.destination_path == null ? '' : body.destination_path).trim();
            if (!dest) {
                return R.errorResponse(res, 'Destination path is required.', 422);
            }
            patch.destination_path = dest;
        }

        if (Object.prototype.hasOwnProperty.call(body, 'frequency')) {
            const freq = String(body.frequency || '').trim().toLowerCase();
            if (!FREQUENCIES.includes(freq)) {
                return R.errorResponse(res, `Frequency must be one of: ${FREQUENCIES.join(', ')}.`, 422);
            }
            patch.frequency = freq;
        }

        if (Object.prototype.hasOwnProperty.call(body, 'run_at')) {
            const runAt = String(body.run_at || '').trim();
            if (!/^\d{2}:\d{2}(:\d{2})?$/.test(runAt)) {
                return R.errorResponse(res, 'run_at must be a time like "02:00" or "02:00:00".', 422);
            }
            patch.run_at = runAt.length === 5 ? `${runAt}:00` : runAt;
        }

        if (Object.prototype.hasOwnProperty.call(body, 'keep_copies')) {
            const keep = Number(body.keep_copies);
            // A backup that deletes everything it keeps is not a backup — refuse
            // zero (and anything non-positive) outright rather than store it.
            if (!Number.isInteger(keep) || keep < 1) {
                return R.errorResponse(res, 'keep_copies must be at least 1 — keeping zero copies is not a backup.', 422);
            }
            patch.keep_copies = keep;
        }

        if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
            const raw = body.enabled;
            patch.enabled = (raw === true || raw === 1 || raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes');
        }

        const existing = await masterDb('license_backup_settings').where('license_id', licenseId).first('id');
        if (existing) {
            await masterDb('license_backup_settings').where('license_id', licenseId).update(patch);
        } else {
            await masterDb('license_backup_settings').insert({ license_id: licenseId, ...patch });
        }

        const row = await masterDb('license_backup_settings').where('license_id', licenseId).first();
        return R.successResponse(res, shapeSettings(row, licenseId), 'Backup settings saved.', { show: true });
    } catch (err) {
        console.error('BackupController.updateSettings error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/**
 * GET /backup/runs?page=&per_page=
 * Run history for the caller's license, newest first.
 */
async function listRuns(req, res) {
    try {
        const licenseId = resolveLicenseId(req);
        if (!licenseId) {
            return R.successResponse(res, { data: [], meta: { total: 0, page: 1, per_page: DEFAULT_LIMIT } });
        }
        const { page, perPage } = parsePagination(req.query || {});

        const totalRow = await masterDb('backup_runs').where('license_id', licenseId).count('id as c').first();
        const total = Number(totalRow ? totalRow.c : 0);

        const rows = await masterDb('backup_runs')
            .where('license_id', licenseId)
            .orderBy('id', 'desc')
            .offset((page - 1) * perPage)
            .limit(perPage)
            .select('id', 'started_at', 'finished_at', 'status', 'files_copied',
                    'files_skipped', 'bytes_copied', 'destination', 'skipped_list', 'error');

        return R.successResponse(res, { data: rows, meta: { total, page, per_page: perPage } });
    } catch (err) {
        console.error('BackupController.listRuns error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/**
 * POST /backup/run-now
 *
 * Queues a 'backup_now' command through the SAME agent_commands channel
 * AgentCommandController.openCompany uses — the agent drains it the same way
 * (GET /agent/commands), so there is exactly one command channel, not two.
 */
async function runNow(req, res) {
    try {
        const licenseId = resolveLicenseId(req);
        if (!licenseId) {
            return R.errorResponse(res, 'Only a licensed account can request a backup.', 422);
        }

        const settings = await masterDb('license_backup_settings').where('license_id', licenseId).first();
        if (!settings || !settings.destination_path) {
            return R.errorResponse(res, 'Set a backup destination before running a backup.', 422);
        }

        const now = new Date();
        const [row] = await db('agent_commands').insert({
            license_id: licenseId,
            company_id: null,
            type: 'backup_now',
            payload: JSON.stringify({ destination_path: settings.destination_path, keep_copies: settings.keep_copies }),
            status: 'pending',
            created_by: (req.user && req.user.sub) || null,
            created_at: now,
            updated_at: now,
        }).returning('id');

        const id = row && row.id != null ? row.id : row;
        return R.successResponse(
            res,
            { id },
            'Backup requested. The agent will run it shortly.',
            { status: 201, show: true },
        );
    } catch (err) {
        console.error('BackupController.runNow error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

module.exports = { getSettings, updateSettings, listRuns, runNow, copiesToDelete };
