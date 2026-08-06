const test = require('node:test');
const assert = require('node:assert');
const { MENU_TREE, MODULE_GROUPS, groupModules } = require('../lib/menuTree');
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

test('MODULE_GROUPS merges the three unlabelled MENU_TREE groups into one General section', () => {
    const generalGroups = MODULE_GROUPS.filter((g) => g.label === 'General');
    assert.strictEqual(generalGroups.length, 1, 'expected exactly one General group, found ' + generalGroups.length);
    // dashboard (1st unlabelled group), collect-payments (2nd), gst-search + data-backup (3rd)
    assert.deepStrictEqual(generalGroups[0].modules, ['dashboard', 'collect-payments', 'gst-search', 'data-backup']);
});

test('groupModules puts API modules under their menu group, unknown ones in Other', () => {
    const api = [
        { key: 'cash-bank', label: 'Cash Bank' },
        { key: 'customers', label: 'Customers' },
        { key: 'mystery-module', label: 'Mystery Module' },
    ];
    const groups = groupModules(api);
    const byLabel = Object.fromEntries(groups.map((g) => [g.label, g.modules.map((m) => m.key)]));
    assert.deepStrictEqual(byLabel['Cash & Bank'], ['cash-bank']);
    assert.deepStrictEqual(byLabel['Customers'], ['customers']);
    assert.deepStrictEqual(byLabel['Other'], ['mystery-module']);
    // कोई module चुपचाप गायब न हो
    const total = groups.reduce((n, g) => n + g.modules.length, 0);
    assert.strictEqual(total, api.length);
});

test('groupModules drops groups that have no modules from the API', () => {
    const groups = groupModules([{ key: 'customers', label: 'Customers' }]);
    assert.deepStrictEqual(groups.map((g) => g.label), ['Customers']);
});

test('the party group is called Customers, not Parties', () => {
    const labels = MENU_TREE.map((g) => g.label).filter(Boolean);
    assert.ok(labels.includes('Customers'), 'Customers group missing');
    assert.ok(!labels.includes('Parties'), 'the old "Parties" label is still there');
});

test('Quotation and My Quotations are live, not "Soon"', () => {
    const byKey = {};
    for (const g of MENU_TREE) for (const it of g.items) byKey[it.key] = it;
    assert.strictEqual(byKey['new-quotation'].soon, undefined, 'Quotation still marked soon');
    assert.strictEqual(byKey['new-quotation'].href, '/quotations/create');
    assert.strictEqual(byKey['my-quotations'].soon, undefined, 'My Quotations still marked soon');
    assert.strictEqual(byKey['my-quotations'].href, '/quotations?mine=1');
});

test('Sales Order is live in both menus, not "Soon"', () => {
    const byKey = {};
    for (const g of MENU_TREE) for (const it of g.items) byKey[it.key] = it;
    assert.strictEqual(byKey['new-sales-order'].soon, undefined, 'Create Vouchers → Sales Order still soon');
    assert.strictEqual(byKey['new-sales-order'].href, '/sales-orders/create');
    assert.strictEqual(byKey['sales-orders'].soon, undefined, 'Sales → Sales Order still soon');
    assert.strictEqual(byKey['sales-orders'].href, '/sales-orders');
});

test('Purchase Order is live in both menus, not "Soon"', () => {
    const byKey = {};
    for (const g of MENU_TREE) for (const it of g.items) byKey[it.key] = it;
    assert.strictEqual(byKey['new-po'].soon, undefined, 'Create Vouchers → Purchase Order still soon');
    assert.strictEqual(byKey['new-po'].href, '/purchase-orders/create');
    assert.strictEqual(byKey['purch-orders'].soon, undefined, 'Purchase → Purchase Order still soon');
    assert.strictEqual(byKey['purch-orders'].href, '/purchase-orders');
});

test('Delivery Note is live in both menus, not "Soon"', () => {
    const byKey = {};
    for (const g of MENU_TREE) for (const it of g.items) byKey[it.key] = it;
    assert.strictEqual(byKey['new-dely-note'].soon, undefined, 'Create Vouchers → Delivery Note still soon');
    assert.strictEqual(byKey['new-dely-note'].href, '/delivery-notes/create');
    assert.strictEqual(byKey['dely-notes'].soon, undefined, 'Sales → Delivery Note still soon');
    assert.strictEqual(byKey['dely-notes'].href, '/delivery-notes');
});

test('Receipt Note is live in both menus, not "Soon"', () => {
    const byKey = {};
    for (const g of MENU_TREE) for (const it of g.items) byKey[it.key] = it;
    assert.strictEqual(byKey['new-recpt-note'].soon, undefined, 'Create Vouchers → Receipt Note still soon');
    assert.strictEqual(byKey['new-recpt-note'].href, '/receipt-notes/create');
    assert.strictEqual(byKey['recpt-notes'].soon, undefined, 'Purchase → Receipt Note still soon');
    assert.strictEqual(byKey['recpt-notes'].href, '/receipt-notes');
});

test('Contra is live in the menu, not "Soon"', () => {
    const byKey = {};
    for (const g of MENU_TREE) for (const it of g.items) byKey[it.key] = it;
    assert.strictEqual(byKey['new-contra'].soon, undefined, 'Create Vouchers → Contra still soon');
    assert.strictEqual(byKey['new-contra'].href, '/contra/create');
});

test('Credit Note and Debit Note are live in both menus, not "Soon"', () => {
    const byKey = {};
    for (const g of MENU_TREE) for (const it of g.items) byKey[it.key] = it;
    assert.strictEqual(byKey['new-credit-note'].soon, undefined);
    assert.strictEqual(byKey['new-credit-note'].href, '/credit-notes/create');
    assert.strictEqual(byKey['credit-notes'].soon, undefined);
    assert.strictEqual(byKey['credit-notes'].href, '/credit-notes');
    assert.strictEqual(byKey['new-debit-note'].soon, undefined);
    assert.strictEqual(byKey['new-debit-note'].href, '/debit-notes/create');
    assert.strictEqual(byKey['debit-notes'].soon, undefined);
    assert.strictEqual(byKey['debit-notes'].href, '/debit-notes');
});

test('Stock Journal and Physical Stock are live, not "Soon"', () => {
    const byKey = {};
    for (const g of MENU_TREE) for (const it of g.items) byKey[it.key] = it;
    assert.strictEqual(byKey['new-stock-jrnl'].soon, undefined);
    assert.strictEqual(byKey['new-stock-jrnl'].href, '/stock-journals/create');
    assert.strictEqual(byKey['new-phys-stock'].soon, undefined);
    assert.strictEqual(byKey['new-phys-stock'].href, '/physical-stock/create');
});
