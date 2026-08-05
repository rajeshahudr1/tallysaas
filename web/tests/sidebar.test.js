const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');
const { MENU_TREE } = require('../lib/menuTree');

const SIDEBAR = path.join(__dirname, '..', 'views', 'partials', 'sidebar.ejs');

// Renders the sidebar partial with sane defaults. Any local can be overridden.
// canModule/canDo default to "allow everything" so tests see the full menu
// unless they deliberately restrict it. `menuTree` mirrors what web/index.js
// puts on res.locals — a fresh deep copy per render, since the partial's own
// role logic mutates the array.
function renderSidebar(locals) {
    return ejs.render(require('node:fs').readFileSync(SIDEBAR, 'utf8'), Object.assign({
        activeMenu: '',
        isSuperAdmin: false,
        isCompanyAdmin: true,
        isSalesman: false,
        isCustomerUser: false,
        canModule: function () { return true; },
        canDo: function () { return true; },
        menuTree: JSON.parse(JSON.stringify(MENU_TREE)),
    }, locals || {}), { filename: SIDEBAR });
}

module.exports = { renderSidebar };

test('a `soon` item renders as a dead span with a Soon pill, not a link', () => {
    const html = renderSidebar();
    assert.match(html, /<span class="sidebar-link is-disabled"[^>]*aria-disabled="true"/);
    assert.match(html, /<span class="sidebar-soon">Soon<\/span>/);
    // Sales Order is still `soon: true` (Quotation went live in task 3) —
    // and it must NOT be clickable.
    assert.doesNotMatch(html, /<a class="sidebar-link[^"]*"[^>]*>\s*<i[^>]*><\/i>\s*<span class="sidebar-link-text">Sales Order</);
});

test('groups appear in the LiveKeeping order', () => {
    const html = renderSidebar();
    const order = [...html.matchAll(/class="sidebar-section-text">([^<]+)</g)].map(m => m[1]);
    assert.deepStrictEqual(order, [
        'Create Vouchers', 'Sales', 'Purchase', 'Cash &amp; Bank', 'Customers',
        'Items', 'Reports', 'My Entries', 'Field Sales', 'Portals',
        'Tally Sync', 'Configurations',
    ]);
});

test('every LiveKeeping voucher type is present', () => {
    const html = renderSidebar();
    for (const label of ['Quotation', 'Sales Order', 'Contra', 'Purchase Order',
                         'Credit Note', 'Debit Note', 'Stock Journal',
                         'Physical Stock', 'Receipt Note', 'Delivery Note',
                         'Collect Payments', 'GST Search', 'Data Backup']) {
        assert.match(html, new RegExp('sidebar-link-text">' + label + '<'), label + ' missing');
    }
});

test('our own modules keep working links inside their new groups', () => {
    const html = renderSidebar();
    for (const href of ['/sales-invoices', '/receivables', '/payables', '/cash',
                        '/bank', '/bank-reconciliation', '/customers', '/suppliers',
                        '/products', '/inventory', '/reports', '/field-tracking',
                        '/customer-users', '/website-users', '/sync-dashboard',
                        '/roles', '/settings']) {
        assert.match(html, new RegExp('href="' + href + '"'), href + ' missing');
    }
});

test('company admin gets Roles & Permissions inside Configurations', () => {
    const html = renderSidebar({ isCompanyAdmin: true });
    assert.match(html, /href="\/roles"/);
});

test('a plain (non-admin) user never sees Roles', () => {
    const html = renderSidebar({ isCompanyAdmin: false });
    assert.doesNotMatch(html, /href="\/roles"/);
});

test('My Dashboard shows for a salesman only', () => {
    assert.match(renderSidebar({ isSalesman: true, isCompanyAdmin: false }), /href="\/my-field"/);
    assert.doesNotMatch(renderSidebar({ isSalesman: false }), /href="\/my-field"/);
});

test('super admin sees only Platform Admin + Configurations(Users, Settings)', () => {
    const html = renderSidebar({ isSuperAdmin: true, isCompanyAdmin: false });
    const groups = [...html.matchAll(/class="sidebar-section-text">([^<]+)</g)].map(m => m[1]);
    assert.deepStrictEqual(groups, ['Platform Admin', 'Configurations']);
    assert.match(html, /href="\/licenses"/);
    assert.match(html, /href="\/einvoice-gsp"/);
    assert.match(html, /href="\/users"/);
    assert.match(html, /href="\/settings"/);
    assert.doesNotMatch(html, /href="\/customers"/);
    assert.doesNotMatch(html, /href="\/roles"/);
    // no "Soon" placeholders for the platform operator
    assert.doesNotMatch(html, /sidebar-soon/);
});

test('customer-portal user never sees the Tracking Report', () => {
    const html = renderSidebar({ isCustomerUser: true, isCompanyAdmin: false });
    assert.doesNotMatch(html, /href="\/field-tracking"/);
});
