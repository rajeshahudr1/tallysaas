'use strict';

/**
 * api/Controllers/Tenant/AgentCommandController.js
 *
 * User-facing (JWT, license-scoped) side of the cloud→agent command channel.
 * From the web/app a user picks a company and asks the local Tally agent to
 * OPEN it; we queue an agent_commands row that the agent later drains via
 * /agent/commands.
 *
 *   openCompany  POST /account/agent/open-company   body { company_id }
 *     Resolve the company WITHIN the caller's license (404 if it isn't theirs),
 *     then enqueue an 'open_company' command with the company name in its
 *     payload. The agent resolves name→Tally and opens it.
 *
 *   list         GET  /account/agent/commands?limit=10
 *     Recent commands for the caller's license (newest first) — backs a small
 *     status display in the UI.
 *
 *   setAutoUpdate PATCH /account/agent/auto-update   body { enabled }
 *     Flip the per-LICENSE cloud auto-update toggle (licenses.auto_update). The
 *     agent reads this as authoritative on its next /agent/version check, so the
 *     cloud toggle wins over the agent's local config. (Requirement 3.)
 *
 *   selfUpdate   POST /account/agent/self-update
 *     Enqueue a 'self_update' agent command (the agent honours it by forcing an
 *     update check next poll) — backs the dashboard "Update now" button.
 *
 * License scope: all read req.user.license_id (set by `authenticate`). A user
 * with no license can't queue/see agent commands or flip the toggle.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS = 'Oops..Something went wrong. Please try again.';

/**
 * POST /account/agent/open-company   body { company_id }
 * Queue an 'open_company' command for the caller's license.
 */
