'use strict';

/**
 * 20260101000057_create_reminder_tables.js
 *
 * Payment-reminder feature (LiveKeeping-style overdue nudges).
 *
 *   reminder_settings — ONE row per licence. The platform Super Admin decides,
 *     PER LICENCE, whether that licence's companies may send Email / WhatsApp
 *     reminders at all, and whether the automatic scheduler runs (and on which
 *     day-offsets past the due date, at what hour). A company gets a channel
 *     ONLY when its licence has it switched on here — the actual SMTP / WhatsApp
 *     credentials live in the API .env, never per-tenant.
 *
 *   payment_reminders — an audit log of every reminder actually sent (manual or
 *     auto). Also used to de-duplicate the auto scheduler (one send per customer
 *     per offset-day).
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('reminder_settings', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('license_id').notNullable().unique()
            .references('id').inTable('licenses').onDelete('CASCADE');

        // Super-admin channel switches (per licence).
        t.boolean('email_enabled').notNullable().defaultTo(false);
        t.boolean('whatsapp_enabled').notNullable().defaultTo(false);

        // Automatic scheduler: run at all? which day-offsets AFTER due_date to
        // nudge on, and the server hour (0-23) the daily job fires.
        t.boolean('auto_enabled').notNullable().defaultTo(false);
        t.jsonb('offsets').notNullable().defaultTo(JSON.stringify([1, 7, 15]));
        t.integer('send_hour').notNullable().defaultTo(10);

        t.timestamps(true, true);
    });

    await knex.schema.createTable('payment_reminders', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable()
            .references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('customer_id').nullable()
            .references('id').inTable('customers').onDelete('SET NULL');

        t.string('channel', 20).notNullable();                 // email | whatsapp
        t.string('to_address', 191);                           // email or phone at send time
        t.decimal('amount', 16, 2).notNullable().defaultTo(0); // outstanding at send time
        t.string('trigger', 20).notNullable().defaultTo('manual'); // manual | auto
        t.integer('offset_day').nullable();                    // which auto offset fired (dedupe)
        t.string('status', 20).notNullable().defaultTo('sent');    // sent | failed
        t.text('error');

        t.bigInteger('sent_by').nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.timestamp('sent_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

        t.index(['company_id', 'customer_id'], 'idx_reminders_company_customer');
        t.index(['company_id', 'customer_id', 'offset_day'], 'idx_reminders_dedupe');
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('payment_reminders');
    await knex.schema.dropTableIfExists('reminder_settings');
};
