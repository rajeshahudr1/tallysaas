'use strict';

/**
 * api/Controllers/SuperAdmin/AppReleaseController.js
 *
 * Mobile-app auto-update — mirrors AgentReleaseController for the .apk.
 *
 * Super-admin (authenticate + requireSuperAdmin):
 *   upload        POST /super-admin/app-release/upload   multipart file=<apk> + version, version_code, notes?, mandatory?
 *   list          GET  /super-admin/app-release           → { current, history, release_dir, auto_update }
 *   setAutoUpdate POST /super-admin/app-release/auto-update { enabled }
 *
 * App-facing (public — the app may check before login, incl. a forced update):
 *   getVersion    GET  /app/version?version_code=N        → { latest_version, latest_code, update_available, mandatory, notes, download_url, enabled }
 *   download      GET  /app/download                       → streams the current apk
 */

const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const R      = require('../../Helpers/response');
const db     = require('../../config/db').db;
const appRelease = require('../../Helpers/appRelease');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;   // APKs are tens of MB

function sha256File(filePath) {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch (e) { return null; }
}

/** "1.2.0" → "TallyCloudSync-1.2.0.apk" (sanitised + basename-guarded). */
function releaseFileNameForVersion(version) {
    const safeVer = String(version || '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '');
    if (!safeVer) return null;
    return path.basename(`TallyCloudSync-${safeVer}.apk`);
}

/** Clear every is_current row and insert this file as the single current one. */
async function publishReleaseFile({ version, versionCode, filePath, safeName, notes, mandatory, createdBy }) {
    const stat = fs.statSync(filePath);
    const sha256 = sha256File(filePath);
    return db.transaction(async (trx) => {
        await trx('app_releases').where('is_current', true).update({ is_current: false });
        const [inserted] = await trx('app_releases').insert({
            version, version_code: versionCode, filename: safeName, sha256, notes, mandatory,
            is_current: true, size_bytes: stat.size, created_by: createdBy, created_at: new Date(),
        }).returning(['id', 'version', 'version_code', 'filename', 'sha256', 'notes',
                      'mandatory', 'is_current', 'size_bytes', 'created_at']);
        return inserted;
    });
}

const uploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter(req, file, cb) {
        if (!/\.apk$/i.test(String(file.originalname || ''))) {
            const err = new Error('ONLY_APK'); err.code = 'ONLY_APK'; return cb(err);
        }
        return cb(null, true);
    },
}).single('file');

async function upload(req, res) {
    uploadMiddleware(req, res, async (mErr) => {
        if (mErr) {
            if (mErr.code === 'ONLY_APK') return R.errorResponse(res, 'Only a .apk file may be uploaded.', 422);
            if (mErr.code === 'LIMIT_FILE_SIZE') return R.errorResponse(res, `The file is too large. Max ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))}MB.`, 422);
            return R.errorResponse(res, 'Could not read the uploaded file.', 422);
        }
        let savedPath = null;
        try {
            const b = req.body || {};
            const version     = String(b.version || '').trim();
            const versionCode = parseInt(b.version_code, 10);
            const notes       = b.notes != null && String(b.notes).trim() !== '' ? String(b.notes) : null;
            const mandatory   = !!(b.mandatory && b.mandatory !== 'false' && b.mandatory !== '0');

            if (!req.file || !req.file.buffer) return R.errorResponse(res, 'An .apk file is required.', 422);
            if (!version) return R.errorResponse(res, 'A release version (e.g. 1.0.1) is required.', 422);
            if (!Number.isInteger(versionCode) || versionCode <= 0) {
                return R.errorResponse(res, 'A valid version code (the APK build number, e.g. 2) is required.', 422);
            }

            const safeName = releaseFileNameForVersion(version);
            if (!safeName) return R.errorResponse(res, 'The release version is invalid.', 422);

            const dir = appRelease.releaseDir();
            fs.mkdirSync(dir, { recursive: true });
            savedPath = appRelease.resolveFile(safeName);
            if (!savedPath) return R.errorResponse(res, 'The release version is invalid.', 422);
            fs.writeFileSync(savedPath, req.file.buffer);

            const createdBy = (req.user && req.user.sub) ? Number(req.user.sub) : null;
            const row = await publishReleaseFile({ version, versionCode, filePath: savedPath, safeName, notes, mandatory, createdBy });
            return R.successResponse(res, { release: row, release_dir: dir }, `Uploaded & published app v${version} (build ${versionCode}).`);
        } catch (err) {
            if (savedPath) { try { fs.unlinkSync(savedPath); } catch (_) {} }
            console.error('AppReleaseController.upload error:', err);
            return R.errorResponse(res, OOPS_MSG, 500);
        }
    });
}

