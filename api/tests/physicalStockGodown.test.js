'use strict';

/**
 * api/tests/physicalStockGodown.test.js
 *
 * Pins the fix for the notes/godown collision in PhysicalStockController:
 * a sheet created with both a per-line godown AND a sheet narration must
 * round-trip both, each from its own column (`godown`, `notes`) — neither
 * one silently overwriting the other, as `notes: narration || it.godown ||
 * null` used to.
 *
 * Uses a minimal fake Knex through runWithTenant(), same pattern as
 * quotationConvert.test.js (no live db).
 */

const test = require('node:test');
const assert = require('node:assert');

const { runWithTenant } = require('../config/db');
const { create, get } = require('../Controllers/Tenant/PhysicalStockController');

function col(name) {
    const i = name.indexOf('.');
    return i >= 0 ? name.slice(i + 1) : name;
}

function matchRow(row, filters, nullFilters) {
    for (const [k, v] of filters) if (row[k] !== v) return false;
    for (const k of nullFilters) if (row[k] != null) return false;
    return true;
}

function makeQb(table, store) {
    const filters = [];
    const nullFilters = [];
    let joinTable = null;
    const qb = {
        leftJoin(t) { joinTable = t; return qb; },
        where(a, b) {
            if (a && typeof a === 'object') {
                for (const k of Object.keys(a)) {
                    if (a[k] === null) nullFilters.push(col(k));
                    else filters.push([col(k), a[k]]);
                }
            } else {
                filters.push([col(a), b]);
            }
            return qb;
        },
        whereNull(c) { nullFilters.push(col(c)); return qb; },
        forUpdate() { return qb; },
        orderBy() { return qb; },
        groupBy() { return qb; },
        offset() { return qb; },
        limit() { return qb; },
        select() { return qb; },
        clone() { return qb; },
        countDistinct() {
            const matches = store[table].filter((r) => matchRow(r, filters, nullFilters));
            const distinct = new Set(matches.map((r) => r.voucher_no));
            return { first: () => Promise.resolve({ c: distinct.size }) };
        },
        first(...cols) {
            const matches = store[table].filter((r) => matchRow(r, filters, nullFilters));
            const row = matches[0] || null;
            if (!row) return Promise.resolve(null);
            if (!cols.length) return Promise.resolve(row);
            const picked = {};
            for (const c of cols) picked[c] = row[c];
            return Promise.resolve(picked);
        },
        insert(rowOrRows) {
            const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
            const inserted = rows.map((r) => {
                const maxId = store[table].reduce((m, x) => Math.max(m, x.id || 0), 0);
                const full = { id: maxId + 1, ...r };
                store[table].push(full);
                return full;
            });
            return {
                returning() { return Promise.resolve(inserted); },
            };
        },
        update(patch) {
            const matches = store[table].filter((r) => matchRow(r, filters, nullFilters));
            matches.forEach((r) => Object.assign(r, patch));
            return Promise.resolve(matches.length);
        },
        then(resolve, reject) {
            let matches = store[table].filter((r) => matchRow(r, filters, nullFilters));
            if (joinTable === 'products') {
                matches = matches.map((r) => {
                    const p = store.products.find((x) => x.id === r.product_id);
                    return { ...r, product_name: p ? p.name : null, product_sku: p ? p.sku : null };
                });
            }
            return Promise.resolve(matches).then(resolve, reject);
        },
    };
    return qb;
}

function makeFakeKnex(store) {
    const fakeKnex = (table) => makeQb(table, store);
    fakeKnex.transaction = async (cb) => {
        const trxFn = (table) => makeQb(table, store);
        return cb(trxFn);
    };
    return fakeKnex;
}

function makeStore() {
    return {
        products: [{ id: 1, company_id: 1, name: 'Widget', sku: 'W-1', opening_stock: 5, deleted_at: null }],
        stock_adjustments: [],
    };
}

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

function makeReq(overrides) {
    return {
        body: {},
        companyId: 1,
        locationId: null,
        user: { sub: 1 },
        params: {},
        ...overrides,
    };
}

test('create() writes the line godown and the sheet narration to separate columns, and get() returns both intact', async () => {
    const store = makeStore();
    const fakeKnex = makeFakeKnex(store);

    const createReq = makeReq({
        body: {
            count_date: '2026-08-06',
            notes: 'Quarterly count', // sheet narration
            items: [{ product_id: 1, counted_qty: 8, godown: 'Main Warehouse' }],
        },
    });
    const createRes = makeRes();
    await runWithTenant(fakeKnex, () => create(createReq, createRes));

    assert.strictEqual(createRes.body.status, 200, JSON.stringify(createRes.body));
    const voucherNo = createRes.body.data.voucher_no;

    // The underlying row must carry the godown and the narration in their
    // own columns — neither one clobbering the other.
    const row = store.stock_adjustments[0];
    assert.strictEqual(row.godown, 'Main Warehouse');
    assert.strictEqual(row.notes, 'Quarterly count');

    const getReq = makeReq({ params: { voucher_no: voucherNo } });
    const getRes = makeRes();
    await runWithTenant(fakeKnex, () => get(getReq, getRes));

    assert.strictEqual(getRes.body.status, 200, JSON.stringify(getRes.body));
    assert.strictEqual(getRes.body.data.narration, 'Quarterly count');
    assert.strictEqual(getRes.body.data.items[0].godown, 'Main Warehouse');
});

test('get() does not surface an old row\'s notes-as-godown as a narration', () => {
    // A row written by the pre-fix code, before the `godown` column existed:
    // `notes` holds a godown value, and there is no way to tell it apart
    // from a real narration by inspection — so it must not be surfaced as
    // one.
    const store = makeStore();
    store.stock_adjustments.push({
        id: 1, company_id: 1, product_id: 1, voucher_no: 'PS-OLD-0001',
        voucher_kind: 'physical_stock', notes: 'Main Warehouse', godown: null,
        adjustment_date: '2026-01-01', created_by: 1, after_qty: 5, before_qty: 5,
        type: 'set', reason: 'Physical Stock', status: 'draft_cloud',
    });
    const fakeKnex = makeFakeKnex(store);

    return runWithTenant(fakeKnex, async () => {
        const getReq = makeReq({ params: { voucher_no: 'PS-OLD-0001' } });
        const getRes = makeRes();
        await get(getReq, getRes);
        assert.strictEqual(getRes.body.status, 200);
        assert.strictEqual(getRes.body.data.narration, null, 'must not show the old godown as a narration');
    });
});
