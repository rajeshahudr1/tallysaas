'use strict';

/**
 * api/Controllers/Tenant/SupplierController.js
 *
 * Tenant CRUD for suppliers (Tally "sundry creditors"), wired entirely through
 * the crudController factory — the same pattern CustomerController established.
 * There is intentionally NO bespoke query logic here: company scoping,
 * soft-delete, pagination, search and the response envelope all live in
 * Helpers/crudController.
 *
 * Resource specifics supplied to the factory:
 *   • table       — 'suppliers'
 *   • baseQuery   — LEFT JOIN to locations so list/get rows carry a friendly
 *                   `location` name label (NULL when unassigned).
 *   • searchCols  — name / mobile / email / gst_number (ILIKE'd on ?search).
 *   • buildInsert — maps the validated create body to a row; company_id is
 *                   stamped by the factory.
 *   • buildUpdate — maps ONLY the keys present in the validated update body, so a
 *                   partial PUT leaves untouched columns alone.
 *
 * Exports the five handlers { list, get, create, update, destroy } for Routes.
 */

const crud = require('../../Helpers/crudController');
const db   = require('../../config/db').db;
const { cutoffFromDays } = require('../../Helpers/inactiveCutoff');

// Columns returned by list/get. `suppliers.*` gives every base column; the
// aliased join adds a human-readable label for the location FK target.
const LIST_COLUMNS = [
    'suppliers.*',
    'locations.name as location',
    // Closing balance comes from the Tally ledger master, not from
    // suppliers.opening_balance: the opening figure is where the party STARTED
    // and would be stale the moment the first voucher lands.
    'tl.closing_balance as closing_balance',
    // Credit term: what was set HERE wins, else what Tally already knows
    // (BILLCREDITPERIOD on the ledger).
    db.raw('coalesce(suppliers.credit_days, tl.credit_period_days) as credit_days'),
    // NOT aliased `supplier_group`: suppliers already has a column of that name
    // (what the user typed), and one alias over two columns means whichever the
    // driver returns last silently wins.
    'tl.parent as tally_ledger_group',
    // When we last bought from this supplier — the column that shows who has
    // gone quiet.
    db.raw(`(select max(i.invoice_date) from invoices i
              where i.company_id = suppliers.company_id
                and i.supplier_id = suppliers.id
                and i.type = 'purchase'
                and i.deleted_at is null
            ) as last_purchased_date`),
];

// Free-text search targets (qualified — the base query has a join, so bare
// column names would be ambiguous).
const SEARCH_COLS = [
    'suppliers.name',
    'suppliers.mobile',
    'suppliers.email',
    'suppliers.gst_number',
    'suppliers.pan_number',
    'suppliers.address',
    'locations.name',
];

/**
 * Base query with the location label join. The factory layers
 * `where suppliers.company_id = ?` and `whereNull(suppliers.deleted_at)` on top,
 * so the tenant + soft-delete columns are referenced by their qualified names.
 */
function baseQuery(database) {
    return database('suppliers')
        .leftJoin('locations', 'locations.id', 'suppliers.location_id')
        // The synced Tally ledger of the same name, matched by name because the
        // sync writes no ledger FK back onto the cloud party row.
        .leftJoin('tally_ledgers as tl', function join() {
            this.on('tl.company_id', '=', 'suppliers.company_id')
                .andOn(database.raw('lower(tl.name) = lower(suppliers.name)'));
        });
}

/**
 * Map the validated CREATE body to an insertable row. Only known columns are
 * copied — extraneous keys can't slip into the INSERT. `company_id` is added by
 * the factory (`{ [tenantCol]: req.companyId, ...buildInsert(...) }`).
 *
 * Joi has already applied defaults for opening_balance / status /
 * is_tally_ledger, so they are present here; the remaining optionals fall back
 * to undefined and Knex omits them (the table defaults / NULLs apply).
 */
function buildInsert(body) {
    return {
        name:             body.name,
        mobile:           body.mobile,
        alternate_mobile: body.alternate_mobile,
        email:            body.email,
        gst_number:       body.gst_number,
        pan_number:       body.pan_number,
        supplier_group:   body.supplier_group,
        location_id:      body.location_id,
        opening_balance:  body.opening_balance,
        payment_terms:    body.payment_terms,
        credit_days:      body.credit_days,
        address:          body.address,
        status:           body.status,
        is_tally_ledger:  body.is_tally_ledger,
        custom_fields:    (body.custom_fields && typeof body.custom_fields === 'object')
            ? JSON.stringify(body.custom_fields) : undefined,
    };
}

// Updatable columns — the keys buildUpdate may patch.
const UPDATABLE = [
    'name', 'mobile', 'alternate_mobile', 'email', 'gst_number', 'pan_number',
    'supplier_group', 'location_id', 'opening_balance', 'payment_terms', 'credit_days',
    'address', 'status', 'is_tally_ledger', 'custom_fields', 'is_favourite',
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
    if (patch.custom_fields && typeof patch.custom_fields === 'object') {
        patch.custom_fields = JSON.stringify(patch.custom_fields);
    }
    // Cloud edit → re-push to Tally (ALTER). EXCEPT when the only thing that
    // changed is cloud-only metadata: a star is our own shortlist, Tally has
    // no field for it, so flagging the ledger dirty would queue a pointless
    // ALTER for every supplier someone happens to star.
    const CLOUD_ONLY = new Set(['is_favourite']);
    const touchesTally = Object.keys(patch).some((k) => !CLOUD_ONLY.has(k));
    if (touchesTally) patch.tally_dirty = true;
    return patch;
}

// Build the five handlers from the factory and re-export them by name.
const controller = crud.build({
    table:       'suppliers',
    notFound:    'Supplier not found.',
    tenantCol:   'company_id',
    listColumns: LIST_COLUMNS,
    listOrder:   [['suppliers.id', 'desc']],
    searchCols:  SEARCH_COLS,
    // Extra sortable UI keys (name/status/created_at sort by default).
    sortable: {
        location:        'locations.name',
        mobile:          'suppliers.mobile',
        gst:             'suppliers.gst_number',
        opening_balance: 'suppliers.opening_balance',
        credit_days:     'suppliers.credit_days',
        closing_balance: 'tl.closing_balance',
        last_purchased_date: 'last_purchased_date',
        group:           'suppliers.supplier_group',
        favourite:       'suppliers.is_favourite',
    },
    // Filter dropdowns (?key=value) → WHERE.
    filters: {
        location:       (qb, v) => qb.where('locations.name', v),
        supplier_group: (qb, v) => qb.where('suppliers.supplier_group', v),
        gst:            (qb, v) => qb.where('suppliers.gst_number', 'ilike', `%${v}%`),
        // ?favourite=1 — the starred shortlist. Any other value is ignored
        // rather than treated as "not favourite": a tab that silently
        // inverts on a typo is worse than one that does nothing.
        favourite: (qb, v) => (String(v) === '1' || String(v) === 'true'
            ? qb.where('suppliers.is_favourite', true)
            : qb),
        // ?active=90 — suppliers WE BOUGHT FROM in the last N days, the
        // "Recent Active" tab.
        active: (qb, v) => {
            const cutoff = cutoffFromDays(v);
            if (!cutoff) return qb;
            return qb.whereExists(function () {
                this.select(db.raw('1')).from('invoices')
                    .whereRaw('invoices.supplier_id = suppliers.id')
                    .whereNull('invoices.deleted_at')
                    .where('invoices.type', 'purchase')
                    .where('invoices.invoice_date', '>=', cutoff);
            });
        },
    },
    baseQuery,
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
