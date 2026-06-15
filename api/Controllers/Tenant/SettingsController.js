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

/**
 * GET /api/v1/settings
 * Reads the company profile row + folds the settings rows into a flat object.
 */
async function get(req, res) {
    try {
        const company = await db('companies')
            .where('id', req.companyId)
            .first(...COMPANY_FIELDS);
        if (!company) return R.errorResponse(res, NOT_FOUND, 404);

        const rows = await db('settings')
            .where('company_id', req.companyId)
            .select('key', 'value');

        const settings = {};
        for (const row of rows) {
            settings[row.key] = row.value;
        }

        return R.successResponse(res, { company, settings });
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

        await db.transaction(async (trx) => {
            if (Object.keys(companyPatch).length > 0) {
                // timestamps(true,true) only defaults updated_at on INSERT — stamp
                // it explicitly so an edit doesn't leave it stale.
                await trx('companies')
                    .where('id', req.companyId)
                    .update({ ...companyPatch, updated_at: new Date() });
            }

            if (settingsPatchIn) {
                const now = new Date();
                for (const key of Object.keys(settingsPatchIn)) {
                    // `value` is a jsonb column — encode explicitly so scalars
                    // (string/number/bool) AND objects are written as valid jsonb
                    // (the driver won't reliably coerce a bare JS scalar).
                    const value = db.raw('?::jsonb', [JSON.stringify(settingsPatchIn[key] ?? null)]);
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

        return R.successResponse(res, { updated: true }, 'Settings saved.');
    } catch (err) {
        console.error('settings.update error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    get,
    update,
};
