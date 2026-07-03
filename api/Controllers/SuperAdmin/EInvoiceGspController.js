'use strict';

/**
 * api/Controllers/SuperAdmin/EInvoiceGspController.js
 *
 * Super-admin management of a license's GSP integration for e-Invoice/e-Way:
 *   GET   /super-admin/einvoice-gsp?license_id=  → settings + credential list (masked)
 *   POST  /super-admin/einvoice-gsp/credential   → upsert one credential (ENCRYPTED)
 *   POST  /super-admin/einvoice-gsp/settings     → upsert per-license settings
 *
 * Secrets (password / client_secret / api_key) are AES-256-GCM encrypted via
 * credVault BEFORE they touch the DB and are NEVER returned to the client — the
 * list only reports whether each secret is set. Requires EINVOICE_ENC_KEY.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { encrypt, isConfigured } = require('../../Modules/einvoice/lib/credVault');

const OOPS = 'Oops..Something went wrong. Please try again.';

function bool(v, dflt = false) {
    if (v === true || v === 'true' || v === 'on' || v === '1' || v === 1) return true;
    if (v === false || v === 'false' || v === 'off' || v === '0' || v === 0) return false;
    return dflt;
}

async function get(req, res) {
    try {
        const licenseId = Number(req.query.license_id) || null;
        if (!licenseId) return R.errorResponse(res, 'license_id is required.', 422);
        const [settings, creds] = await Promise.all([
            db('einvoice_settings').where({ license_id: licenseId }).first(),
            db('gsp_credentials').where({ license_id: licenseId })
                .select('id', 'provider', 'env', 'gstin', 'base_url', 'username', 'active', 'updated_at',
                    db.raw('(password_enc is not null) as has_password'),
                    db.raw('(client_secret_enc is not null) as has_client_secret'),
                    db.raw('(api_key_enc is not null) as has_api_key'))
                .orderBy('id', 'asc'),
        ]);
        return R.successResponse(res, {
            enc_configured: isConfigured(),
            settings: settings || {
                default_provider: 'nic', env: 'sandbox',
                auto_generate: false, auto_eway: false, auto_distance: true,
            },
            credentials: creds,
        });
    } catch (err) {
        console.error('einvoiceGsp.get error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function saveCredential(req, res) {
    try {
        const b = req.body || {};
        const licenseId = Number(b.license_id);
        if (!licenseId) return R.errorResponse(res, 'license_id is required.', 422);
        if (!isConfigured()) {
            return R.errorResponse(res, 'Set a 32-byte EINVOICE_ENC_KEY in the API .env before storing GSP credentials.', 422);
        }
        const provider = String(b.provider || 'nic').trim().toLowerCase();
        const env = String(b.env || 'sandbox').trim().toLowerCase();
        const gstin = (String(b.gstin || '').trim()) || null;

        const patch = {
            license_id: licenseId, provider, env, gstin,
            base_url: b.base_url || null,
            username: b.username || null,
            active: b.active === undefined ? true : bool(b.active, true),
            updated_at: new Date(),
        };
        // Only overwrite a secret when a NEW value is supplied (blank keeps the
        // existing ciphertext — so editing other fields never wipes the secret).
        if (b.password)      patch.password_enc      = encrypt(b.password);
        if (b.client_id)     patch.client_id_enc     = encrypt(b.client_id);
        if (b.client_secret) patch.client_secret_enc = encrypt(b.client_secret);
        if (b.api_key)       patch.api_key_enc       = encrypt(b.api_key);

        const existing = await db('gsp_credentials')
            .where({ license_id: licenseId, provider, env, gstin }).first('id');
        if (existing) await db('gsp_credentials').where('id', existing.id).update(patch);
        else await db('gsp_credentials').insert({ ...patch, created_by: req.user ? req.user.sub : null });

        return R.successResponse(res, { license_id: licenseId }, 'GSP credentials saved (encrypted at rest).');
    } catch (err) {
        console.error('einvoiceGsp.saveCredential error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

async function saveSettings(req, res) {
    try {
        const b = req.body || {};
        const licenseId = Number(b.license_id);
        if (!licenseId) return R.errorResponse(res, 'license_id is required.', 422);
        const patch = {
            license_id: licenseId,
            default_provider: String(b.default_provider || 'nic').trim().toLowerCase(),
            env: String(b.env || 'sandbox').trim().toLowerCase(),
            auto_generate: bool(b.auto_generate, false),
            auto_eway: bool(b.auto_eway, false),
            auto_distance: bool(b.auto_distance, true),
            updated_by: req.user ? req.user.sub : null,
            updated_at: new Date(),
        };
        const existing = await db('einvoice_settings').where({ license_id: licenseId }).first('id');
        if (existing) await db('einvoice_settings').where('id', existing.id).update(patch);
        else await db('einvoice_settings').insert(patch);
        return R.successResponse(res, { license_id: licenseId }, 'e-Invoice settings saved.');
    } catch (err) {
        console.error('einvoiceGsp.saveSettings error:', err);
        return R.errorResponse(res, OOPS, 500);
    }
}

module.exports = { get, saveCredential, saveSettings };
