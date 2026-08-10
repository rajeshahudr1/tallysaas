'use strict';

/**
 * api/Helpers/uploads.js
 *
 * Local-disk image uploads (product gallery). Files land in
 * uploads/products/<company>/<file> and are served by the /uploads static mount
 * (wired in index.js). `fullUrl` turns a stored RELATIVE path into an ABSOLUTE
 * URL so the web + app never construct paths — the API always sends the full
 * URL. Validation: image mime-types only, ≤5 MB each, ≤8 per request.
 */

const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const R      = require('./response');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_SIZE    = 5 * 1024 * 1024;   // 5 MB per file
const MAX_FILES   = 8;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

const productImageStorage = multer.diskStorage({
    destination(req, file, cb) {
        const dir = path.join(UPLOAD_ROOT, 'products', String(req.companyId || 'misc'));
        ensureDir(dir);
        cb(null, dir);
    },
    filename(req, file, cb) {
        let ext = (path.extname(file.originalname) || '').toLowerCase();
        if (!/^\.(jpe?g|png|webp|gif)$/.test(ext)) ext = '.jpg';
        const rand = Math.random().toString(36).slice(2, 10);
        cb(null, `p${req.params.id || 'x'}_${Date.now()}_${rand}${ext}`);
    },
});

const _productImageUpload = multer({
    storage: productImageStorage,
    limits: { fileSize: MAX_SIZE, files: MAX_FILES },
    fileFilter(req, file, cb) {
        if (IMAGE_MIMES.has(file.mimetype)) cb(null, true);
        else cb(new Error('Only image files (JPG, PNG, WEBP, GIF) are allowed.'));
    },
});

/** Multer middleware for the product gallery — parses `images[]` + turns any
 * multer / validation error into a clean 422 instead of a generic 500. */
function productImagesMiddleware(req, res, next) {
    _productImageUpload.array('images', MAX_FILES)(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each image must be under 5 MB.'
                : err.code === 'LIMIT_FILE_COUNT' ? `Up to ${MAX_FILES} images at a time.`
                : (err.message || 'Upload failed.');
            return R.errorResponse(res, msg, 422);
        }
        next();
    });
}

/** Absolute URL for a stored relative path. Uses UPLOAD_BASE_URL when set
 * (production), else derives from the request host (local/dev). */
function fullUrl(req, filePath) {
    if (!filePath) return null;
    const base = (process.env.UPLOAD_BASE_URL || '').trim() || `${req.protocol}://${req.get('host')}`;
    return `${base.replace(/\/+$/, '')}/uploads/${String(filePath).replace(/^\/+/, '')}`;
}

/** Best-effort delete of a stored file (never throws). */
function deleteFile(filePath) {
    if (!filePath) return;
    try { fs.unlinkSync(path.join(UPLOAD_ROOT, filePath)); } catch (_) { /* already gone */ }
}

/** Write a Buffer to uploads/<relPath> (creating parent dirs). Returns relPath.
 * Used to publish a generated PDF (e-Invoice/e-Way) so WhatsApp can fetch it by
 * link. Overwrites any existing file at that path. */
function saveBuffer(relPath, buffer) {
    const abs = path.join(UPLOAD_ROOT, relPath);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, buffer);
    return relPath;
}

/**
 * Company branding images — the logo and the authorised signature that get
 * printed on a voucher.
 *
 * Stored under a FIXED name per company and kind, not a random one: there is
 * exactly one current logo, and a new upload replaces it. Random names would
 * leave every superseded logo on disk forever with nothing pointing at it.
 * The `?v=` cache-buster on the stored URL handles the browser side.
 */
const BRANDING_KINDS = new Set(['logo', 'signature']);

const brandingStorage = multer.diskStorage({
    destination(req, file, cb) {
        const dir = path.join(UPLOAD_ROOT, 'branding', String(req.companyId || 'misc'));
        ensureDir(dir);
        cb(null, dir);
    },
    filename(req, file, cb) {
        let ext = (path.extname(file.originalname) || '').toLowerCase();
        if (!/^\.(jpe?g|png|webp|gif)$/.test(ext)) ext = '.png';
        const kind = BRANDING_KINDS.has(String(req.params.kind)) ? req.params.kind : 'logo';
        cb(null, `${kind}${ext}`);
    },
});

const _brandingUpload = multer({
    storage: brandingStorage,
    limits: { fileSize: MAX_SIZE, files: 1 },
    fileFilter(req, file, cb) {
        if (IMAGE_MIMES.has(file.mimetype)) cb(null, true);
        else cb(new Error('Only image files (JPG, PNG, WEBP, GIF) are allowed.'));
    },
});

/** Multer middleware for a single branding image, posted as `image`. */
function brandingImageMiddleware(req, res, next) {
    _brandingUpload.single('image')(req, res, (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'The image must be under 5 MB.'
                : (err.message || 'Upload failed.');
            return R.errorResponse(res, msg, 422);
        }
        next();
    });
}

module.exports = {
    productImagesMiddleware, brandingImageMiddleware, BRANDING_KINDS,
    fullUrl, deleteFile, saveBuffer, UPLOAD_ROOT,
};
