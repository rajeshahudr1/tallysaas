'use strict';

/**
 * api/tests/quotationList.test.js
 *
 * Pins the QuotationController.list response SHAPE against a fake tenant Knex
 * (no live db) — the exact bug this fix targets was a shape mismatch (`rows`/
 * `total`/`page`/`limit` instead of `{ data, meta }`) that made the web
 * layer's shared `apiList()` helper (web/routes/web.js) treat the quotation
 * list as always empty. Real db access is exercised through
 * `db/config.js`'s `runWithTenant(tenantKnex, fn)` AsyncLocalStorage seam, so
 * this runs the ACTUAL `list()` handler — not just an assertion on source
 * text — against a minimal fake query-builder standing in for Knex.
 */

const test = require('node:test');
const assert = require('node:assert');

const { runWithTenant } = require('../config/db');
const { list } = require('../Controllers/Tenant/QuotationController');

const FAKE_ROWS = [
    { id: 2, quotation_no: 'QTN-2026-0002', quote_status: 'open', valid_till: '2020-01-01', customer: 'Acme' },
    { id: 1, quotation_no: 'QTN-2026-0001', quote_status: 'accepted', valid_till: null, customer: 'Beta' },
];

/**
 * A minimal chainable stand-in for a Knex query builder. Every builder method
 * the controller calls (leftJoin/where/whereNull/clone/clearSelect/
 * clearOrder/offset/limit/orderBy) just returns `this` so calls can chain
 * freely; `count().first()` resolves the row count, `select()` makes the
 * whole chain `await`-able (via `.then`) to the fake rows.
 */
function makeFakeQb(rows, total) {
    let mode = 'rows'; // 'rows' | 'count'
    const qb = {
        leftJoin()   { return qb; },
        where()      { return qb; },
        whereNull()  { return qb; },
        whereIn()    { return qb; },
        offset()     { return qb; },
        limit()      { return qb; },
        orderBy()    { return qb; },
        clearSelect(){ return qb; },
        clearOrder() { return qb; },
        clone()      { return makeFakeQb(rows, total); },
        select()     { mode = 'rows'; return qb; },
        count()      { mode = 'count'; return qb; },
        first() {
            return Promise.resolve(mode === 'count' ? { c: total } : rows[0]);
        },
        then(resolve, reject) {
            return Promise.resolve(mode === 'count' ? { c: total } : rows).then(resolve, reject);
        },
    };
    return qb;
}

function makeFakeKnex(rows, total) {
    return function fakeKnex(_table) {
        return makeFakeQb(rows, total);
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

test('list() returns { data: [...], meta: {...} } matching the invoice list shape', async () => {
    const fakeKnex = makeFakeKnex(FAKE_ROWS, FAKE_ROWS.length);
    const req = {
        companyId: 1,
        locationId: null,
        isSalesman: false,
        isCustomerUser: false,
        user: { sub: 1 },
        query: {},
    };
    const res = makeRes();

    await runWithTenant(fakeKnex, () => list(req, res));

    assert.strictEqual(res.statusCode, 200, 'expected a 200 response');
    const payload = res.body && res.body.data;
    assert.ok(payload, 'response should carry a data envelope');

    assert.ok(Array.isArray(payload.data), 'payload.data must be an array');
    assert.strictEqual(payload.data.length, FAKE_ROWS.length);

    assert.ok(payload.meta && typeof payload.meta === 'object', 'payload.meta must be an object');
    // Same meta field names InvoiceController.listByType uses (total/page/per_page) —
    // pins the contract the web `apiList()` helper depends on. `grand_total` is
    // invoice-only (register summary) and intentionally absent here.
    assert.ok('total' in payload.meta, 'meta.total missing');
    assert.ok('page' in payload.meta, 'meta.page missing');
    assert.ok('per_page' in payload.meta, 'meta.per_page missing');
    assert.strictEqual(payload.meta.total, FAKE_ROWS.length);
    assert.strictEqual(payload.meta.page, 1);
    assert.strictEqual(payload.meta.per_page, 10);
});

test('list() honours page/per_page query params (not the old page/limit names)', async () => {
    const fakeKnex = makeFakeKnex(FAKE_ROWS, FAKE_ROWS.length);
    const req = {
        companyId: 1,
        locationId: null,
        isSalesman: false,
        isCustomerUser: false,
        user: { sub: 1 },
        query: { page: '2', per_page: '25' },
    };
    const res = makeRes();

    await runWithTenant(fakeKnex, () => list(req, res));

    const payload = res.body.data;
    assert.strictEqual(payload.meta.page, 2);
    assert.strictEqual(payload.meta.per_page, 25);
});

test('list() derives `expired` for an open quotation whose valid_till has passed, without writing to the db', async () => {
    const rows = [
        { id: 5, quotation_no: 'QTN-2026-0005', quote_status: 'open', valid_till: '2000-01-01', customer: 'Acme' },
    ];
    const fakeKnex = makeFakeKnex(rows, rows.length);
    const req = {
        companyId: 1,
        locationId: null,
        isSalesman: false,
        isCustomerUser: false,
        user: { sub: 1 },
        query: {},
    };
    const res = makeRes();

    await runWithTenant(fakeKnex, () => list(req, res));

    const payload = res.body.data;
    assert.strictEqual(payload.data[0].quote_status, 'expired');
});
