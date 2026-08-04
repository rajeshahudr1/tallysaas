const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');

const SIDEBAR = path.join(__dirname, '..', 'views', 'partials', 'sidebar.ejs');

// Renders the sidebar partial with sane defaults. Any local can be overridden.
// canModule/canDo default to "allow everything" so tests see the full menu
// unless they deliberately restrict it.
function renderSidebar(locals) {
    return ejs.render(require('node:fs').readFileSync(SIDEBAR, 'utf8'), Object.assign({
        activeMenu: '',
        isSuperAdmin: false,
        isCompanyAdmin: true,
        isSalesman: false,
        isCustomerUser: false,
        canModule: function () { return true; },
        canDo: function () { return true; },
    }, locals || {}), { filename: SIDEBAR });
}

module.exports = { renderSidebar };

test('a `soon` item renders as a dead span with a Soon pill, not a link', () => {
    const html = renderSidebar();
    assert.match(html, /<span class="sidebar-link is-disabled"[^>]*aria-disabled="true"/);
    assert.match(html, /<span class="sidebar-soon">Soon<\/span>/);
    // and it must NOT be clickable
    assert.doesNotMatch(html, /<a class="sidebar-link[^"]*"[^>]*>\s*<i[^>]*><\/i>\s*<span class="sidebar-link-text">Quotation</);
});

test('groups appear in the LiveKeeping order', () => {
    const html = renderSidebar();
    const order = [...html.matchAll(/class="sidebar-section-text">([^<]+)</g)].map(m => m[1]);
    assert.deepStrictEqual(order, [
        'Create Vouchers', 'Sales', 'Purchase', 'Cash & Bank', 'Parties',
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