async function openCompany(req, res) {
    try {
        const isSuper       = req.user && req.user.role_slug === 'super-admin';
        const userLicenseId = req.user && req.user.license_id;

        const companyId = Number(req.body && req.body.company_id);
        if (!Number.isInteger(companyId) || companyId <= 0) {
            return R.errorResponse(res, 'A valid company is required.', 422);
        }

        // Resolve the company. A licensed user may target ONLY a company under
        // THEIR license; a super-admin may target any company (the command is
        // then scoped to that company's OWN license).
        const q = db('companies').where('id', companyId).whereNull('deleted_at');
        if (!isSuper) {
            if (!userLicenseId) {
                return R.errorResponse(res, 'Only a licensed account can open companies in Tally.', 422);
            }
            q.where('license_id', userLicenseId);
        }
        const company = await q.first('id', 'name', 'license_id');
        if (!company) {
            return R.errorResponse(res, 'Company not found.', 404);
        }
        const licenseId = company.license_id;
        if (!licenseId) {
            return R.errorResponse(res, 'This company is not linked to a license, so no agent can open it.', 422);
        }

        const now = new Date();
        const [row] = await db('agent_commands').insert({
            license_id: licenseId,
            company_id: company.id,
            type: 'open_company',
            payload: JSON.stringify({ company_name: company.name, company_number: null }),
            status: 'pending',
            created_by: (req.user && req.user.sub) || null,
            created_at: now,
            updated_at: now,
        }).returning('id');

        const id = row && row.id != null ? row.id : row;
        // Contract: { status:201, show:true, msg, data:{id} }. successResponse
        // defaults to {status:200,show:false}; `extra` (spread last) overrides
        // both to the queued-resource shape the web BFF flashes to the user.
        return R.successResponse(
            res,
            { id },
            'Open command queued. The agent will open it in Tally shortly.',
            { status: 201, show: true },
        );
    } catch (err) {
        console.error('AgentCommandController.openCompany error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/**
 * GET /account/agent/commands?limit=10
 * Recent agent commands for the caller's license (newest first).
 */
async function list(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        if (!licenseId) {
            return R.successResponse(res, { commands: [] });
        }

        let limit = parseInt(req.query.limit, 10);
        if (!Number.isInteger(limit) || limit < 1) limit = 10;
        if (limit > 50) limit = 50;

        const commands = await db('agent_commands')
            .where('license_id', licenseId)
            .orderBy('id', 'desc')
            .limit(limit)
            .select('id', 'company_id', 'type', 'payload', 'status',
                    'result', 'error', 'picked_at', 'created_at', 'updated_at');

        // Flatten the payload's company_name for convenient display.
        const data = commands.map((c) => {
            let companyName = null;
            if (c.payload) {
                try {
                    const p = JSON.parse(c.payload);
                    if (p && typeof p === 'object' && p.company_name != null) {
                        companyName = p.company_name;
                    }
                } catch {
                    companyName = null;
                }
            }
            return {
                id: c.id,
                company_id: c.company_id,
                company_name: companyName,
                type: c.type,
                status: c.status,
                result: c.result,
                error: c.error,
                picked_at: c.picked_at,
                created_at: c.created_at,
                updated_at: c.updated_at,
            };
        });

        return R.successResponse(res, { commands: data });
    } catch (err) {
        console.error('AgentCommandController.list error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/**
 * PATCH /account/agent/auto-update   body { enabled }
 *
 * Persist the per-LICENSE cloud auto-update toggle (licenses.auto_update). The
 * agent treats /agent/version.auto_update as authoritative, so this is the
 * single ON/OFF the dashboard switch writes. License-scoped via
 * req.user.license_id; a super-admin may target any license via ?license_id /
 * body.license_id (else falls back to their own, which may be null → 422).
 */
async function setAutoUpdate(req, res) {
    try {
        const isSuper       = req.user && req.user.role_slug === 'super-admin';
        const userLicenseId = req.user && req.user.license_id;

        // Coerce the toggle to a strict boolean (checkbox/string tolerant).
        const raw = req.body && req.body.enabled;
        const enabled = (raw === true || raw === 1 || raw === '1'
            || raw === 'true' || raw === 'on' || raw === 'yes');

        // Resolve which license to flip. A licensed user → their own license. A
        // super-admin → an explicit license_id (body/query) or their own.
        let licenseId = userLicenseId;
        if (isSuper) {
            const explicit = Number(
                (req.body && req.body.license_id) || (req.query && req.query.license_id) || 0,
            );
            if (Number.isInteger(explicit) && explicit > 0) licenseId = explicit;
        }
        if (!licenseId) {
            return R.errorResponse(res, 'Only a licensed account can change auto-update.', 422);
        }

        const updated = await db('licenses')
            .where('id', licenseId)
            .whereNull('deleted_at')
            .update({ auto_update: enabled, updated_at: new Date() });
        if (!updated) {
            return R.errorResponse(res, 'License not found.', 404);
        }

        return R.successResponse(
            res,
            { auto_update: enabled },
            enabled
                ? 'Auto-update turned ON. The agent will update itself when a newer version is published.'
                : 'Auto-update turned OFF. Only mandatory (security) releases will be applied.',
            { show: true },
        );
    } catch (err) {
        console.error('AgentCommandController.setAutoUpdate error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/**
 * PATCH /account/sync-direction   body { push_enabled, pull_enabled }
 *
 * Persist the per-LICENSE AUTO-sync direction toggles (licenses
 * .sync_push_enabled / .sync_pull_enabled — Requirement 1). The agent reads
 * these back via its heartbeat each cycle and SKIPS the PUSH and/or PULL pass
 * when off. These gate ONLY the agent's automatic loop; the dashboard's MANUAL
 * per-module "Sync to Tally" / "Sync from Tally" buttons are unaffected.
 *
 * License-scoped via req.user.license_id (same guard pattern as
 * setAutoUpdate); a super-admin may target any license via body/query
 * license_id (else falls back to their own, which may be null → 422). Each flag
 * is OPTIONAL — only the provided one(s) are written, so a caller can flip just
 * push or just pull. At least one must be present.
 */
async function setSyncDirection(req, res) {
    try {
        const isSuper       = req.user && req.user.role_slug === 'super-admin';
        const userLicenseId = req.user && req.user.license_id;

        // Coerce a checkbox/string-tolerant boolean (matches setAutoUpdate).
        const toBool = (raw) => (raw === true || raw === 1 || raw === '1'
            || raw === 'true' || raw === 'on' || raw === 'yes');

        const body = req.body || {};
        const hasPush = Object.prototype.hasOwnProperty.call(body, 'push_enabled');
        const hasPull = Object.prototype.hasOwnProperty.call(body, 'pull_enabled');
        if (!hasPush && !hasPull) {
            return R.errorResponse(res, 'Provide push_enabled and/or pull_enabled.', 422);
        }

        // Resolve which license to flip. A licensed user → their own license. A
        // super-admin → an explicit license_id (body/query) or their own.
        let licenseId = userLicenseId;
        if (isSuper) {
            const explicit = Number(
                (body.license_id) || (req.query && req.query.license_id) || 0,
            );
            if (Number.isInteger(explicit) && explicit > 0) licenseId = explicit;
        }
        if (!licenseId) {
            return R.errorResponse(res, 'Only a licensed account can change auto-sync direction.', 422);
        }

        const patch = { updated_at: new Date() };
        if (hasPush) patch.sync_push_enabled = toBool(body.push_enabled);
        if (hasPull) patch.sync_pull_enabled = toBool(body.pull_enabled);

        const updated = await db('licenses')
            .where('id', licenseId)
            .whereNull('deleted_at')
            .update(patch);
        if (!updated) {
            return R.errorResponse(res, 'License not found.', 404);
        }

        // Echo the resulting effective state so the dashboard can update both
        // toggles. Re-read so a partial PATCH returns the unchanged flag too.
        const lic = await db('licenses').where('id', licenseId)
            .first('sync_push_enabled', 'sync_pull_enabled');
        const pushEnabled = lic && lic.sync_push_enabled != null ? !!lic.sync_push_enabled : true;
        const pullEnabled = lic && lic.sync_pull_enabled != null ? !!lic.sync_pull_enabled : true;

        return R.successResponse(
            res,
            { push_enabled: pushEnabled, pull_enabled: pullEnabled },
            'Auto-sync direction updated. The agent will apply it on its next cycle.',
            { show: true },
        );
    } catch (err) {
        console.error('AgentCommandController.setSyncDirection error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

/**
 * POST /account/agent/self-update
 *
 * Enqueue a 'self_update' command for the caller's license so the agent forces
 * an update check on its next poll (the agent honours this command type by
 * running maybe_self_update(forced=True)). Backs the dashboard "Update now"
 * button. License-scoped via req.user.license_id.
 */
async function selfUpdate(req, res) {
    try {
        const licenseId = req.user && req.user.license_id;
        if (!licenseId) {
            return R.errorResponse(res, 'Only a licensed account can trigger an agent update.', 422);
        }

        const now = new Date();
        const [row] = await db('agent_commands').insert({
            license_id: licenseId,
            company_id: null,
            type: 'self_update',
            payload: JSON.stringify({}),
            status: 'pending',
            created_by: (req.user && req.user.sub) || null,
            created_at: now,
            updated_at: now,
        }).returning('id');

        const id = row && row.id != null ? row.id : row;
        return R.successResponse(
            res,
            { id },
            'Update requested. The agent will check for and apply the latest version within a minute.',
            { status: 201, show: true },
        );
    } catch (err) {
        console.error('AgentCommandController.selfUpdate error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

module.exports = { openCompany, list, setAutoUpdate, setSyncDirection, selfUpdate };
