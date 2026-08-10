'use strict';

/**
 * api/Controllers/Tenant/SettingsController.js
 *
 * The company-settings endpoint. Backs a single screen that mixes two stores:
 *
 *   • the company PROFILE — a few editable columns on the caller's `companies`
 *     row (name / email / mobile / gst_number / pan_number / financial_year /
 *     address).
 *   • a flat key/value SETTINGS bag — rows in the `settings` table, company
 *     scoped, folded into a plain `{ key: value }` object.
 *
 *   • get    — GET /settings : returns { company:{...}, settings:{...} }.
 *   • update — PUT /settings : body may carry company:{...} (patch the editable
 *              profile columns) and/or settings:{key:value,...} (UPSERT each by
 *              (company_id, key)). Both halves run in one transaction so the save
 *              is all-or-nothing. Returns { updated: true }.
 *
 * Conventions: company-scoped by req.companyId (resolveCompany), every handler
 * async + try/catch → console.error + 500 envelope.
 */

const R  = require('../../Helpers/response');
const db = require('../../config/db').db;
const masterDb = require('../../config/masterDb').db;   // licenses live in the master control plane
const { fullUrl, deleteFile, BRANDING_KINDS } = require('../../Helpers/uploads');

const OOPS_MSG     = 'Oops..Something went wrong. Please try again.';
const NOT_FOUND    = 'Company not found.';

// The companies columns surfaced as the editable profile. `name` and `email` are
// also editable; status / license_id / id are server-managed and never patched.
const COMPANY_FIELDS = [
    'name',
    'email',
    'mobile',
    'gst_number',
    'pan_number',
    'financial_year',
    'address',
];

// The SYNC flags live on the LICENSE (license-scoped), NOT in the per-company
// `settings` bag — they control the agent. The Settings form now EDITS them, so
// these are the keys we accept in body.settings and route to the licenses row.
// `push_enabled` / `pull_enabled` are accepted as aliases of the sync_* columns
// so the form (or app) can submit either spelling.
const SYNC_KEY_TO_COLUMN = {
    auto_update:       'auto_update',
    sync_enabled:      'sync_enabled',
    sync_push_enabled: 'sync_push_enabled',
    push_enabled:      'sync_push_enabled',
    sync_pull_enabled: 'sync_pull_enabled',
    pull_enabled:      'sync_pull_enabled',
};

// Coerce a checkbox/string-tolerant truthy value to a strict boolean (matches
// AgentCommandController's toBool so the Settings form and the dashboard agree).
// The bare-form switches post a hidden empty companion + the checkbox under the
// SAME name, so an extended-parsed body yields an ARRAY (e.g. ['', 'on']) when
// checked or a bare '' when unchecked — take the LAST value so a checked box wins.
function toBool(raw) {
    const v = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    return (v === true || v === 1 || v === '1'
        || v === 'true' || v === 'on' || v === 'yes');
}

/**
 * GET /api/v1/settings
 * Reads the company profile row + folds the settings rows into a flat object.
 */
