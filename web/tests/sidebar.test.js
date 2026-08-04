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
