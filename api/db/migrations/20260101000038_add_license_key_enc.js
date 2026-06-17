'use strict';

/**
 * 20260101000038_add_license_key_enc.js
 *
 * Reversible-encrypted storage of the FULL license key so a super-admin can
 * REVEAL it on the license detail page (today only license_key_hash (sha256) +
 * key_prefix are stored, and the clear key is shown once at creation and is
 * otherwise unrecoverable).
 *
 *   license_key_enc — nullable TEXT. Holds AES-256-GCM ciphertext (base64 of
 *                     iv(12) || authTag(16) || ciphertext) of the clear key,
 *                     produced by api/Helpers/keyCrypto.js and only decryptable
 *                     with LICENSE_KEY_SECRET. NEVER replaces license_key_hash
 *                     (the hash stays the activation credential check).
 *
 * Nullable + additive: every EXISTING license keeps working untouched — its
 * license_key_enc is simply NULL (key_available:false in the detail view), and
 * the super-admin can mint a fresh stored key via the Regenerate action.
 */

exports.up = async function up(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        t.text('license_key_enc').nullable();
    });
};

exports.down = async function down(knex) {
    await knex.schema.alterTable('licenses', (t) => {
        t.dropColumn('license_key_enc');
    });
};
