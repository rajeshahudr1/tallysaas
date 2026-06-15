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

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

// Pagination bounds — keep a misbehaving client from asking for a million rows.
const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE     = 100;

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
    const tenantColQualified  = `${table}.${tenantCol}`;
    const deletedColQualified = `${table}.deleted_at`;
    const idColQualified      = `${table}.id`;

    // Base, company-scoped, not-soft-deleted query. `baseQuery` lets a resource
    // add joins/aliases; we always layer the tenant + deleted_at filters on top.
    function scoped(companyId) {
        const qb = baseQuery ? baseQuery(db) : db(table);
        return qb.where(tenantColQualified, companyId).whereNull(deletedColQualified);
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

            let qb = scoped(req.companyId);

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
            const row = await scoped(req.companyId).where(idColQualified, id)
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
            const [created] = await db(table).insert(row).returning('*');
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
            // Existence + ownership check via the scoped base query.
            const existing = await db(table)
                .where(tenantColQualified, req.companyId)
                .whereNull(deletedColQualified)
                .where(idColQualified, id)
                .first();
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
            const [updated] = await db(table).where('id', id).update(patch).returning('*');
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
            const existing = await db(table)
                .where(tenantColQualified, req.companyId)
                .whereNull(deletedColQualified)
                .where(idColQualified, id)
                .first();
            if (!existing) return R.errorResponse(res, notFound, 404);

            const now = new Date();
            // Soft delete — set deleted_at; row stays for audit/restore.
            await db(table).where('id', id).update({ deleted_at: now, updated_at: now });
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
