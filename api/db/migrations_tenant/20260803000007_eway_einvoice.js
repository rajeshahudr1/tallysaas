'use strict';

/**
 * Tenant migration 007 — e-Way Bill + e-Invoice (IRN) details, and dispatch info.
 *
 * Tally stores these on the voucher and we never asked for them, so an
 * "e-Way Bills" or "e-Invoices" screen had nothing to read: the cloud could show
 * that an invoice existed but not its IRN, its acknowledgement, its EWB number,
 * validity, transporter or vehicle. That is also the data a GST audit asks for
 * first, so its absence is worse than cosmetic.
 *
 * Two tables rather than columns on tally_vouchers: a single invoice can carry
 * SEVERAL e-Way Bills (extensions, multi-vehicle movement, a re-generated bill
 * after a vehicle change), so a flat column set would keep only the last one.
 * The IRN side is one-per-voucher, but is kept alongside for symmetry and so a
 * cancelled-and-regenerated IRN can be recorded without losing the first.
 */

exports.up = async function up(knex) {
    if (!(await knex.schema.hasTable('tally_vouchers'))) return;

    // Dispatch details live ON the voucher — one set per voucher.
    for (const [col, build] of [
        ['dispatch_doc_no',  (t) => t.string('dispatch_doc_no', 120).nullable()],
        ['dispatch_through', (t) => t.string('dispatch_through', 255).nullable()],
        ['destination',      (t) => t.string('destination', 255).nullable()],
        ['carrier_name',     (t) => t.string('carrier_name', 255).nullable()],
        ['bill_of_lading',   (t) => t.string('bill_of_lading', 120).nullable()],
        ['vehicle_number',   (t) => t.string('vehicle_number', 60).nullable()],
        ['order_reference',  (t) => t.string('order_reference', 120).nullable()],
    ]) {
        if (!(await knex.schema.hasColumn('tally_vouchers', col))) {
            await knex.schema.alterTable('tally_vouchers', build);
        }
    }

    if (!(await knex.schema.hasTable('tally_eway_bills'))) {
        await knex.schema.createTable('tally_eway_bills', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable();
            t.string('voucher_guid', 120).notNullable();
            t.integer('line_no').notNullable().defaultTo(0);
            t.string('ewb_number', 40).nullable();
            t.date('ewb_date').nullable();
            t.date('valid_until').nullable();
            t.string('status', 40).nullable();
            t.string('transporter_name', 255).nullable();
            t.string('transporter_id', 60).nullable();
            t.string('vehicle_number', 60).nullable();
            t.string('vehicle_type', 40).nullable();
            t.string('transport_mode', 40).nullable();
            t.string('doc_number', 120).nullable();
            t.date('doc_date').nullable();
            t.decimal('distance_km', 10, 2).nullable();
            t.string('from_place', 255).nullable();
            t.string('from_state', 100).nullable();
            t.string('to_place', 255).nullable();
            t.string('to_state', 100).nullable();
            t.jsonb('extra').notNullable().defaultTo('{}');
            t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
            t.unique(['company_id', 'voucher_guid', 'line_no'], { indexName: 'tally_eway_line_uq' });
            t.index(['company_id', 'ewb_number'], 'tally_eway_number_idx');
            t.foreign(['company_id', 'voucher_guid'], 'tally_eway_voucher_fk')
                .references(['company_id', 'guid']).inTable('tally_vouchers').onDelete('CASCADE');
        });
    }

    if (!(await knex.schema.hasTable('tally_einvoice_details'))) {
        await knex.schema.createTable('tally_einvoice_details', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable();
            t.string('voucher_guid', 120).notNullable();
            t.integer('line_no').notNullable().defaultTo(0);
            // The IRN is the government's unique id for the invoice — the single
            // most important field here, and the one a GST audit asks for.
            t.string('irn', 128).nullable();
            t.string('ack_number', 60).nullable();
            t.date('ack_date').nullable();
            t.text('signed_qr_code').nullable();
            t.string('status', 40).nullable();
            t.date('cancelled_date').nullable();
            t.string('cancel_reason', 255).nullable();
            t.jsonb('extra').notNullable().defaultTo('{}');
            t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
            t.unique(['company_id', 'voucher_guid', 'line_no'], { indexName: 'tally_einv_line_uq' });
            t.index(['company_id', 'irn'], 'tally_einv_irn_idx');
            t.foreign(['company_id', 'voucher_guid'], 'tally_einv_voucher_fk')
                .references(['company_id', 'guid']).inTable('tally_vouchers').onDelete('CASCADE');
        });
    }
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('tally_eway_bills');
    await knex.schema.dropTableIfExists('tally_einvoice_details');
    await knex.schema.alterTable('tally_vouchers', (t) => {
        t.dropColumn('dispatch_doc_no'); t.dropColumn('dispatch_through');
        t.dropColumn('destination'); t.dropColumn('carrier_name');
        t.dropColumn('bill_of_lading'); t.dropColumn('vehicle_number');
        t.dropColumn('order_reference');
    }).catch(() => {});
};
