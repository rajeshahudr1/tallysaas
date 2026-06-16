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
 * License scope: both read req.user.license_id (set by `authenticate`). A user
 * with no license can't queue/see agent commands.
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

module.exports = { openCompany, list };
