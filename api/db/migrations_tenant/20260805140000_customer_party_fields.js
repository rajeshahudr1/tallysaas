'use strict';

/**
 * Customer master को Tally के party ledger जितना पूरा करता है।
 *
 * `state` सबसे ज़रूरी है — CGST/SGST बनाम IGST का फ़ैसला इसी से होता है;
 * अब तक वो पता सिर्फ़ billing_address की मुक्त पंक्ति में दबा था।
 * `ledger_group` वो Tally group है जिसके नीचे यह ledger बनेगा (आम तौर पर
 * "Sundry Debtors") — Tally push को इसकी ज़रूरत पड़ती है।
 */

const COLS = ['ledger_group', 'opening_balance_type', 'country', 'state', 'pincode', 'gst_registration_type'];

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable('customers'))) return;
    const missing = [];
    for (const c of COLS) if (!(await knex.schema.hasColumn('customers', c))) missing.push(c);
    if (!missing.length) return;
    await knex.schema.alterTable('customers', (t) => {
        if (missing.includes('ledger_group'))          t.string('ledger_group', 191).nullable();
        if (missing.includes('opening_balance_type'))  t.text('opening_balance_type').notNullable().defaultTo('Cr');
        if (missing.includes('country'))               t.string('country', 64).nullable().defaultTo('India');
        if (missing.includes('state'))                 t.string('state', 100).nullable();
        if (missing.includes('pincode'))                t.string('pincode', 12).nullable();
        if (missing.includes('gst_registration_type'))  t.string('gst_registration_type', 40).nullable();
    });
};

exports.down = async function down(knex) {
    if (!(await knex.schema.hasTable('customers'))) return;
    const present = [];
    for (const c of COLS) if (await knex.schema.hasColumn('customers', c)) present.push(c);
    if (!present.length) return;
    await knex.schema.alterTable('customers', (t) => { t.dropColumns(...present); });
};