async function list(req, res) {
    try {
        const current = await appRelease.currentRelease(db);
        const history = await db('app_releases').orderBy('id', 'desc').limit(50)
            .select('id', 'version', 'version_code', 'filename', 'sha256', 'notes',
                    'mandatory', 'is_current', 'size_bytes', 'created_by', 'created_at');
        const autoUpdate = await appRelease.autoUpdateEnabled(db);
        return R.successResponse(res, { current: current || null, history, release_dir: appRelease.releaseDir(), auto_update: autoUpdate });
    } catch (err) {
        console.error('AppReleaseController.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

async function setAutoUpdate(req, res) {
    try {
        const b = req.body || {};
        const enabled = !!(b.enabled === true || b.enabled === 'true' || b.enabled === '1' || b.enabled === 'on');
        await appRelease.setAutoUpdate(db, enabled);
        return R.successResponse(res, { auto_update: enabled }, `App auto-update turned ${enabled ? 'ON' : 'OFF'}.`);
    } catch (err) {
        console.error('AppReleaseController.setAutoUpdate error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** App-facing version check. Never throws to the client — a table hiccup returns
 * a safe "no update" shape so a broken release row can't brick the app. */
async function getVersion(req, res) {
    try {
        const installedCode = parseInt((req.query && req.query.version_code) || '0', 10) || 0;
        let rel = null;
        try { rel = await appRelease.currentRelease(db); } catch (e) { rel = null; }
        const enabled = await appRelease.autoUpdateEnabled(db);
        const latestCode = rel ? Number(rel.version_code || 0) : 0;
        return R.successResponse(res, {
            latest_version:   rel ? rel.version : null,
            latest_code:      latestCode,
            update_available: !!(enabled && rel && installedCode < latestCode),
            mandatory:        rel ? !!rel.mandatory : false,
            notes:            rel ? (rel.notes || null) : null,
            sha256:           rel ? (rel.sha256 || null) : null,
            size_bytes:       rel ? (rel.size_bytes || null) : null,
            download_url:     '/api/v1/app/download',
            enabled,
        }, 'ok');
    } catch (err) {
        console.error('AppReleaseController.getVersion error:', err);
        return R.successResponse(res, {
            latest_version: null, latest_code: 0, update_available: false,
            mandatory: false, notes: null, sha256: null, size_bytes: null,
            download_url: '/api/v1/app/download', enabled: true,
        }, 'ok');
    }
}

/** Streams the current published .apk (public — the app fetches it to install). */
async function download(req, res) {
    try {
        const rel = await appRelease.currentRelease(db);
        if (!rel || !rel.filename) return R.errorResponse(res, 'No app release is currently published.', 404);
        const filePath = appRelease.resolveFile(rel.filename);
        if (!filePath) return R.errorResponse(res, 'Release file name is invalid.', 404);
        let stat;
        try { stat = fs.statSync(filePath); } catch (e) { return R.errorResponse(res, 'Release file is missing on the server.', 404); }
        res.setHeader('Content-Type', 'application/vnd.android.package-archive');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(rel.filename)}"`);
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        console.error('AppReleaseController.download error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { upload, list, setAutoUpdate, getVersion, download };
