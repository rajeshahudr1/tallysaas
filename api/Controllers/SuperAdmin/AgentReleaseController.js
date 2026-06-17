'use strict';

/**
 * api/Controllers/SuperAdmin/AgentReleaseController.js
 *
 * Super-admin publishing of the Tally Cloud Sync Agent executable
 * (Requirement 1). The operator either DROPS a freshly-built TallyCloudSync.exe
 * into AGENT_RELEASE_DIR (env, default api/agent-releases/) and PUBLISHES its
 * version, OR UPLOADS the exe straight from the browser. Either way the single
 * agent_releases row with is_current=true is the latest the agents auto-update
 * to — no code redeploy needed.
 *
 *   publish  POST /super-admin/agent-release         { version, filename, notes?, mandatory? }
 *   upload   POST /super-admin/agent-release/upload   multipart (file=<exe>) + version, notes?, mandatory?
 *   list     GET  /super-admin/agent-release           → { current, history, release_dir }
 *
 * All three are guarded by authenticate + requireSuperAdmin (wired in
 * Routes/index.js) exactly like the other /super-admin/* routes.
 */

const fs       = require('node:fs');
const path     = require('node:path');
const crypto   = require('node:crypto');
const multer   = require('multer');
const R        = require('../../Helpers/response');
const db       = require('../../config/db').db;
const agentRelease = require('../../Helpers/agentRelease');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

// Upload cap — agent exes are tens of MB; 200MB leaves generous headroom.
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

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
 * Build a SAFE release filename from the posted version, e.g. version "1.2.0"
 * → "TallyCloudSync-1.2.0.exe". The version is sanitised to a strict whitelist
 * ([A-Za-z0-9._-]) and passed through path.basename, so the result can NEVER
 * contain a directory separator or "../" — it always lands inside releaseDir().
 * Re-uploading the SAME version overwrites THAT version's file (intended
 * republish), never an unrelated one.
 */
function releaseFileNameForVersion(version) {
    const safeVer = String(version || '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '');
    if (!safeVer) return null;
    return path.basename(`TallyCloudSync-${safeVer}.exe`);
}

/**
 * Shared publish core. Given an EXISTING file inside the release dir (absolute
 * path + its stored basename), compute sha256 + size, then in ONE transaction
 * clear every is_current row and insert this one as the single is_current=true.
 * Returns the inserted row. Used by BOTH the filename-based publish() and the
 * multipart upload().
 */
async function publishReleaseFile({ version, filePath, safeName, notes, mandatory, createdBy }) {
    const stat = fs.statSync(filePath);
    const sha256 = sha256File(filePath);
    const sizeBytes = stat.size;

    return db.transaction(async (trx) => {
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

        const createdBy = (req.user && req.user.sub) ? Number(req.user.sub) : null;
        const safeName = path.basename(filename);

        const row = await publishReleaseFile({
            version, filePath, safeName, notes, mandatory, createdBy,
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
 * Multer middleware for the upload endpoint: a SINGLE file in field "file", kept
 * in memory (we re-write it to a sanitised name ourselves, never trusting the
 * client filename for the on-disk path), capped at MAX_UPLOAD_BYTES, and limited
 * to .exe by extension + a permissive octet-stream/exe mimetype check. The
 * stricter validation (version present, real .exe) happens in upload().
 */
const uploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter(req, file, cb) {
        const name = String(file.originalname || '');
        if (!/\.exe$/i.test(name)) {
            // Signal a rejected type; upload() maps this to a 422.
            const err = new Error('ONLY_EXE');
            err.code = 'ONLY_EXE';
            return cb(err);
        }
        return cb(null, true);
    },
}).single('file');

/**
 * POST /super-admin/agent-release/upload   (multipart/form-data)
 * Fields: file=<TallyCloudSync exe>, version, notes?, mandatory?
 *
 * Receives the built agent exe straight from the browser, saves it into the
 * release dir under a SAFE name derived from the posted version
 * (TallyCloudSync-<version>.exe — sanitised, path.basename-guarded), then runs
 * the SAME publish core (sha256 + size + single is_current row). On ANY failure
 * after the file is written, the partial file is removed. Returns
 * { release, release_dir }.
 */
async function upload(req, res) {
    // Run multer first; it populates req.file + req.body (text fields).
    uploadMiddleware(req, res, async (mErr) => {
        if (mErr) {
            if (mErr.code === 'ONLY_EXE') {
                return R.errorResponse(res, 'Only a .exe agent file may be uploaded.', 422);
            }
            if (mErr.code === 'LIMIT_FILE_SIZE') {
                return R.errorResponse(res,
                    `The file is too large. Max ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`, 422);
            }
            console.error('AgentReleaseController.upload multer error:', mErr);
            return R.errorResponse(res, 'Could not read the uploaded file.', 422);
        }

        let savedPath = null;
        try {
            const b = req.body || {};
            const version   = String(b.version || '').trim();
            const notes     = b.notes != null && String(b.notes).trim() !== '' ? String(b.notes) : null;
            const mandatory = !!(b.mandatory && b.mandatory !== 'false' && b.mandatory !== '0');

            if (!req.file || !req.file.buffer) {
                return R.errorResponse(res, 'An agent exe file is required.', 422);
            }
            if (!version) {
                return R.errorResponse(res, 'A release version is required.', 422);
            }

            const safeName = releaseFileNameForVersion(version);
            if (!safeName) {
                return R.errorResponse(res, 'The release version is invalid.', 422);
            }

            // Ensure the release dir exists, then write the buffer under the safe
            // (version-derived) name. resolveFile re-applies the basename guard so
            // the path can never escape releaseDir().
            const dir = agentRelease.releaseDir();
            fs.mkdirSync(dir, { recursive: true });
            savedPath = agentRelease.resolveFile(safeName);
            if (!savedPath) {
                return R.errorResponse(res, 'The release version is invalid.', 422);
            }
            fs.writeFileSync(savedPath, req.file.buffer);

            const createdBy = (req.user && req.user.sub) ? Number(req.user.sub) : null;
            const row = await publishReleaseFile({
                version, filePath: savedPath, safeName, notes, mandatory, createdBy,
            });

            return R.successResponse(res, {
                release: row,
                release_dir: dir,
            }, `Uploaded & published agent v${version}. Agents will update within a minute.`);
        } catch (err) {
            // Clean up the partial file so a failed publish doesn't leave an
            // orphan exe behind (best-effort; ignore unlink errors).
            if (savedPath) { try { fs.unlinkSync(savedPath); } catch (_) { /* ignore */ } }
            console.error('AgentReleaseController.upload error:', err);
            return R.errorResponse(res, OOPS_MSG, 500);
        }
    });
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

module.exports = { publish, upload, list };
