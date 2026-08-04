'use strict';

/**
 * हर sidebar menu item को उसका अपना permission module देता है — MASTER half।
 *
 * `permissions` और `license_permissions` सिर्फ master db में हैं (roles /
 * role_permissions tenant-only हैं, हर tenant db में अलग — इसलिए system
 * roles को grant करने वाला हिस्सा db/migrations_tenant/
 * 20260804130001_menu_module_permissions_roles.js में move कर दिया गया है,
 * जो हर tenant db पर चलता है)।
 *
 * • नए <module>.<action> rows permissions में डालता है (idempotent)।
 * • जिन licenses के पास EXPLICIT license_permissions rows हैं उन्हें भी नए
 *   modules दे देता है — वरना उनका मौजूदा "restricted" सेट टूट जाएगा।
 *   जिन licenses के पास कोई row नहीं (implicit all-access) उन्हें छूते नहीं।
 */

const NEW_MODULES = [
    'journals', 'cash-bank', 'receivables', 'payables', 'accountant', 'roles',
    'quotations', 'sales-orders', 'purchase-orders', 'delivery-notes', 'receipt-notes',
    'credit-notes', 'debit-notes', 'contra', 'stock-journal', 'physical-stock',
    'collect-payments', 'gst-search', 'data-backup',
];
const ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];

exports.up = async function up(knex) {
    // 1) permissions rows (slug मौजूद हो तो skip)
    const ids = [];
    for (const mod of NEW_MODULES) {
        for (const action of ACTIONS) {
            const slug = `${mod}.${action}`;
            let row = await knex('permissions').where('slug', slug).first('id');
            if (!row) {
                [row] = await knex('permissions').insert({ module: mod, action, slug }).returning('id');
            }
            ids.push(row.id);
        }
    }

    // 2) explicitly-restricted licenses → वही नए permissions भी
    const licRows = await knex('license_permissions').distinct('license_id');
    for (const l of licRows) {
        for (const pid of ids) {
            await knex('license_permissions')
                .insert({ license_id: l.license_id, permission_id: pid })
                .onConflict(['license_id', 'permission_id']).ignore();
        }
    }
};

exports.down = async function down(knex) {
    const slugs = [];
    for (const mod of NEW_MODULES) for (const a of ACTIONS) slugs.push(`${mod}.${a}`);
    const rows = await knex('permissions').whereIn('slug', slugs).select('id');
    const ids = rows.map((r) => r.id);
    if (!ids.length) return;
    await knex('license_permissions').whereIn('permission_id', ids).del();
    await knex('permissions').whereIn('id', ids).del();
};

exports.NEW_MODULES = NEW_MODULES;
exports.ACTIONS = ACTIONS;
