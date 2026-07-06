'use strict';

/**
 * 20260101000058_create_expense_tables.js
 *
 * Expense Tracking — a lightweight expense book, separate from purchase
 * invoices / payment vouchers.
 *
 *   expense_categories — a flat per-company list of expense heads (Rent,
 *     Salaries, Utilities, Travel …). Tenant-scoped, soft-deletable.
 *   expenses — one recorded business expense: an amount under a category, on a
 *     date, paid to a vendor by some mode, with an optional reference + notes.
 *     Tenant-scoped, soft-deletable, authored by a user.
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('expense_categories', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable()
            .references('id').inTable('companies').onDelete('CASCADE');
        t.string('name', 150).notNullable();
        t.text('status').notNullable().defaultTo('Active');   // Active | Inactive
        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();
        t.index('company_id', 'idx_expense_categories_company');
    });

    await knex.schema.createTable('expenses', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable()
            .references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('category_id').nullable()
            .references('id').inTable('expense_categories').onDelete('SET NULL');

        t.string('vendor', 191);                              // payee / party (free text)
        t.date('expense_date');
        t.decimal('amount', 16, 2).notNullable().defaultTo(0);
        t.text('payment_mode');                               // Cash | Bank | UPI | Card | Cheque
        t.string('reference', 100);                           // bill / voucher no
        t.text('notes');
        t.text('status').notNullable().defaultTo('Active');

        t.bigInteger('created_by').nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.index(['company_id', 'expense_date'], 'idx_expenses_company_date');
        t.index(['company_id', 'category_id'], 'idx_expenses_company_category');
    });

    // ── Make 'expenses' a first-class RBAC module ──────────────────────────────
    // permissions (5 actions) + grant to the built-in admin roles + keep any
    // licence with an EXPLICIT entitlement set entitled to it (licences with no
    // explicit rows already resolve to ALL). Idempotent.
    const ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];
    const permIds = [];
    for (const action of ACTIONS) {
        const slug = `expenses.${action}`;
        let row = await knex('permissions').where('slug', slug).first('id');
        if (!row) {
            const [ins] = await knex('permissions').insert({ module: 'expenses', action, slug }).returning('id');
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
    await knex.schema.dropTableIfExists('expenses');
    await knex.schema.dropTableIfExists('expense_categories');
};
