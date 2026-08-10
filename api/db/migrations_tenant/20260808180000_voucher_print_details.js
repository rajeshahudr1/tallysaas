'use strict';

/**
 * Buyer / Consignee / Dispatch / Order details on a voucher.
 *
 * These are the fields a printed voucher needs but the ledger does not: who to
 * bill, who to ship to, how it went out, and which purchase order it answers.
 * Tally carries them per voucher, and our synced `tally_vouchers` mirror
 * already stores its own copy (dispatch_doc_no, vehicle_number, …) — but a
 * voucher CREATED in the cloud had nowhere to put any of it, so the print was
 * missing exactly the details a delivery needs.
 *
 * Stored as ONE jsonb column rather than ~28 columns across six tables:
 *   • they are written and read as a block, by the voucher form and the PDF;
 *   • nothing filters or joins on them, so columns would buy no query power;
 *   • Tally keeps adding optional voucher fields, and a jsonb absorbs the next
 *     one without a migration per table.
 * jsonb (not json) so a value can still be indexed or queried later if a
 * report ever needs to, e.g. `where voucher_details->>'vehicle_number' = …`.
 *
 * Shape (every key optional):
 *   { buyer: {name,address,country,state,registration_type,pincode,gstin,place_of_supply},
 *     consignee: {name,address,country,state,pincode,gstin},
 *     dispatch: {shipping_date,note,doc_no,bill_no,through,vehicle_no,destination},
 *     order: {date,number,mode_of_payment,other_reference,terms_of_delivery} }
 */

const TABLES = [
    'quotations', 'invoices', 'sales_orders', 'purchase_orders',
    'delivery_notes', 'receipt_notes',
];

exports.up = async function up(knex) {
    for (const table of TABLES) {
        if (!(await knex.schema.hasTable(table))) continue;
        if (await knex.schema.hasColumn(table, 'voucher_details')) continue;
        await knex.schema.alterTable(table, (t) => {
            t.jsonb('voucher_details').notNullable().defaultTo('{}');
        });
    }
};

exports.down = async function down(knex) {
    for (const table of TABLES) {
        if (!(await knex.schema.hasTable(table))) continue;
        if (!(await knex.schema.hasColumn(table, 'voucher_details'))) continue;
        await knex.schema.alterTable(table, (t) => {
            t.dropColumn('voucher_details');
        });
    }
};
