'use strict';

/**
 * 20260101000065_create_field_tracking.js
 *
 * SFA Phase 2 — GPS field tracking. Lets a salesman mark attendance (Start/End
 * Day) and CHECK IN at a customer outlet; the app captures GPS, the server
 * compares it to the outlet's saved coordinates and flags whether the visit was
 * WITHIN the geofence (genuine) or too far. Coverage % (visited vs assigned) is
 * derived from these rows.
 *
 * Adds:
 *   • customers.latitude / longitude / geo_radius_m   — the outlet's geo-fence
 *   • locations.latitude / longitude                  — beat centre (fallback)
 *   • field_attendance   — one row per salesman per day (Start/End Day punch)
 *   • field_visits       — one row per check-in (with check-out)
 *
 * Coordinates are numeric(10,7) (≈1cm precision, ±180 range). Distances are
 * stored in METRES. All tenant-scoped (company_id) + soft-delete where it makes
 * sense. Fully additive — nothing existing changes.
 */

exports.up = async function up(knex) {
    // 1) Outlet geo-fence on customers.
    await knex.schema.alterTable('customers', (t) => {
        t.decimal('latitude', 10, 7).nullable();
        t.decimal('longitude', 10, 7).nullable();
        t.integer('geo_radius_m').nullable();   // per-outlet override (else the license default)
    });

    // 2) Beat-centre coords on locations (fallback when a customer has none).
    await knex.schema.alterTable('locations', (t) => {
        t.decimal('latitude', 10, 7).nullable();
        t.decimal('longitude', 10, 7).nullable();
    });

    // 3) Attendance — Start/End Day punch (one per salesman per calendar day).
    await knex.schema.createTable('field_attendance', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable()
            .references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('sales_person_id').notNullable()
            .references('id').inTable('sales_persons').onDelete('CASCADE');
        t.bigInteger('user_id').nullable()
            .references('id').inTable('users').onDelete('SET NULL');

        t.date('day').notNullable();
        t.timestamp('start_at', { useTz: true });
        t.decimal('start_lat', 10, 7);
        t.decimal('start_lng', 10, 7);
        t.timestamp('end_at', { useTz: true });
        t.decimal('end_lat', 10, 7);
        t.decimal('end_lng', 10, 7);
        t.text('status').notNullable().defaultTo('open');   // open | closed
        t.timestamps(true, true);

        t.unique(['sales_person_id', 'day'], 'uq_field_attendance_sp_day');
        t.index(['company_id', 'day'], 'idx_field_attendance_company_day');
    });

    // 4) Visits — one per check-in. checkin_within = GPS was inside the geofence.
    await knex.schema.createTable('field_visits', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable()
            .references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('sales_person_id').notNullable()
            .references('id').inTable('sales_persons').onDelete('CASCADE');
        t.bigInteger('user_id').nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.bigInteger('customer_id').nullable()
            .references('id').inTable('customers').onDelete('SET NULL');
        t.bigInteger('location_id').nullable()
            .references('id').inTable('locations').onDelete('SET NULL');

        t.timestamp('checkin_at', { useTz: true }).notNullable();
        t.decimal('checkin_lat', 10, 7);
        t.decimal('checkin_lng', 10, 7);
        t.integer('checkin_distance_m');            // metres from the saved outlet coords (null = no coords)
        t.boolean('checkin_within').notNullable().defaultTo(false);

        t.timestamp('checkout_at', { useTz: true });
        t.decimal('checkout_lat', 10, 7);
        t.decimal('checkout_lng', 10, 7);

        t.text('note');
        t.text('status').notNullable().defaultTo('open');   // open | closed
        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.index(['company_id', 'sales_person_id'], 'idx_field_visits_company_sp');
        t.index(['company_id', 'customer_id'], 'idx_field_visits_company_customer');
        t.index('checkin_at', 'idx_field_visits_checkin_at');
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('field_visits');
    await knex.schema.dropTableIfExists('field_attendance');
    await knex.schema.alterTable('locations', (t) => {
        t.dropColumn('latitude');
        t.dropColumn('longitude');
    });
    await knex.schema.alterTable('customers', (t) => {
        t.dropColumn('latitude');
        t.dropColumn('longitude');
        t.dropColumn('geo_radius_m');
    });
};
