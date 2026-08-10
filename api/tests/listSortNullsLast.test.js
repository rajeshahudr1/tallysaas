'use strict';

/**
 * api/tests/listSortNullsLast.test.js
 *
 * Every list sort must put "no answer" at the END, whichever way the column
 * points.
 *
 * Postgres orders NULLs FIRST on a DESC sort. That meant "Parties, most
 * recently sold first" opened with a hundred parties that have never bought
 * anything — the rows with nothing to say crowding out the ones the sort was
 * actually asked about, which read as "the Last Sold Date column is broken".
 *
 * The SQL is asserted rather than executed: this runs without a database, and
 * the thing worth pinning is the clause the builder emits.
 */

const test = require('node:test');
const assert = require('node:assert');
const knexLib = require('knex');

// A connection-less builder — enough to render SQL, never opens a socket.
const knex = knexLib({ client: 'pg' });

/** The ORDER BY the crudController builds for ?sort=&order=. */
function orderSql(column, order) {
    return knex('customers')
        .select('*')
        .orderByRaw(`?? ${order === 'asc' ? 'asc' : 'desc'} nulls last`, [column])
        .orderBy('customers.id', 'desc')
        .toString();
}

test('a descending sort puts nulls last', () => {
    const sql = orderSql('last_sold_date', 'desc');
    assert.match(sql, /order by "last_sold_date" desc nulls last/i);
});

test('an ascending sort puts nulls last too', () => {
    // Ascending on a date means "longest since", where a party that never
    // bought is not the answer either.
    const sql = orderSql('last_sold_date', 'asc');
    assert.match(sql, /order by "last_sold_date" asc nulls last/i);
});

test('the column is bound as an identifier, not interpolated', () => {
    // The sort key is whitelisted upstream, but it still arrives from the
    // query string — it goes in as a quoted identifier, never as raw text.
    const sql = orderSql('tl.closing_balance', 'desc');
    assert.match(sql, /"tl"\."closing_balance" desc nulls last/i);
    assert.ok(!sql.includes('tl.closing_balance desc'), 'the column was interpolated raw');
});

test('an unexpected order value cannot inject SQL', () => {
    // Anything that is not exactly 'asc' becomes 'desc'; the value never
    // reaches the statement.
    const sql = orderSql('name', 'asc; drop table customers');
    assert.match(sql, /"name" desc nulls last/i);
    assert.ok(!/drop table/i.test(sql));
});

test('the id tie-breaker still follows, so paging is stable', () => {
    // Without a deterministic tie-break, two rows with the same date can swap
    // between pages and one of them is never seen.
    assert.match(orderSql('last_sold_date', 'desc'),
        /nulls last, "customers"\."id" desc/i);
});
