'use strict';

/**
 * api/Controllers/Tenant/LocationController.js
 *
 * Tenant CRUD for the `locations` resource (branches / godowns / billing
 * points), wired entirely through the crudController factory — company scoping,
 * soft-delete, pagination, search and the response envelope all live in
 * Helpers/crudController. There is intentionally NO bespoke query logic here.
 *
 * Resource specifics supplied to the factory:
 *   • table       — 'locations'
 *   • searchCols  — name / code / city / state (ILIKE'd on ?search; qualified so
 *                   they stay unambiguous if joins are ever added).
 *   • buildInsert — maps the validated create body to a row; company_id is
 *                   stamped by the factory.
 *   • buildUpdate — maps ONLY the keys present in the validated update body, so a
 *                   partial PUT leaves untouched columns alone.
 *
 * No joins — `manager` is a plain text column, so list/get return `locations.*`
 * directly with no label aliases.
 *
 * Exports the five handlers { list, get, create, update, destroy } for Routes.
 */

const crud = require('../../Helpers/crudController');

// Columns returned by list/get. `locations.*` gives every base column; there
// are no FK label joins for this resource.
const LIST_COLUMNS = [
    'locations.*',
];

// Free-text search targets (qualified — keeps them unambiguous if joins appear).
const SEARCH_COLS = [
    'locations.name',
    'locations.code',
    'locations.city',
    'locations.state',
    'locations.pincode',
    'locations.mobile',
    'locations.manager',
];

/**
 * Map the validated CREATE body to an insertable row. Only known columns are
 * copied — extraneous keys can't slip into the INSERT. `company_id` is added by
 * the factory (`{ [tenantCol]: req.companyId, ...buildInsert(...) }`).
 *
 * Joi has already applied defaults for status / is_tally_godown, so they are
 * present here; the remaining optionals fall back to undefined and Knex omits
 * them (the table defaults / NULLs apply).
 */
function buildInsert(body) {
    return {
        name:            body.name,
        code:            body.code,
        city:            body.city,
        state:           body.state,
        pincode:         body.pincode,
        mobile:          body.mobile,
        manager:         body.manager,
        status:          body.status,
        is_tally_godown: body.is_tally_godown,
        custom_fields: (body.custom_fields && typeof body.custom_fields === 'object')
            ? JSON.stringify(body.custom_fields) : undefined,
    };
}

// Updatable columns — the keys buildUpdate may patch.
const UPDATABLE = [
    'name', 'code', 'city', 'state', 'pincode',
    'mobile', 'manager', 'status', 'is_tally_godown', 'custom_fields',
];

/**
 * Map the validated UPDATE body to a patch containing ONLY the keys the client
 * actually sent (the update schema applies no defaults). This keeps a partial
 * PUT partial — absent fields are not overwritten with undefined/null.
 */
function buildUpdate(body) {
    const patch = {};
    for (const key of UPDATABLE) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
            patch[key] = body[key];
        }
    }
    // JSONB column wants a string, not a JS object.
    if (patch.custom_fields && typeof patch.custom_fields === 'object') {
        patch.custom_fields = JSON.stringify(patch.custom_fields);
    }
    patch.tally_dirty = true;   // cloud edit → re-push to Tally (ALTER)
    return patch;
}

// Build the five handlers from the factory and re-export them by name.
const controller = crud.build({
    table:       'locations',
    notFound:    'Location not found.',
    tenantCol:   'company_id',
    listColumns: LIST_COLUMNS,
    listOrder:   [['locations.id', 'desc']],
    searchCols:  SEARCH_COLS,
    // Extra sortable UI keys (name/status/created_at are sortable everywhere).
    sortable: {
        code:    'locations.code',
        city:    'locations.city',
        state:   'locations.state',
        mobile:  'locations.mobile',
        manager: 'locations.manager',
    },
    buildInsert,
    buildUpdate,
});

module.exports = {
    list:    controller.list,
    get:     controller.get,
    create:  controller.create,
    update:  controller.update,
    destroy: controller.destroy,
};
