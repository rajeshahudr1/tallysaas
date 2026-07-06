'use strict';

/**
 * 20260101000067_create_gps_tracking.js
 *
 * SFA — configurable GPS tracking (on top of Phase-2 check-in/attendance).
 * Super-admin enables/disables per license + tunes WHEN and HOW OFTEN a
 * salesman's location is captured; the app pings location from four sources:
 *   • hourly     — a background foreground-service ping every N minutes
 *   • part_visit — the salesman picks an assigned beat/area to visit
 *   • create     — opening the product/invoice create+list pages
 *   • checkin    — the existing outlet check-in (field_visits) also drops a ping
 *
 * KEY OPTIMISATION: the app only sends a ping when it MOVED more than
 * gps_settings.min_move_m from the last sent point (server also de-dupes),
 * so the same standing location is never re-sent — fewer API calls.
 *
 * Tables:
 *   • gps_settings   — per-license config (super-admin controlled)
 *   • field_locations— every location ping (the tracking trail)
 *   • part_visits    — a salesman's visit to a picked beat/area (with GPS)
 */

exports.up = async function up(knex) {
    // 1) Per-license GPS config (super-admin controlled).
    await knex.schema.createTable('gps_settings', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('license_id').notNullable()
            .references('id').inTable('licenses').onDelete('CASCADE');

        t.boolean('gps_enabled').notNullable().defaultTo(false);      // master
        t.boolean('track_hourly').notNullable().defaultTo(false);     // periodic background ping
        t.integer('hourly_interval_min').notNullable().defaultTo(60); // minutes between pings
        t.boolean('track_part_visit').notNullable().defaultTo(true);  // capture on part-visit
        t.boolean('track_on_create').notNullable().defaultTo(false);  // capture on product/invoice create+list

        t.string('time_from', 5).notNullable().defaultTo('07:00');    // HH:MM window start
        t.string('time_to', 5).notNullable().defaultTo('20:00');      // HH:MM window end
        t.integer('min_move_m').notNullable().defaultTo(100);         // don't re-send within this many metres

        t.bigInteger('updated_by').nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.timestamps(true, true);
        t.unique('license_id', 'uq_gps_settings_license');
    });

    // 2) Location pings — the tracking trail.
    await knex.schema.createTable('field_locations', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable()
            .references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('sales_person_id').notNullable()
            .references('id').inTable('sales_persons').onDelete('CASCADE');
        t.bigInteger('user_id').nullable()
            .references('id').inTable('users').onDelete('SET NULL');

        t.decimal('lat', 10, 7).notNullable();
        t.decimal('lng', 10, 7).notNullable();
        t.text('source').notNullable();          // hourly | part_visit | create | checkin
        t.bigInteger('part_visit_id').nullable(); // FK added after part_visits exists
        t.decimal('accuracy_m', 8, 2);            // GPS accuracy the device reported
        t.integer('moved_m');                     // metres moved since the last ping (null = first)
        t.timestamp('captured_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

        t.index(['company_id', 'sales_person_id'], 'idx_floc_company_sp');
        t.index('captured_at', 'idx_floc_captured_at');
    });

    // 3) Part visits — a salesman visiting a picked beat/area (with GPS).
    await knex.schema.createTable('part_visits', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable()
            .references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('sales_person_id').notNullable()
            .references('id').inTable('sales_persons').onDelete('CASCADE');
        t.bigInteger('user_id').nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.bigInteger('location_id').nullable()     // the beat/area picked (from sales_person_locations)
            .references('id').inTable('locations').onDelete('SET NULL');

        t.decimal('lat', 10, 7);
        t.decimal('lng', 10, 7);
        t.text('note');
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

        t.index(['company_id', 'sales_person_id'], 'idx_partvisit_company_sp');
    });

    // Link field_locations.part_visit_id → part_visits now that it exists.
    await knex.schema.alterTable('field_locations', (t) => {
        t.foreign('part_visit_id').references('id').inTable('part_visits').onDelete('SET NULL');
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('field_locations', (t) => {
        t.dropForeign('part_visit_id');
    });
    await knex.schema.dropTableIfExists('part_visits');
    await knex.schema.dropTableIfExists('field_locations');
    await knex.schema.dropTableIfExists('gps_settings');
};
