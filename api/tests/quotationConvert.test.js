'use strict';

/**
 * api/tests/quotationConvert.test.js
 *
 * Pins two fixes to QuotationController.convert() against a fake tenant Knex
 * (no live db), run through `runWithTenant()` exactly like quotationList.test.js:
 *
 *   1. Double-convert race: the "already converted?" check and the write that
 *      claims the quotation both happen inside ONE transaction, as a
 *      conditional UPDATE (`WHERE ... AND converted_invoice_id IS NULL`). If
 *      that update affects 0 rows (another request won the race), the whole
 *      transaction is rolled back — including the invoice/invoice_items that
 *      were inserted earlier in the same transaction — so the loser creates
 *      NO invoice at all, and the handler returns 409.
 *   2. Scoping: convert() applies the same req.locationId / req.isSalesman
 *      restrictions as get(), so a salesman cannot convert a quotation they
 *      do not own (the lookup returns nothing -> 404).
 */

const test = require('node:test');
const assert = require('node:assert');

const { runWithTenant } = require('../config/db');
const { convert } = require('../Controllers/Tenant/QuotationController');

// ── minimal fake Knex ────────────────────────────────────────────────────
function col(name) {
    const i = name.indexOf('.');
    return i >= 0 ? name.slice(i + 1) : name;
}

function matchRow(row, filters, nullFilters) {
    for (const [k, v] of filters) if (row[k] !== v) return false;
    for (const k of nullFilters) if (row[k] != null) return false;
    return true;
}

function makeQb(table, store, opts) {
    const filters = [];
    const nullFilters = [];
    const qb = {
        leftJoin() { return qb; },
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
        orderBy() { return qb; },
        select() { return qb; },
        count() {
            return {
                first() {
                    const matches = store[table].filter((r) => matchRow(r, filters, nullFilters));
                    return Promise.resolve({ c: matches.length });
                },
            };
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
                returning(c) {
                    if (c === '*') return Promise.resolve(inserted);
                    return Promise.resolve(inserted.map((r) => ({ [c]: r.id })));
                },
            };
        },
        update(patch) {
            if (opts.forceZeroClaim && table === 'quotations' && nullFilters.includes('converted_invoice_id')) {
                return Promise.resolve(0);
            }
            const matches = store[table].filter((r) => matchRow(r, filters, nullFilters));
            matches.forEach((r) => Object.assign(r, patch));
            return Promise.resolve(matches.length);
        },
        first() {
            const matches = store[table].filter((r) => matchRow(r, filters, nullFilters));
            return Promise.resolve(matches[0] || null);
        },
        then(resolve, reject) {
            const matches = store[table].filter((r) => matchRow(r, filters, nullFilters));
            return Promise.resolve(matches).then(resolve, reject);
        },
    };
    return qb;
}

function cloneStore(store) {
    return {
        quotations: store.quotations.map((r) => ({ ...r })),
        quotation_items: store.quotation_items.map((r) => ({ ...r })),
        invoices: store.invoices.map((r) => ({ ...r })),
        invoice_items: store.invoice_items.map((r) => ({ ...r })),
        record_history: store.record_history.map((r) => ({ ...r })),
    };
}

function makeFakeKnex(store, opts) {
    const fakeKnex = (table) => makeQb(table, store, opts);
    fakeKnex.transaction = async (cb) => {
        const draft = cloneStore(store);
        const trxFn = (table) => makeQb(table, draft, opts);
        const result = await cb(trxFn); // throws propagate => rollback (draft discarded)
        // commit: copy draft rows back into the real store
        store.quotations = draft.quotations;
        store.quotation_items = draft.quotation_items;
        store.invoices = draft.invoices;
        store.invoice_items = draft.invoice_items;
        store.record_history = draft.record_history;
        return result;
    };
    return fakeKnex;
}

function baseQuotation(overrides) {
    return {
        id: 10,
        company_id: 1,
        deleted_at: null,
        converted_invoice_id: null,
        location_id: null,
        customer_id: 5,
        sales_person_id: null,
        subtotal: 100,
        discount: 0,
        taxable: 100,
        cgst: 9,
        sgst: 9,
        igst: 0,
        tax_amount: 18,
        round_off: 0,
        total: 118,
        notes: null,
        created_by: 1,
        quote_status: 'open',
        ...overrides,
    };
}

function makeStore(quotationOverrides) {
    return {
        quotations: [baseQuotation(quotationOverrides)],
        quotation_items: [],
        invoices: [],
        invoice_items: [],
        record_history: [],
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
        params: { id: '10' },
        companyId: 1,
        locationId: null,
        isSalesman: false,
        isCustomerUser: false,
        customerId: null,
        user: { sub: 1 },
        ...overrides,
    };
}

test('convert() on an already-converted quotation returns 409 and creates no invoice', async () => {
    const store = makeStore({ converted_invoice_id: 999 });
    const fakeKnex = makeFakeKnex(store, { forceZeroClaim: false });
    const req = makeReq();
    const res = makeRes();

    await runWithTenant(fakeKnex, () => convert(req, res));

    assert.strictEqual(res.statusCode, 200, 'transport status is always 200; logical status lives in body.status');
    assert.strictEqual(res.body.status, 409);
    assert.strictEqual(store.invoices.length, 0, 'no invoice should have been created');
});

test('convert() rolls back and 409s when the atomic claim update affects 0 rows (lost race)', async () => {
    // Quotation looks unconverted at the initial lookup...
    const store = makeStore({ converted_invoice_id: null });
    // ...but the conditional claim UPDATE inside the transaction is forced to
    // affect 0 rows, simulating a concurrent request that won the race and
    // committed first. The handler must treat this as "already converted",
    // roll back the transaction, and must NOT leave behind the invoice it
    // inserted earlier in that same (rolled-back) transaction.
    const fakeKnex = makeFakeKnex(store, { forceZeroClaim: true });
    const req = makeReq();
    const res = makeRes();

    await runWithTenant(fakeKnex, () => convert(req, res));

    assert.strictEqual(res.body.status, 409);
    assert.strictEqual(store.invoices.length, 0, 'losing request must create NO invoice at all');
    assert.strictEqual(store.quotations[0].converted_invoice_id, null, 'quotation must not be claimed by the loser');
});

test('convert() 404s when a salesman tries to convert another user\'s quotation (not scoped to them)', async () => {
    const store = makeStore({ created_by: 1 }); // owned by user 1
    const fakeKnex = makeFakeKnex(store, { forceZeroClaim: false });
    const req = makeReq({ isSalesman: true, user: { sub: 2 } }); // acting as user 2
    const res = makeRes();

    await runWithTenant(fakeKnex, () => convert(req, res));

    assert.strictEqual(res.body.status, 404);
    assert.strictEqual(store.invoices.length, 0);
});

test('convert() succeeds for the owning salesman and claims the quotation', async () => {
    const store = makeStore({ created_by: 2 });
    const fakeKnex = makeFakeKnex(store, { forceZeroClaim: false });
    const req = makeReq({ isSalesman: true, user: { sub: 2 } });
    const res = makeRes();

    await runWithTenant(fakeKnex, () => convert(req, res));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(store.invoices.length, 1);
    assert.strictEqual(store.quotations[0].converted_invoice_id, store.invoices[0].id);
});
