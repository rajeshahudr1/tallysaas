'use strict';

/**
 * api/tests/stockMovement.test.js
 *
 * "How much is on hand" must have exactly ONE definition.
 *
 * It did not: the Items screen computed opening + received − issued, while the
 * sales-invoice guard compared against products.opening_stock. On live data
 * that disagreed on 1,607 of 5,676 items — 286 where a sale was refused for
 * stock the screen was showing, and 1,321 where the guard let an oversell
 * through. These tests pin the shape of the shared SQL so the two can never
 * drift apart again.
 */

const test = require('node:test');
const assert = require('node:assert');
const { MOVEMENT_SUBQUERY, closingStockSql, AVG_PURCHASE_RATE_SQL } = require('../Helpers/stockMovement');

test('closing stock is opening plus received less issued', () => {
    const sql = closingStockSql('products');
    assert.match(sql, /products\.opening_stock/);
    assert.match(sql, /\+\s*coalesce\(mv\.in_qty, 0\)/);
    assert.match(sql, /-\s*coalesce\(mv\.out_qty, 0\)/);
});

test('closing stock can be aliased for a different table alias', () => {
    // The guard joins products as `p`; an unaliased expression would not
    // compile there, which is what tempted the duplicate definition.
    assert.match(closingStockSql('p'), /^\(p\.opening_stock \+/);
    assert.equal(closingStockSql(), closingStockSql('products'));
});

test('direction comes from the voucher type, not the sign of the quantity', () => {
    // Tally records an inventory quantity as a positive magnitude on BOTH
    // sides, so a `qty < 0` test would classify nothing.
    for (const inbound of ['Purchase', 'Receipt Note', 'Credit Note']) {
        assert.ok(MOVEMENT_SUBQUERY.includes(`'${inbound}'`), `${inbound} not counted as incoming`);
    }
    for (const outbound of ['Sales', 'Delivery Note', 'Debit Note']) {
        assert.ok(MOVEMENT_SUBQUERY.includes(`'${outbound}'`), `${outbound} not counted as outgoing`);
    }
});

test('a credit note comes back IN and a debit note goes back OUT', () => {
    // A sales return restocks; a purchase return de-stocks. Getting these two
    // the wrong way round silently doubles the error on every return.
    // Pull out each `sum(case … end) as <name>` arm by name rather than by a
    // character window, so the assertion does not depend on the formatting.
    const arm = (name) => {
        const m = new RegExp(`sum\\(([\\s\\S]*?)\\)\\s*as ${name}`).exec(MOVEMENT_SUBQUERY);
        assert.ok(m, `no ${name} arm found`);
        return m[1];
    };
    const inArm = arm('in_qty');
    const outArm = arm('out_qty');
    assert.ok(inArm.includes("'Credit Note'"), 'a sales return should restock');
    assert.ok(outArm.includes("'Debit Note'"), 'a purchase return should de-stock');
});

test('company_id is part of the grouping key', () => {
    // A tenant database can hold several companies. Dropping the company from
    // the key would let one company's movement leak into another's stock.
    assert.match(MOVEMENT_SUBQUERY, /group by e\.company_id/);
    assert.match(MOVEMENT_SUBQUERY, /select e\.company_id/);
});

test('deleted vouchers do not move stock', () => {
    assert.match(MOVEMENT_SUBQUERY, /i\.deleted_at is null/);
});

test('the average purchase rate is null, not zero, when nothing was bought', () => {
    // A zero would read as "we get it free" and value the stock at nothing.
    assert.match(AVG_PURCHASE_RATE_SQL, /else null end/);
});
