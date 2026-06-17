'use strict';

/**
 * api/Helpers/crudController.js
 *
 * Factory that builds the FIVE standard tenant-scoped CRUD handlers
 * (`list / get / create / update / destroy`) from a per-resource config.
 * Every later tenant controller (products, suppliers, invoices, …) is wired
 * through this so the company-scoping + soft-delete + pagination rules live
 * in exactly one place.
 *
 * Adapted from the IOT reference factory but stripped to the TallySaaS model:
 *   • SINGLE DB — scope is `company_id = req.companyId` (resolved by the
 *     companyScope middleware), NOT a per-tenant connection.
 *   • Soft delete sets `deleted_at` (the IOT `status:'D'` convention is gone).
 *   • DROPPED entirely: outbox / dual-write, companyMetrics, employeeScope,
 *     branchCol, csvBranchCol — none apply here.
 *
 * config = {
 *   table:       'customers',
 *   notFound:    'Customer not found.',
 *   tenantCol:   'company_id',                     // default 'company_id'
 *   listColumns: ['customers.*', 'l.name as ...'], // SELECT columns
 *   listOrder:   [['customers.id', 'desc']],       // ORDER BY pairs
 *   searchCols:  ['customers.name', 'customers.mobile'], // ILIKE'd on ?search
 *
 *   // Optional base query (joins, default aliases). Receives (db) and MUST
 *   // return a Knex builder already FROM the table. The factory applies the
 *   // company scope + whereNull('deleted_at') on top, so qualify the tenant
 *   // and deleted_at columns with the table name when you join.
 *   baseQuery?:  (db) => db('customers').leftJoin(...),
 *
 *   // Optional pre-create / pre-update uniqueness check.
 *   // Return { msg, status } when a conflict is detected, else null/undefined.
 *   uniqueCheck?: async (db, body, companyId, currentId?) => null | { msg, status },
 *
 *   // Optional FK existence check — same return shape.
 *   fkCheck?:     async (db, body, companyId) => null | { msg, status },
 *
 *   buildInsert: (body, companyId) => row,         // company_id added if absent
 *   buildUpdate: (body) => patch,                  // updated_at appended automatically
 * }
 */

const R  = require('./response');
const db = require('../config/db').db;
const { recordHistory } = require('./history');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

// table name → history `module` slug (matches the route slugs, e.g.
// 'sales_persons' → 'sales-persons'). Falls back to the table name with
// underscores hyphenated so any future table still gets a sensible slug.
function moduleSlug(table) {
    const map = {
        customers:        'customers',
        suppliers:        'suppliers',
        products:         'products',
        categories:       'categories',
        locations:        'locations',
        sales_persons:    'sales-persons',
        customer_groups:  'customer-groups',
    };
    return map[table] || String(table).replace(/_/g, '-');
}

// Pagination bounds — keep a misbehaving client from asking for a million rows.
const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE     = 100;

// Tables that carry a `location_id` column (verified against the migrations:
// 20260101000011 customers, 20260101000012 suppliers, 20260101000015 inventory,
// 20260101000016 invoices, 20260101000006 users, 20260101000026 stock_adjustments,
// 20260101000009 sales_person_locations). When a request is location-restricted
// (req.locationId is a number), the factory ADDS `.where(location_id, ...)` to
// list/get/count and DEFAULTS the column on create. Tables NOT in this set
// (products, payments, journals, categories, …) are unaffected — the filter is
// silently skipped so company scoping is the only guard there.
const LOCATION_SCOPED_TABLES = new Set([
    'customers',
    'suppliers',
    'invoices',
    'inventory',
    'users',
    'stock_adjustments',
    'sales_person_locations',
]);

function tableHasLocation(table) {
    return LOCATION_SCOPED_TABLES.has(table);
}

