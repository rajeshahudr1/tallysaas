'use strict';

/**
 * web/tests/partyTabs.test.js
 *
 * The Parties screen's All / Recent Active / Favourite strip. The link
 * building has two rules that pull against each other: a tab must turn the
 * OTHER tabs off, while keeping every filter the user already applied. Get the
 * first wrong and the tabs stack instead of switching; get the second wrong
 * and clicking a tab silently discards their search.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');

const VIEW = path.join(__dirname, '..', 'views', 'partials', 'party-tabs.ejs');

function render(query) {
    return ejs.renderFile(VIEW, { basePath: '/customers', query: query || {} }, { async: false });
}
const hrefs = (html) => (html.match(/href="([^"]*)"/g) || []).map((h) => h.slice(6, -1));

test('the three tabs are offered', async () => {
    const html = await render();
    assert.match(html, />All</);
    assert.match(html, />Recent Active</);
    assert.match(html, />Favourite</);
});

test('All is the tab when neither key is set', async () => {
    const html = await render();
    assert.match(html, /is-active[^>]*aria-selected="true"[^>]*href="\/customers">All</);
});

test('switching tab keeps the search and drops the other tab', async () => {
    const html = await render({ search: 'acme traders', favourite: '1' });
    const links = hrefs(html);
    // Every tab carries the search…
    assert.ok(links.every((h) => h.includes('search=acme%20traders')), links.join(' | '));
    // …and Recent Active does NOT still carry favourite=1, or the two tabs
    // would stack and show only starred-AND-recent parties.
    const active = links.find((h) => h.includes('active='));
    assert.ok(!active.includes('favourite='), active);
    // All clears both.
    const all = links.find((h) => !h.includes('active=') && !h.includes('favourite='));
    assert.equal(all, '/customers?search=acme%20traders');
});

test('changing tab returns to page 1', async () => {
    // Staying on page 7 of All when the Favourite tab has 2 rows shows an
    // empty table that looks like "no favourites".
    const links = hrefs(await render({ page: '7', search: 'x' }));
    assert.ok(links.every((h) => !h.includes('page=')), links.join(' | '));
});

test('the active tab reflects the querystring', async () => {
    assert.match(await render({ favourite: '1' }), /is-active[^>]*>Favourite</);
    assert.match(await render({ active: '90' }), /is-active[^>]*>Recent Active</);
});

test('blank filter values are not posted as empty keys', async () => {
    const links = hrefs(await render({ search: '', location: 'Main' }));
    assert.ok(links.every((h) => !h.includes('search=')), links.join(' | '));
    assert.ok(links.every((h) => h.includes('location=Main')), links.join(' | '));
});
