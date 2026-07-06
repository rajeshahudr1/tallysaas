'use strict';

/**
 * 20260101000060_create_bank_transactions.js
 *
 * Bank Reconciliation — imported bank-statement lines that get auto-/manually
 * matched to payment (money out) / receipt (money in) vouchers.
 *
 *   bank_transactions — one statement line. `amount` is SIGNED: + = credit
 *     (money IN → matches a receipt), − = debit (money OUT → matches a payment).
 *     `status` walks unmatched → matched | ignored. `batch` groups one import.
 *
 * Also seeds a first-class 'bank-reconciliation' RBAC module (same approach as
 * the expenses / recurring migrations).
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('bank_transactions', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable()
            .references('id').inTable('companies').onDelete('CASCADE');

        t.date('txn_date');
        t.text('description');
        t.string('reference', 191);
        t.decimal('amount', 16, 2).notNullable().defaultTo(0);   // signed: + credit / − debit
        t.text('direction');                                     // 'credit' | 'debit'

        t.text('status').notNullable().defaultTo('unmatched');   // unmatched | matched | ignored
        t.text('matched_type');                                  // 'payment' | 'receipt'
        t.bigInteger('matched_id');                              // the payments.id it matched
        t.timestamp('matched_at', { useTz: true });

        t.string('batch', 60);                                   // import batch id
        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.index(['company_id', 'status'], 'idx_bank_txn_company_status');
        t.index(['company_id', 'txn_date'], 'idx_bank_txn_company_date');
    });

    // ── First-class 'bank-reconciliation' RBAC module ──────────────────────────
    const ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];
    const permIds = [];
    for (const action of ACTIONS) {
        const slug = `bank-reconciliation.${action}`;
        let row = await knex('permissions').where('slug', slug).first('id');
        if (!row) {
            const [ins] = await knex('permissions').insert({ module: 'bank-reconciliation', action, slug }).returning('id');
            row = ins;
        }
        permIds.push(row.id);
    }
    const adminRoles = await knex('roles').whereNull('company_id').whereIn('slug', ['super-admin', 'company-admin']).select('id');
    for (const r of adminRoles) {
        for (const pid of permIds) {
            await knex('role_permissions').insert({ role_id: r.id, permission_id: pid }).onConflict(['role_id', 'permission_id']).ignore();
        }
    }
    const explicitLics = await knex('license_permissions').distinct('license_id').pluck('license_id');
    for (const lid of explicitLics) {
        for (const pid of permIds) {
            const exists = await knex('license_permissions').where({ license_id: lid, permission_id: pid }).first('license_id');
            if (!exists) await knex('license_permissions').insert({ license_id: lid, permission_id: pid });
        }
    }
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('bank_transactions');
};
