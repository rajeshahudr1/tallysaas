'use strict';

/**
 * web/tests/settingsScreen.test.js
 *
 * The Configurations screen. Three things here are easy to break silently:
 * the per-voucher-type rows (fifteen families, each with a header box and an
 * Optional Voucher tick), and the two branding uploads — which spent a long
 * time as a disabled box labelled "coming soon".
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');

const VIEW = path.join(__dirname, '..', 'views', 'settings', 'index.ejs');

// Every voucher family the screen must offer a row for — the same fifteen
// LiveKeeping lists.
const FAMILIES = [
    'sales', 'sales_order', 'purchase', 'purchase_order', 'receipt', 'payment',
    'credit_note', 'debit_note', 'journal', 'contra', 'quotation',
    'receipt_note', 'delivery_note', 'stock_journal', 'physical_stock',
];

function render(extra) {
    return ejs.renderFile(VIEW, Object.assign({
        title: 'Settings', activeMenu: 'settings', breadcrumb: [],
        user: { name: 'T', role_slug: 'company-admin' }, flash: null,
        menuTree: [], currentPath: '/', query: {}, csrfToken: 't',
        isSuperAdmin: false,
        companyProfile: { name: 'Teloora Traders' },
        companySettings: {},
        syncFlags: {}, syncModules: [], syncPushModules: [], syncPullModules: [],
        branding: { logo: null, signature: null },
        financialYears: ['2026-27'], gstRates: ['5'], paymentTerms: ['Net 30'],
    }, extra || {}), { async: false });
}

test('every voucher family gets a printed-header box', async () => {
    const html = await render();
    for (const key of FAMILIES) {
        assert.match(html, new RegExp(`name="settings\\[header_${key}\\]"`), `no header box for ${key}`);
    }
});

test('every voucher family gets an Optional Voucher tick', async () => {
    const html = await render();
    for (const key of FAMILIES) {
        assert.match(html, new RegExp(`name="settings\\[optional_${key}\\]"`), `no optional tick for ${key}`);
    }
});

test('an unticked Optional Voucher still posts', async () => {
    // An unticked checkbox sends nothing at all, so the key vanishes from the
    // body and the previous value survives the save — the switch appears not
    // to turn off. The hidden companion is what makes "off" mean off.
    const html = await render();
    for (const key of FAMILIES.slice(0, 3)) {
        assert.match(html,
            new RegExp(`<input type="hidden" name="settings\\[optional_${key}\\]" value="">`),
            `no hidden companion for ${key}`);
    }
});

test('a saved header and tick come back pre-filled', async () => {
    const html = await render({
        companySettings: { header_quotation: 'PROFORMA', optional_journal: 'on' },
    });
    assert.match(html, /name="settings\[header_quotation\]"[^>]*value="PROFORMA"/);
    // The checkbox for journal must be the CHECKED one, not the hidden field.
    assert.match(html, /name="settings\[optional_journal\]" value="on"\s+checked/);
});

test('logo and signature offer a real upload, not a placeholder', async () => {
    const html = await render();
    assert.match(html, /action="\/settings\/branding\/logo"[^>]*enctype="multipart\/form-data"/);
    assert.match(html, /action="\/settings\/branding\/signature"[^>]*enctype="multipart\/form-data"/);
    // Scoped to the branding blocks: "coming soon" elsewhere on this page
    // (notification delivery, the dark theme) is an honest label for something
    // that genuinely is not built.
    for (const kind of ['logo', 'signature']) {
        const at = html.indexOf(`action="/settings/branding/${kind}"`);
        const block = html.slice(Math.max(0, at - 600), at + 600);
        assert.ok(!/coming soon/i.test(block), `the ${kind} upload still says "coming soon"`);
    }
});

test('an existing image is previewed and can be removed', async () => {
    const html = await render({
        branding: { logo: 'http://x/uploads/branding/1/logo.png?v=1', signature: null },
    });
    assert.match(html, /<img src="http:\/\/x\/uploads\/branding\/1\/logo\.png\?v=1"/);
    assert.match(html, /action="\/settings\/branding\/logo\/remove"/);
    // Nothing uploaded yet → nothing to remove.
    assert.ok(!/action="\/settings\/branding\/signature\/remove"/.test(html));
});

test('the branding forms are not nested inside the settings form', async () => {
    // Nested forms are invalid HTML: the browser drops the inner one, and the
    // Upload button would submit the whole settings page instead.
    const html = await render();
    const settingsFormStart = html.indexOf('id="settings-form"');
    const uploadForm = html.indexOf('action="/settings/branding/logo"');
    assert.ok(settingsFormStart > -1 && uploadForm > -1, 'expected both forms on the page');
    const between = html.slice(settingsFormStart, uploadForm);
    assert.ok(between.includes('</form>'), 'the settings form was still open when the upload form started');
});
