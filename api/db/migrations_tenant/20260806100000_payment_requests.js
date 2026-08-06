'use strict';

/**
 * `payment_requests` — Collect Payments (UPI-first, no gateway). One row per
 * "please pay this invoice" request the company creates. No account, no
 * keys, no fees: the row just carries the amount + a public token that the
 * public /pay/:token endpoint resolves into a UPI deep link (see
 * Helpers/upiLink.js). We get no confirmation the money actually arrived —
 * `status` only ever moves to 'paid' via a human clicking mark-paid
 * (CollectPaymentController.markPaid), which is also the moment the
 * matching `receipt_id` is stamped. Never inferred from the link being
 * opened or time passing.
 */

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable('payment_requests'))) {
        await knex.schema.createTable('payment_requests', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable().index();
            t.bigInteger('invoice_id').notNullable().index();
            t.bigInteger('customer_id').nullable().index();
            t.decimal('amount', 16, 2).notNullable();
            t.string('token', 64).notNullable();
            t.text('status').notNullable().defaultTo('pending'); // pending | paid | cancelled
            t.timestamp('paid_at', { useTz: true }).nullable();
            t.bigInteger('paid_by').nullable();
            t.bigInteger('receipt_id').nullable();
            t.text('note').nullable();
            t.bigInteger('created_by').nullable();
            t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
            t.timestamp('deleted_at', { useTz: true }).nullable();
            t.unique(['token'], { indexName: 'payment_requests_token_uq' });
        });
    }

    // List/filter index: a company's requests by status (dashboard "pending
    // collections" view).
    await knex.raw(`
        CREATE INDEX IF NOT EXISTS payment_requests_company_status_idx
        ON payment_requests (company_id, status)
    `);
};

exports.down = async function down(knex) {
    const has = await knex.schema.hasTable('payment_requests');
    if (has) {
        await knex.raw(`DROP INDEX IF EXISTS payment_requests_company_status_idx`);
    }
    await knex.schema.dropTableIfExists('payment_requests');
};