async function get(req, res) {
    try {
        // license_id is read here (not surfaced as editable) so we can prefill the
        // license-scoped SYNC flags below. The company may be ABSENT — a license-
        // admin with no company yet (companies are created on first agent sync)
        // resolves req.companyId === null. We must NOT 404 in that case: the
        // company-profile/settings halves come back empty, but the Tally Sync tab
        // still loads/edits the user's OWN license (req.user.license_id fallback).
        const company = req.companyId
            ? await db('companies')
                .where('id', req.companyId)
                .first(...COMPANY_FIELDS, 'license_id')
            : null;

        const rows = req.companyId
            ? await db('settings')
                .where('company_id', req.companyId)
                .select('key', 'value')
            : [];

        const settings = {};
        for (const row of rows) {
            settings[row.key] = row.value;
        }

        // The SYNC toggles live on the LICENSE, so the Settings form prefills from
        // there (NOT from the settings bag). Default ON when the column/row is
        // null/unreadable (matches the agent + SyncController defaults), so an
        // older license / pre-migration DB shows all-ON with no regression. Best-
        // effort: a read hiccup must never sink the whole settings load.
        // SM is the single source of truth for the syncable-module catalog +
        // per-module selection parsing. `modules` (the {key,label} list) is
        // surfaced so the Settings popup can render every checkbox; push_modules /
        // pull_modules carry the current selection (ALL when unconfigured).
        const SM = require('../../Helpers/syncModules');
        let sync = {
            auto_update: true, push_enabled: true, pull_enabled: true, sync_enabled: true,
            push_modules: SM.ALL_KEYS.slice(), pull_modules: SM.ALL_KEYS.slice(),
        };
        try {
            // Prefer the company's license; fall back to the caller's OWN license
            // (req.user.license_id) so a license-admin with no company still sees
            // their real sync flags on the Tally Sync tab.
            const licenseId = (company && company.license_id)
                || (req.user && req.user.license_id) || null;
            if (licenseId) {
                const lic = await masterDb('licenses')
                    .where('id', licenseId)
                    .first('auto_update', 'sync_push_enabled', 'sync_pull_enabled', 'sync_enabled',
                           'sync_push_modules', 'sync_pull_modules');
                if (lic) {
                    sync = {
                        auto_update:  lic.auto_update       != null ? !!lic.auto_update       : true,
                        push_enabled: lic.sync_push_enabled != null ? !!lic.sync_push_enabled : true,
                        pull_enabled: lic.sync_pull_enabled != null ? !!lic.sync_pull_enabled : true,
                        sync_enabled: lic.sync_enabled      != null ? !!lic.sync_enabled      : true,
                        push_modules: SM.effectiveKeys(lic.sync_push_modules),
                        pull_modules: SM.effectiveKeys(lic.sync_pull_modules),
                    };
                }
            }
        } catch (e) {
            sync = {
                auto_update: true, push_enabled: true, pull_enabled: true, sync_enabled: true,
                push_modules: SM.ALL_KEYS.slice(), pull_modules: SM.ALL_KEYS.slice(),
            };
        }

        // Strip the internal-only license_id from the surfaced company object.
        // company may be null (license-admin with no company yet) — surface null.
        let companyOut = null;
        if (company) {
            const { license_id, ...rest } = company;
            companyOut = rest;
        }
        // Branding images are stored as RELATIVE paths; the web and the app
        // must never build a URL themselves, so they are sent absolute. The
        // stored path already carries a version suffix, so a replaced logo
        // is not served from cache.
        const branding = {};
        for (const kind of BRANDING_KINDS) {
            const p = settings[`${kind}_path`];
            branding[kind] = p ? fullUrl(req, p) : null;
        }

        return R.successResponse(res, {
            company: companyOut, settings, sync, branding,
            // The full syncable-module catalog for rendering the auto-sync popup.
            modules: SM.SYNC_MODULES,
        });
    } catch (err) {
        console.error('settings.get error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * PUT /api/v1/settings
 * Patches the editable company profile columns and/or UPSERTs key/value settings
 * rows. Both halves run in a single transaction so the save is atomic.
 */
async function update(req, res) {
    try {
        const body            = req.body || {};
        const companyPatchIn  = body.company  && typeof body.company  === 'object' ? body.company  : null;
        const settingsPatchIn = body.settings && typeof body.settings === 'object' ? body.settings : null;

        // Build the company patch from ONLY the editable keys the client sent.
        const companyPatch = {};
        if (companyPatchIn) {
            for (const field of COMPANY_FIELDS) {
                if (Object.prototype.hasOwnProperty.call(companyPatchIn, field)) {
                    companyPatch[field] = companyPatchIn[field];
                }
            }
        }

        // Split the SYNC flags out of the settings bag — they belong on the
        // LICENSE (they control the agent), not in the per-company `settings`
        // table. Build a licenses patch (last spelling wins for aliased keys) and
        // a cleaned settings object that excludes the sync keys so they are NOT
        // also stored as company settings.
        //
        // The two halves live in DIFFERENT DATABASES and so cannot share one
        // transaction: `db` is a per-request proxy onto the license's tenant
        // knex, while `licenses` is a master control-plane table. Writing the
        // flags through the tenant transaction threw "relation licenses does not
        // exist" and the whole save returned a 500 — and because the form's
        // switches always post (a hidden companion makes an unchecked box submit
        // too), that was EVERY save, not an edge case.
        const licensePatch  = {};
        const settingsClean = {};
        if (settingsPatchIn) {
            for (const key of Object.keys(settingsPatchIn)) {
                const col = SYNC_KEY_TO_COLUMN[key];
                if (col) {
                    licensePatch[col] = toBool(settingsPatchIn[key]);
                } else {
                    settingsClean[key] = settingsPatchIn[key];
                }
            }
        }
        const hasSettings = Object.keys(settingsClean).length > 0;
        const hasLicense  = Object.keys(licensePatch).length > 0;

        // Resolve the company's license up front when we have sync flags to write,
        // so we can fail clearly before opening the txn. The route is already
        // authenticated + company-scoped (can('settings','edit')), so whoever may
        // edit settings may flip these — consistent with the rest of the save.
        let licenseId = null;
        if (hasLicense) {
            // Prefer the selected company's license (typical case)…
            if (req.companyId) {
                const comp = await db('companies').where('id', req.companyId).first('license_id');
                licenseId = comp ? comp.license_id : null;
            }
            // …else fall back to the caller's OWN license, so a license-admin with
            // no company yet can still edit their Tally Sync settings.
            if (!licenseId && req.user && req.user.license_id) {
                licenseId = req.user.license_id;
            }
            if (!licenseId) {
                return R.errorResponse(res,
                    'Your account is not linked to a license, so sync settings cannot be changed.', 422);
            }
        }

        await db.transaction(async (trx) => {
            // Profile + settings-bag writes are company-scoped: skip them when no
            // company exists/selected (license-admin saving ONLY sync flags). The
            // license write below still runs off licenseId.
            if (req.companyId && Object.keys(companyPatch).length > 0) {
                // timestamps(true,true) only defaults updated_at on INSERT — stamp
                // it explicitly so an edit doesn't leave it stale.
                await trx('companies')
                    .where('id', req.companyId)
                    .update({ ...companyPatch, updated_at: new Date() });
            }

            if (hasSettings && req.companyId) {
                const now = new Date();
                for (const key of Object.keys(settingsClean)) {
                    // `value` is a jsonb column — encode explicitly so scalars
                    // (string/number/bool) AND objects are written as valid jsonb
                    // (the driver won't reliably coerce a bare JS scalar).
                    const value = db.raw('?::jsonb', [JSON.stringify(settingsClean[key] ?? null)]);
                    await trx('settings')
                        .insert({
                            company_id: req.companyId,
                            key,
                            value,
                            created_at: now,
                            updated_at: now,
                        })
                        .onConflict(['company_id', 'key'])
                        .merge({ value, updated_at: now });
                }
            }
        });

        // SYNC flags → the licenses row, on the MASTER connection. The agent
        // reads these back (heartbeat / version), so the Settings form is now
        // their editor. Written after the tenant transaction commits: two
        // databases cannot share one, and of the two orders this is the safer —
        // a failure here leaves the profile saved and reports the error, rather
        // than flipping the customer's agent for a save that then rolled back.
        if (hasLicense) {
            await masterDb('licenses')
                .where('id', licenseId)
                .whereNull('deleted_at')
                .update({ ...licensePatch, updated_at: new Date() });
        }

        return R.successResponse(res, { updated: true }, 'Settings saved.');
    } catch (err) {
        console.error('settings.update error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * POST /settings/branding/:kind — replace the company logo or the
 * authorised signature (multipart, field `image`).
 *
 * The file lands at a fixed name per company+kind, so a new upload
 * overwrites the old one on disk. What is STORED in settings is that path
 * plus a `?v=` stamp: without it the browser (and the PDF renderer) keep
 * serving the previous image from cache, and the user concludes the upload
 * silently failed.
 */
async function uploadBranding(req, res) {
    try {
        const kind = String(req.params.kind || '');
        if (!BRANDING_KINDS.has(kind)) return R.errorResponse(res, 'Unknown image type.', 422);
        if (!req.file) return R.errorResponse(res, 'No image was uploaded.', 422);

        const rel = `branding/${req.companyId}/${req.file.filename}`;
        const stamped = `${rel}?v=${Date.now()}`;
        const key = `${kind}_path`;

        // UPSERT by (company_id, key) — the same shape update() uses for
        // every other setting.
        const existing = await db('settings')
            .where({ company_id: req.companyId, key }).first('id');
        // settings.value is JSONB, so a bare string is not valid input — it
        // has to be encoded as a JSON string, the same way update() does.
        const value = db.raw('?::jsonb', [JSON.stringify(stamped)]);
        if (existing) {
            await db('settings').where('id', existing.id).update({ value });
        } else {
            await db('settings').insert({ company_id: req.companyId, key, value });
        }

        return R.successResponse(res, { kind, url: fullUrl(req, stamped) },
            kind === 'logo' ? 'Company logo updated.' : 'Signature updated.');
    } catch (err) {
        console.error('settings.uploadBranding error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/** DELETE /settings/branding/:kind — go back to printing no image. */
async function removeBranding(req, res) {
    try {
        const kind = String(req.params.kind || '');
        if (!BRANDING_KINDS.has(kind)) return R.errorResponse(res, 'Unknown image type.', 422);
        const key = `${kind}_path`;
        const row = await db('settings').where({ company_id: req.companyId, key }).first('id', 'value');
        if (row) {
            // Strip the cache-buster before touching the filesystem — the
            // `?v=` is part of the URL, never part of the filename.
            deleteFile(String(row.value || '').split('?')[0]);
            await db('settings').where('id', row.id).del();
        }
        return R.successResponse(res, { kind }, 'Image removed.');
    } catch (err) {
        console.error('settings.removeBranding error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    get,
    update,
    uploadBranding,
    removeBranding,
};
