'use strict';

/**
 * 20260101000059_create_recurring_invoices.js
 *
 * Recurring Invoices — a template + schedule that auto-generates a sales invoice
 * periodically (rent, subscription, AMC …). v1 is single-line (a description +
 * amount + optional GST); the daily scheduler creates a real `invoices` row when
 * `next_run_date` arrives, then advances the schedule.
 *
 * Also seeds a first-class 'recurring-invoices' RBAC module (same approach as the
 * expenses migration): permissions + admin grants + entitle explicitly-scoped
 * licences.
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('recurring_invoices', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable()
            .references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('customer_id').nullable()
            .references('id').inTable('customers').onDelete('SET NULL');

        t.string('title', 191).notNullable();                 // "Monthly Rent"
        t.text('description');                                 // invoice line description
        t.decimal('amount', 16, 2).notNullable().defaultTo(0);
        t.decimal('gst_rate', 5, 2).notNullable().defaultTo(0);

        t.text('frequency').notNullable().defaultTo('monthly');  // monthly | quarterly | yearly
        t.integer('due_days').notNullable().defaultTo(0);        // due_date = invoice_date + due_days
        t.date('next_run_date').notNullable();
        t.date('start_date');
        t.date('end_date');                                   // nullable = runs forever
        t.text('status').notNullable().defaultTo('Active');   // Active | Paused

        t.bigInteger('last_invoice_id').nullable();
        t.timestamp('last_run_at', { useTz: true });
        t.integer('generated_count').notNullable().defaultTo(0);

        t.bigInteger('created_by').nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.index(['company_id', 'status'], 'idx_recurring_company_status');
        t.index('next_run_date', 'idx_recurring_next_run');
    });

    // ── First-class 'recurring-invoices' RBAC module (mirrors the expenses migration) ──
    const ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];
    const permIds = [];
    for (const action of ACTIONS) {
        const slug = `recurring-invoices.${action}`;
        let row = await knex('permissions').where('slug', slug).first('id');
        if (!row) {
            const [ins] = await knex('permissions').insert({ module: 'recurring-invoices', action, slug }).returning('id');
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
    await knex.schema.dropTableIfExists('recurring_invoices');
};
