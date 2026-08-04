const test = require('node:test');
const assert = require('node:assert');
const { MENU_TREE, MODULE_GROUPS } = require('../lib/menuTree');
const { MODULES } = require('../../api/db/provision');

test('every menu item carries a module slug', () => {
    for (const g of MENU_TREE) {
        for (const it of g.items) {
            assert.ok(it.module, `item "${it.key}" has no module`);
        }
    }
});

test('the borrowed perms are gone — each screen has its own module', () => {
    const byKey = {};
    for (const g of MENU_TREE) for (const it of g.items) byKey[it.key] = it.module;
    assert.strictEqual(byKey['cash'], 'cash-bank');
    assert.strictEqual(byKey['bank-ledgers'], 'cash-bank');
    assert.strictEqual(byKey['receivables'], 'receivables');
    assert.strictEqual(byKey['payables'], 'payables');
    assert.strictEqual(byKey['journals'], 'journals');
    assert.strictEqual(byKey['accountant'], 'accountant');
    assert.strictEqual(byKey['field-tracking'], 'field-sales');
});

test('every module used in MENU_TREE exists in the permission catalogue', () => {
    const catalogue = new Set(MODULES);
    for (const g of MENU_TREE) {
        for (const it of g.items) {
            assert.ok(catalogue.has(it.module),
                `item "${it.key}" uses module "${it.module}", which is not in api/db/provision.js MODULES`);
        }
    }
});

test('MODULE_GROUPS lists every module exactly once, in menu order', () => {
    const seen = [];
    for (const g of MODULE_GROUPS) {
        assert.ok(g.label, 'a module group must have a label');
        for (const m of g.modules) {
            assert.ok(!seen.includes(m), `module "${m}" appears twice`);
            seen.push(m);
        }
    }
    const inTree = new Set();
    for (const g of MENU_TREE) for (const it of g.items) inTree.add(it.module);
    assert.deepStrictEqual(new Set(seen), inTree);
});
