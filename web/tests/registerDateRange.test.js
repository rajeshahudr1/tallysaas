'use strict';

/**
 * web/tests/registerDateRange.test.js
 *
 * The grouped register's period bar. The back/forward arrows step by the
 * LENGTH of the range you are on, which is arithmetic that is easy to get off
 * by a day — and an off-by-one here double-counts or skips a day's vouchers
 * every time you page through the year.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');

const VIEW = path.join(__dirname, '..', 'views', 'partials', 'register-daterange.ejs');

function render(locals) {
    return ejs.renderFile(VIEW, Object.assign({
        basePath: '/sales-invoices', dateFrom: '', dateTo: '', keep: {},
    }, locals), { async: false });
}

test('a month-long range steps back a whole month, not a day', async () => {
    const html = await render({ dateFrom: '2026-04-01', dateTo: '2026-04-30' });
    // April has 30 days, so the previous window is 2 – 31 March.
    assert.match(html, /date_from=2026-03-02&amp;date_to=2026-03-31/,
        'previous period did not step by the range length');
    assert.match(html, /date_from=2026-05-01&amp;date_to=2026-05-30/,
        'next period did not step by the range length');
});

test('a single day steps one day', async () => {
    const html = await render({ dateFrom: '2026-08-08', dateTo: '2026-08-08' });
    assert.match(html, /date_from=2026-08-07&amp;date_to=2026-08-07/);
    assert.match(html, /date_from=2026-08-09&amp;date_to=2026-08-09/);
});

test('the arrows are hidden until a full range is set', async () => {
    // A control that cannot do anything is worse than no control.
    const open = await render({ dateFrom: '2026-04-01', dateTo: '' });
    assert.ok(!/Previous period/.test(open), 'stepped an open-ended period');
    const none = await render({});
    assert.ok(!/Previous period/.test(none) && !/Next period/.test(none));
});

test('changing the period keeps the grouping and the Gross/Net basis', async () => {
    // Losing the grouping on a date change is how you end up staring at the
    // Month view wondering where Stock Item went.
    const html = await render({
        dateFrom: '2026-04-01', dateTo: '2026-04-30',
        keep: { by: 'stock_item', mode: 'net' },
    });
    assert.match(html, /<input type="hidden" name="by" value="stock_item">/);
    assert.match(html, /<input type="hidden" name="mode" value="net">/);
    assert.match(html, /by=stock_item&amp;mode=net&amp;date_from=/, 'arrows dropped the grouping');
});

test('an empty keep value is dropped rather than posted blank', async () => {
    // `mode=''` on a Gross register would be a querystring key that means
    // nothing; the Gross/Net toggle reads its absence as Gross.
    const html = await render({
        dateFrom: '2026-04-01', dateTo: '2026-04-30', keep: { by: 'ledger', mode: '' },
    });
    assert.ok(!/name="mode"/.test(html), 'blank mode was posted anyway');
    assert.match(html, /<input type="hidden" name="by" value="ledger">/);
});