function build(config) {
    const {
        table,
        notFound,
        tenantCol   = 'company_id',
        listColumns = ['*'],
        listOrder   = [['id', 'desc']],
        searchCols  = [],
        sortable,
        baseQuery,
        uniqueCheck,
        fkCheck,
        buildInsert,
        buildUpdate,
    } = config;

    // Whitelist of sortable UI keys → SQL columns. `name`/`status`/`created_at`
    // exist on every master table, so they sort everywhere; a resource may add
    // more (e.g. { opening_balance: 'customers.opening_balance' }) via config.
    const sortMap = Object.assign({
        name:       `${table}.name`,
        status:     `${table}.status`,
        created_at: `${table}.created_at`,
    }, sortable || {});

    // Fully-qualified column names so they stay unambiguous once joins exist.
    const tenantColQualified   = `${table}.${tenantCol}`;
    const deletedColQualified  = `${table}.deleted_at`;
    const idColQualified       = `${table}.id`;
    const locationColQualified = `${table}.location_id`;

    // Does this table participate in per-user location scoping?
    const hasLocation = tableHasLocation(table);

    // Base, company-scoped, not-soft-deleted query. `baseQuery` lets a resource
    // add joins/aliases; we always layer the tenant + deleted_at filters on top.
    // ADDITIVELY: when the caller is location-restricted (req.locationId is a
    // number) AND this table carries a location_id column, we also pin
    // location_id = req.locationId — company_id stays the primary tenant guard,
    // location scope is layered on top and cannot widen what company scope allows.
    function scoped(req) {
        const qb = baseQuery ? baseQuery(db) : db(table);
        qb.where(tenantColQualified, req.companyId).whereNull(deletedColQualified);
        if (hasLocation && req.locationId != null) {
            qb.where(locationColQualified, req.locationId);
        }
        return qb;
    }

    // Ownership lookup for update/destroy on the BASE table (no label joins).
    // Mirrors `scoped`'s guards (tenant + soft-delete + location) so a
    // location-restricted user can neither update nor delete a row that belongs
    // to another location — even by guessing its id. Returns the existing row or
    // undefined (treated as not-found / not-owned by the caller).
    function ownedRowQuery(req, id) {
        const qb = db(table)
            .where(tenantColQualified, req.companyId)
            .whereNull(deletedColQualified)
            .where(idColQualified, id);
        if (hasLocation && req.locationId != null) {
            qb.where(locationColQualified, req.locationId);
        }
        return qb;
    }

    function parsePagination(query) {
        let page    = parseInt(query.page, 10);
        let perPage = parseInt(query.per_page, 10);
        if (!Number.isInteger(page)    || page    < 1) page    = 1;
        if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_PER_PAGE;
        if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;
        return { page, perPage };
    }

    async function list(req, res) {
        try {
            const { page, perPage } = parsePagination(req.query);
            const search = (req.query.search || '').trim();
            const status = (req.query.status || '').trim();

            let qb = scoped(req);

            // Optional status filter (qualified to the base table).
            if (status) qb = qb.where(`${table}.status`, status);

            // Free-text search across the configured columns (case-insensitive).
            if (search && searchCols.length) {
                const like = `%${search}%`;
                qb = qb.where((b) => {
                    for (const col of searchCols) b.orWhere(col, 'ilike', like);
                });
            }

            // Count BEFORE pagination — clone so the count query isn't mutated
            // by the subsequent offset/limit/select/order.
            const totalRow = await qb.clone().clearSelect().clearOrder()
                .count(`${idColQualified} as c`).first();
            const total = Number(totalRow ? totalRow.c : 0);

            let rowQb = qb.offset((page - 1) * perPage).limit(perPage).select(...listColumns);
            // Optional client sort (?sort=<uiKey>&order=asc|desc) against the
            // whitelist; unknown keys fall back to the resource's default order.
            const sortKey = (req.query.sort || '').trim();
            const order   = String(req.query.order || '').toLowerCase() === 'asc' ? 'asc' : 'desc';
            if (sortKey && sortMap[sortKey]) {
                rowQb = rowQb.orderBy(sortMap[sortKey], order).orderBy(idColQualified, 'desc');
            } else {
                for (const [col, dir] of listOrder) rowQb = rowQb.orderBy(col, dir);
            }
            const rows = await rowQb;

            return R.successResponse(res, {
                data: rows,
                meta: { total, page, per_page: perPage },
            });
        } catch (err) {
            console.error(`${table}.list error:`, err);
            return R.errorResponse(res, OOPS_MSG, 500);
        }
    }

    async function get(req, res) {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, notFound, 404);
        try {
            const row = await scoped(req).where(idColQualified, id)
                .select(...listColumns).first();
            if (!row) return R.errorResponse(res, notFound, 404);
            return R.successResponse(res, row);
        } catch (err) {
            console.error(`${table}.get error:`, err);
            return R.errorResponse(res, OOPS_MSG, 500);
        }
    }

    async function create(req, res) {
        try {
            if (fkCheck) {
                const fk = await fkCheck(db, req.body, req.companyId);
                if (fk) return R.errorResponse(res, fk.msg, fk.status || 422);
            }
            if (uniqueCheck) {
                const dup = await uniqueCheck(db, req.body, req.companyId);
                if (dup) return R.errorResponse(res, dup.msg, dup.status || 422);
            }
            // Always stamp the tenant id, even if buildInsert forgot it.
            const row = { [tenantCol]: req.companyId, ...buildInsert(req.body, req.companyId) };

            // Location scoping on create: a location-restricted creator (a user
            // pinned to one branch) can only create rows IN that branch. Force
            // location_id = req.locationId when the table carries the column and
            // the request is restricted — overriding any other value in the body
            // so a restricted user can't plant a row in another location by
            // passing a foreign id. Unrestricted callers (location_id null) keep
            // whatever buildInsert produced (their chosen/blank location).
            if (hasLocation && req.locationId != null) {
                row.location_id = req.locationId;
            }

            const [created] = await db(table).insert(row).returning('*');

            // HISTORY (best-effort): a create has no before snapshot.
            await recordHistory(db, {
                company_id:  req.companyId,
                module:      moduleSlug(table),
                record_type: singular(table),
                record_id:   created ? created.id : null,
                action:      'created',
                source:      'cloud',
                before:      null,
                after:       created,
                changed_by:  req.user ? req.user.sub : null,
            });

            return R.successResponse(res, created, `${singular(table)} created.`);
        } catch (err) {
            console.error(`${table}.create error:`, err);
            return R.errorResponse(res, OOPS_MSG, 500);
        }
    }

    async function update(req, res) {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, notFound, 404);
        try {
            // Existence + ownership check via the scoped base query (tenant +
            // soft-delete + location). A location-restricted user updating a row
            // outside their location simply gets a not-found.
            const existing = await ownedRowQuery(req, id).first();
            if (!existing) return R.errorResponse(res, notFound, 404);

            if (fkCheck) {
                const fk = await fkCheck(db, req.body, req.companyId);
                if (fk) return R.errorResponse(res, fk.msg, fk.status || 422);
            }
            if (uniqueCheck) {
                const dup = await uniqueCheck(db, req.body, req.companyId, id);
                if (dup) return R.errorResponse(res, dup.msg, dup.status || 422);
            }

            const patch = { ...buildUpdate(req.body), updated_at: new Date() };

            // Location scoping on update: a location-restricted user owns this row
            // (ownedRowQuery already proved it is IN their location), but must not
            // be able to MOVE it to another location via the body. Force
            // location_id back to req.locationId so a restricted caller can never
            // push a row out of their own branch. Unrestricted callers (locationId
            // null) keep whatever buildUpdate produced.
            if (hasLocation && req.locationId != null) {
                patch.location_id = req.locationId;
            }

            const [updated] = await db(table).where('id', id).update(patch).returning('*');

            // HISTORY (best-effort): `existing` is the row BEFORE the update.
            // recordHistory skips writing when nothing actually changed.
            await recordHistory(db, {
                company_id:  req.companyId,
                module:      moduleSlug(table),
                record_type: singular(table),
                record_id:   id,
                action:      'updated',
                source:      'cloud',
                before:      existing,
                after:       updated,
                changed_by:  req.user ? req.user.sub : null,
            });

            return R.successResponse(res, updated, `${singular(table)} updated.`);
        } catch (err) {
            console.error(`${table}.update error:`, err);
            return R.errorResponse(res, OOPS_MSG, 500);
        }
    }

    async function destroy(req, res) {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return R.errorResponse(res, notFound, 404);
        try {
            // Ownership check honours the location filter too (see ownedRowQuery).
            const existing = await ownedRowQuery(req, id).first();
            if (!existing) return R.errorResponse(res, notFound, 404);

            const now = new Date();
            // Soft delete — set deleted_at; row stays for audit/restore.
            await db(table).where('id', id).update({ deleted_at: now, updated_at: now });

            // HISTORY (best-effort): a delete records the row as it was, no after.
            await recordHistory(db, {
                company_id:  req.companyId,
                module:      moduleSlug(table),
                record_type: singular(table),
                record_id:   id,
                action:      'deleted',
                source:      'cloud',
                before:      existing,
                after:       null,
                changed_by:  req.user ? req.user.sub : null,
            });

            return R.successResponse(res, { id }, `${singular(table)} deleted.`);
        } catch (err) {
            console.error(`${table}.destroy error:`, err);
            return R.errorResponse(res, OOPS_MSG, 500);
        }
    }

    return { list, get, create, update, destroy };
}

// Table name → human singular label for success messages.
//   "customers"       → "Customer"
//   "categories"      → "Category"        (ies → y)
//   "sales_persons"   → "Sales Person"    (underscores → spaced, title-cased)
//   "customer_groups" → "Customer Group"
function singular(table) {
    let base = String(table);
    if (/ies$/.test(base))                         base = base.replace(/ies$/, 'y');
    else if (/(ses|xes|zes|ches|shes)$/.test(base)) base = base.replace(/es$/, '');
    else                                            base = base.replace(/s$/, '');
    return base
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

module.exports = { build };
