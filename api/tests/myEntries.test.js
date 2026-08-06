const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MIG = path.join(__dirname, '..', 'db', 'migrations_tenant', '20260806060000_created_by_backfill_columns.js');

test('the migration adds created_by to the three tables that lack it', () => {
    assert.ok(fs.existsSync(MIG), 'migration file missing');
    const src = fs.readFileSync(MIG, 'utf8');
    for (const t of ['customers', 'products', 'receipts']) {
        assert.ok(src.includes(`'${t}'`), `table ${t} not handled`);
    }
    assert.ok(src.includes("'created_by'"));
    const m = require(MIG);
    assert.strictEqual(typeof m.up, 'function');
    assert.strictEqual(typeof m.down, 'function');
});

test('the migration does not try to guess an author for old rows', () => {
    const src = fs.readFileSync(MIG, 'utf8');
    assert.ok(!/update\s*\(/i.test(src.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')),
        'a backfill UPDATE would invent authorship that was never recorded');
});

test('My Vouchers spans every voucher family, each with a label', () => {
    const { VOUCHER_SOURCES } = require('../Controllers/Tenant/MyEntriesController');
    assert.ok(Array.isArray(VOUCHER_SOURCES) && VOUCHER_SOURCES.length >= 8);
    for (const s of VOUCHER_SOURCES) {
        assert.ok(s.table && s.label && s.dateColumn && s.noColumn,
            `incomplete source: ${JSON.stringify(s)}`);
    }
    const tables = VOUCHER_SOURCES.map((s) => s.table);
    assert.ok(tables.includes('invoices'));
    assert.ok(tables.includes('quotations'));
    assert.ok(tables.includes('sales_orders'));
    assert.strictEqual(new Set(tables).size, tables.length, 'a table is listed twice');
});
