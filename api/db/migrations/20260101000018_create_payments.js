'use strict';

/**
 * 20260101000018_create_payments.js
 *
 * payments — payment and receipt vouchers (Tally payment/receipt vouchers).
 *
 * `type` is 'payment' (money out, usually to a supplier) or 'receipt' (money
 * in, usually from a customer). `party_type` ('customer' | 'supplier') selects
 * which of customer_id / supplier_id is populated. `voucher_no` is unique PER
 * company PER type. `mode` captures cash/cheque/UPI/NEFT etc. `amount` is
 * numeric(16,2). `status` walks the same Tally sync lifecycle as invoices.
 * Tenant-scoped with soft-delete.
 *
 * Ordered after customers, suppliers and users.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('payments', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.text('type').notNullable();                           // 'payment' | 'receipt'
        t.string('voucher_no', 60).notNullable();
        t.text('party_type');                                   // 'customer' | 'supplier'

        t.bigInteger('customer_id')
            .nullable()
            .references('id').inTable('customers')
            .onDelete('SET NULL');

        t.bigInteger('supplier_id')
            .nullable()
            .references('id').inTable('suppliers')
            .onDelete('SET NULL');

        t.date('payment_date');
        t.text('mode');                                         // Cash | Cheque | UPI | NEFT ...
        t.string('reference', 100);
        t.string('bank_account', 100);
        t.decimal('amount', 16, 2).notNullable().defaultTo(0);

        // pending_tally | sent_to_tally | created | failed
        t.text('status').notNullable().defaultTo('pending_tally');
        t.string('tally_voucher_no', 60);
        t.text('notes');

        t.bigInteger('created_by')
            .nullable()
            .references('id').inTable('users')
            .onDelete('SET NULL');

        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.unique(['company_id', 'type', 'voucher_no'], 'uq_payments_company_type_no');
        t.index(['company_id', 'type'], 'idx_payments_company_type');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('payments');
};
