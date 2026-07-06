'use strict';

/**
 * 20260101000042_create_notification_reads.js
 *
 * notification_reads — PER-USER read state for the header notification bell.
 *
 * The bell feed is DERIVED (there is no stored notifications table): items are
 * either a tally_sync_logs row (a failed sync in the last 24h) or a synthetic
 * "agent-update-<version>" entry. A single "last read" timestamp can NOT express
 * "the user read THIS one item but not that one", so read state is tracked
 * per-item: one row per (user, notification_key) the user has read.
 *
 *   • user_id          — the reader (req.user.sub). Read state is PER USER, so
 *                        two users on the same company have independent bells.
 *   • notification_key — the bell item's stable id AS TEXT: the
 *                        tally_sync_logs.id stringified, OR "agent-update-<ver>".
 *                        191 chars = the standard utf8mb4-safe string width used
 *                        elsewhere (users.email), comfortably fits both forms.
 *   • read_at          — when it was marked read (now() default).
 *
 * unique(user_id, notification_key) makes the mark-read INSERT idempotent
 * (ON CONFLICT DO NOTHING): clicking the same notification twice never
 * double-counts. index(user_id) keeps "load this user's read keys" fast.
 *
 * Ordered last; references only users (CASCADE so a deleted user's read state
 * goes with them).
 */

exports.up = async function (knex) {
    await knex.schema.createTable('notification_reads', (t) => {
        t.bigIncrements('id').primary();

        t.bigInteger('user_id')
            .notNullable()
            .references('id').inTable('users')
            .onDelete('CASCADE');

        // The bell item id as text (numeric log id OR "agent-update-<version>").
        t.string('notification_key', 191).notNullable();

        t.timestamp('read_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

        // One read row per user+item → idempotent mark-read (ON CONFLICT DO NOTHING).
        t.unique(['user_id', 'notification_key'], 'uq_notif_read_user_key');
        t.index('user_id', 'idx_notification_reads_user_id');
    });
};

exports.down = function (knex) {
    return knex.schema.dropTableIfExists('notification_reads');
};
