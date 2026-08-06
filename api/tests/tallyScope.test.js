'use strict';

/**
 * Helpers/tallyScope builds QUERIES, not values, so these tests compile each one
 * to SQL with a connectionless knex and assert on the predicates. That is the
 * behaviour worth pinning: the bug this helper exists to prevent is a read path
 * that silently forgets one of the three conditions, and a missing predicate is
 * visible in the SQL long before it is visible in a total.
 */

const test = require('node:test');
const assert = require('node:assert');
const knexFactory = require('knex');

const {
    whereVoucherLive, liveVoucherEntries, liveInventoryEntries, liveVoucherSql,
} = require('../Helpers/tallyScope');

// No connection is made — knex compiles SQL entirely client-side.
const db = knexFactory({ client: 'pg' });
const sql = (qb) => qb.toString().replace(/\s+/g, ' ');

test.after(() => db.destroy());

test('liveVoucherEntries excludes deleted, cancelled and optional vouchers', () => {
    const s = sql(liveVoucherEntries(db, 7).select('e.amount'));
    assert.match(s, /left join "tally_vouchers" as "v"/);
    assert.match(s, /"v"\."deleted_at" is null/);
    assert.match(s, /"v"\."is_cancelled" = false/);
    assert.match(s, /"v"\."is_optional" = false/);
    assert.match(s, /"e"\."company_id" = 7/);
});

test('an entry whose header is not mirrored yet still counts', () => {
    // The importer writes lines before their header, so an inner join would make
    // a mid-sync read under-report — silently, and only sometimes.
    const s = sql(liveVoucherEntries(db, 1).select('e.amount'));
    assert.match(s, /"v"\."guid" is null or/);
});

test('the join is company-scoped as well as guid-scoped', () => {
    // Joining on guid alone would let one tenant's header decide whether another
    // tenant's posting counts.
    const s = sql(liveVoucherEntries(db, 3).select('e.amount'));
    assert.match(s, /"v"\."company_id" = "e"\."company_id"/);
    assert.match(s, /"v"\."guid" = "e"\."voucher_guid"/);
});

test('liveInventoryEntries applies the same rule to the stock side', () => {
    const s = sql(liveInventoryEntries(db, 9).select('e.qty'));
    assert.match(s, /from "tally_inventory_entries" as "e"/);
    assert.match(s, /"v"\."deleted_at" is null/);
    assert.match(s, /"v"\."is_cancelled" = false/);
    assert.match(s, /"v"\."is_optional" = false/);
});

test('caller filters compose with the scope instead of replacing it', () => {
    const s = sql(liveVoucherEntries(db, 2)
        .whereIn('e.ledger_name', ['Cash']).select('e.amount'));
    assert.match(s, /"e"\."ledger_name" in \('Cash'\)/);
    assert.match(s, /"v"\."deleted_at" is null/);
});

test('whereVoucherLive honours a caller-chosen alias', () => {
    const s = sql(whereVoucherLive(
        db('tally_voucher_entries as e').leftJoin('tally_vouchers as hdr', 'hdr.guid', 'e.voucher_guid'),
        'hdr',
    ).select('e.amount'));
    assert.match(s, /"hdr"\."deleted_at" is null/);
    assert.doesNotMatch(s, /"v"\./);
});

test('liveVoucherSql carries all three conditions and correlates on company', () => {
    // The raw-SQL form must not drift from the builder form; both are used on
    // the Trial Balance, which is where a drift would show up as a mismatch.
    const frag = liveVoucherSql().replace(/\s+/g, ' ');
    assert.match(frag, /not exists/);
    assert.match(frag, /v\.deleted_at is not null/);
    assert.match(frag, /v\.is_cancelled = true/);
    assert.match(frag, /v\.is_optional = true/);
    assert.match(frag, /v\.company_id = tally_voucher_entries\.company_id/);
    assert.match(frag, /v\.guid = tally_voucher_entries\.voucher_guid/);
});

test('liveVoucherSql can be pointed at an aliased entries table', () => {
    const frag = liveVoucherSql('e').replace(/\s+/g, ' ');
    assert.match(frag, /v\.company_id = e\.company_id/);
    assert.match(frag, /v\.guid = e\.voucher_guid/);
});
