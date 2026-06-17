'use strict';

/**
 * api/Controllers/SuperAdmin/AgentReleaseController.js
 *
 * Super-admin publishing of the Tally Cloud Sync Agent executable
 * (Requirement 1). The operator drops a freshly-built TallyCloudSyncAgent.exe
 * into AGENT_RELEASE_DIR (env, default api/agent-releases/), then PUBLISHES its
 * version here — no code redeploy needed. The single agent_releases row with
 * is_current=true is the latest the agents auto-update to.
 *
 *   publish  POST /super-admin/agent-release  { version, filename, notes?, mandatory? }
 *   list     GET  /super-admin/agent-release   → { current, history, release_dir }
 *
 * Both are guarded by authenticate + requireSuperAdmin (wired in Routes/index.js)
 * exactly like the other /super-admin/* routes.
 */

const fs       = require('node:fs');
const crypto   = require('node:crypto');
const R        = require('../../Helpers/response');
const db       = require('../../config/db').db;
const agentRelease = require('../../Helpers/agentRelease');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

/**
 * Compute the sha256 hex of a file (sync; release files are small and this runs
 * only on the rare publish action). Returns null on any read error.
 */
function sha256File(filePath) {
    try {
        const buf = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(buf).digest('hex');
    } catch (e) {
        return null;
    }
}

/**
 * POST /super-admin/agent-release
 * Body: { version, filename, notes?, mandatory? }
 *
 * Validates that <AGENT_RELEASE_DIR>/<basename(filename)> exists, computes its
 * sha256 + size, inserts a new agent_releases row, and (in ONE transaction)
 * marks it the single is_current=true (clearing every other row). Idempotent-ish:
 * re-publishing the same version just adds a fresh current row.
 */
async function publish(req, res) {
    try {
        const b = req.body || {};
        const version  = String(b.version || '').trim();
        const filename = String(b.filename || '').trim();
        const notes    = b.notes != null ? String(b.notes) : null;
        const mandatory = !!b.mandatory;

        if (!version) return R.errorResponse(res, 'A release version is required.', 422);
        if (!filename) return R.errorResponse(res, 'The release filename is required.', 422);

        // Validate the file actually exists in the release dir. resolveFile takes
        // only the basename, so a crafted path can never escape the folder.
        const filePath = agentRelease.resolveFile(filename);
        if (!filePath) {
            return R.errorResponse(res, 'The release filename is invalid.', 422);
        }
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (e) {
            return R.errorResponse(res,
                `File "${filename}" was not found in the release folder (${agentRelease.releaseDir()}). ` +
                'Drop the built exe there first, then publish.', 422);
        }
        if (!stat.isFile()) {
            return R.errorResponse(res, `"${filename}" is not a file.`, 422);
        }

        const sha256 = sha256File(filePath);
        const sizeBytes = stat.size;
        const createdBy = (req.user && req.user.sub) ? Number(req.user.sub) : null;
        const safeName = require('node:path').basename(filename);

        const row = await db.transaction(async (trx) => {
            // Only one row may be current — clear the rest first.
            await trx('agent_releases').where('is_current', true).update({ is_current: false });
            const [inserted] = await trx('agent_releases').insert({
                version, filename: safeName, sha256, notes, mandatory,
                is_current: true, size_bytes: sizeBytes,
                created_by: createdBy, created_at: new Date(),
            }).returning(['id', 'version', 'filename', 'sha256', 'notes', 'mandatory',
                          'is_current', 'size_bytes', 'created_at']);
            return inserted;
        });

        return R.successResponse(res, {
            release: row,
            release_dir: agentRelease.releaseDir(),
        }, `Published agent v${version}. Agents will update within a minute.`);
    } catch (err) {
        console.error('AgentReleaseController.publish error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /super-admin/agent-release
 * Returns the current published release plus the full publish history (newest
 * first) and the configured release directory (so the operator knows where to
 * drop the exe).
 */
async function list(req, res) {
    try {
        const current = await agentRelease.currentRelease(db);
        const history = await db('agent_releases')
            .orderBy('id', 'desc')
            .limit(50)
            .select('id', 'version', 'filename', 'sha256', 'notes', 'mandatory',
                    'is_current', 'size_bytes', 'created_by', 'created_at');
        return R.successResponse(res, {
            current: current || null,
            history,
            release_dir: agentRelease.releaseDir(),
        });
    } catch (err) {
        console.error('AgentReleaseController.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { publish, list };
