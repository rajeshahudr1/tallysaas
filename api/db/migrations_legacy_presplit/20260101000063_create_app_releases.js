'use strict';

/**
 * 20260101000063_create_app_releases.js
 *
 * Mobile-app auto-update (mirrors the agent auto-update in agent_releases).
 *
 *   app_releases — catalogue of published TallySaaS mobile APKs. A super-admin
 *   uploads a freshly-built app-release.apk (or drops it in APP_RELEASE_DIR,
 *   default api/app-releases/) and PUBLISHES its version; the single row with
 *   is_current=true is the latest the app auto-updates to — no code redeploy.
 *     version       — human semantic string shown in the update prompt ("1.0.1").
 *     version_code   — the APK's integer build number (pubspec "+N"); the app
 *                     compares its OWN buildNumber to this to decide "newer"
 *                     (reliable numeric compare, unlike string versions).
 *     filename       — basename of the apk inside APP_RELEASE_DIR (basename-guarded).
 *     sha256         — optional hex digest the app can verify the download against.
 *     notes          — optional "what's new" shown in the update dialog.
 *     mandatory      — a forced release the user cannot skip (else "Later" allowed).
 *     is_current     — exactly one row true = the published latest.
 *
 *   system_settings — a GLOBAL (non-tenant) key/value store for super-admin
 *   switches. Seeds `app_auto_update` = true: the single master on/off the app's
 *   /app/version check honours (OFF → the app never prompts to update).
 *
 * Additive only; existing rows/behaviour unaffected.
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('app_releases', (t) => {
        t.increments('id').primary();
        t.string('version').notNullable();                        // "1.0.1"
        t.integer('version_code').notNullable().defaultTo(0);     // APK build number (pubspec +N)
        t.string('filename').notNullable();                       // basename of the apk in APP_RELEASE_DIR
        t.string('sha256').nullable();
        t.text('notes').nullable();
        t.boolean('mandatory').notNullable().defaultTo(false);
        t.boolean('is_current').notNullable().defaultTo(false);   // exactly one true = published latest
        t.bigInteger('size_bytes').nullable();
        t.integer('created_by').nullable();                       // super-admin user id (no FK)
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.index(['is_current']);
    });

    // Global super-admin key/value store (NOT company-scoped).
    const hasSystemSettings = await knex.schema.hasTable('system_settings');
    if (!hasSystemSettings) {
        await knex.schema.createTable('system_settings', (t) => {
            t.increments('id').primary();
            t.string('key', 120).notNullable().unique();
            t.jsonb('value');
            t.timestamp('updated_at').defaultTo(knex.fn.now());
        });
    }

    // Seed the global app-auto-update master switch (default ON).
    const exists = await knex('system_settings').where('key', 'app_auto_update').first();
    if (!exists) {
        await knex('system_settings').insert({
            key: 'app_auto_update',
            value: JSON.stringify(true),
            updated_at: new Date(),
        });
    }
};

exports.down = async function down(knex) {
    await knex('system_settings').where('key', 'app_auto_update').del().catch(() => {});
    await knex.schema.dropTableIfExists('app_releases');
    // system_settings is a shared store — leave it (only remove our seed above).
};
