'use strict';

/**
 * 20260101000008_create_sales_persons.js
 *
 * sales_persons — the field/sales staff of a company.
 *
 * A sales person belongs to a company (company_id) and may optionally be
 * linked to a login `user_id` (some sales staff never log in). `employee_code`
 * is the company's internal HR/identifier. Customers and invoices reference a
 * sales_person to drive attribution and commission reporting.
 *
 * Ordered after users (user_id FK). Tenant-scoped → company_id + soft-delete.
 */

exports.up = async function (knex) {
    await knex.schema.createTable('sales_persons', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('company_id')
            .notNullable()
            .references('id').inTable('companies')
            .onDelete('CASCADE');

        t.bigInteger('user_id')
            .nullable()
            .references('id').inTable('users')
            .onDelete('SET NULL');

        t.string('name', 150).notNullable();
        t.string('employee_code', 50);
        t.string('mobile', 30);
        t.string('email', 191);
        t.date('joining_date');
        t.text('status').notNullable().defaultTo('Active');     // Active | Inactive

        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.index('company_id', 'idx_sales_persons_company_id');
        t.index(['company_id', 'status'], 'idx_sales_persons_company_status');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('sales_persons');
};
