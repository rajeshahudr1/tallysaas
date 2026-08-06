'use strict';

/**
 * Tenant migration 003 — full voucher mirror + normalized child collections.
 *
 * Until now a Tally voucher was stored as ledger lines (tally_voucher_entries)
 * and item lines (tally_inventory_entries) and nothing else. The header itself
 * had no home, and every nested allocation Tally sends was discarded:
 *
 *   • BILLALLOCATIONS  — WHICH bill a receipt settles. Without it, outstanding
 *     and ageing are guesswork: you know a party owes 50,000, not which of six
 *     invoices is 90 days late. This is the single most valuable gap.
 *   • BATCHALLOCATIONS — batch/godown/expiry per item line.
 *   • COSTCENTREALLOCATIONS — cost-centre reporting is impossible without it.
 *   • BANKALLOCATIONS  — cheque no/date/status, i.e. bank reconciliation.
 *   • GST rate details — the CGST/SGST/IGST/cess split per line, needed for
 *     any GST return.
 *
 * Also: vouchers that classify as none of invoice/payment/journal (delivery
 * note, stock journal, orders, payroll …) were counted "unclassified" and
 * dropped. tally_vouchers keeps EVERY voucher regardless of type, so the mirror
 * is complete and the cloud can grow report coverage without re-pulling Tally.
 *
 * Shape convention for every child table: (company_id, voucher_guid, line_no)
 * with a FK to tally_vouchers and ON DELETE CASCADE, so re-importing a voucher
 * is a single delete of the parent. `extra jsonb` on each row is an overflow
 * bucket — a tag we have not mapped yet is stored rather than lost.
 */

// Child tables: [name, builder]. All share the parent key + cascade.
function childTable(knex, name, extend) {
    return knex.schema.createTable(name, (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable();
        t.string('voucher_guid', 120).notNullable();
        t.integer('line_no').notNullable().defaultTo(0);
        extend(t);
        t.jsonb('extra').notNullable().defaultTo('{}');
        t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());

        t.unique(['company_id', 'voucher_guid', 'line_no'], { indexName: `${name}_line_uq` });
        t.index(['company_id'], `${name}_company_idx`);
        t.foreign(['company_id', 'voucher_guid'], `${name}_voucher_fk`)
            .references(['company_id', 'guid']).inTable('tally_vouchers').onDelete('CASCADE');
    });
}

exports.up = async function up(knex) {
    // ── Voucher HEADER ───────────────────────────────────────
    if (!(await knex.schema.hasTable('tally_vouchers'))) {
        await knex.schema.createTable('tally_vouchers', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable();
            t.string('guid', 120).notNullable();
            t.bigInteger('tally_master_id').nullable();
            t.bigInteger('tally_alter_id').defaultTo(0);
            t.string('voucher_key', 120).nullable();

            t.date('voucher_date').nullable();
            t.date('effective_date').nullable();
            t.string('voucher_type', 100).nullable();
            t.string('voucher_type_parent', 100).nullable();
            t.string('voucher_no', 100).nullable();
            t.string('reference', 120).nullable();
            t.date('reference_date').nullable();

            t.string('party_ledger', 255).nullable();
            t.string('party_gstin', 30).nullable();
            t.string('place_of_supply', 100).nullable();
            t.string('state', 100).nullable();
            t.string('country', 100).nullable();
            t.text('narration').nullable();
            t.decimal('amount', 18, 2).defaultTo(0);

            t.boolean('is_invoice').defaultTo(false);
            t.boolean('is_optional').defaultTo(false);
            t.boolean('is_cancelled').defaultTo(false);
            t.boolean('is_post_dated').defaultTo(false);
            t.boolean('has_cashflow').defaultTo(false);
            t.string('entered_by', 120).nullable();

            t.jsonb('extra').notNullable().defaultTo('{}');
            t.timestamp('deleted_at', { useTz: true }).nullable();
            t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
            t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

            // The child FKs reference (company_id, guid), so it must be UNIQUE —
            // and it is the natural key anyway: a Tally GUID is unique per company.
            t.unique(['company_id', 'guid'], { indexName: 'tally_vouchers_guid_uq' });
            t.index(['company_id', 'voucher_date'], 'tally_vouchers_company_date_idx');
            t.index(['company_id', 'voucher_type'], 'tally_vouchers_company_type_idx');
            t.index(['company_id', 'party_ledger'], 'tally_vouchers_company_party_idx');
            t.foreign('company_id').references('id').inTable('companies').onDelete('CASCADE');
        });
    }

    // ── BILL ALLOCATIONS — bill-wise outstanding / ageing ────
    if (!(await knex.schema.hasTable('tally_bill_allocations'))) {
        await childTable(knex, 'tally_bill_allocations', (t) => {
            t.string('ledger_name', 255).notNullable();
            t.string('bill_name', 255).nullable();          // the bill REFERENCE
            // New Ref / Agst Ref / Advance / On Account — this is what turns a
            // receipt into "settles invoice X" rather than a lump credit.
            t.string('bill_type', 40).nullable();
            t.decimal('amount', 18, 2).defaultTo(0);
            t.integer('credit_period_days').nullable();
            t.date('due_date').nullable();
            t.date('bill_date').nullable();
        });
        await knex.schema.alterTable('tally_bill_allocations', (t) => {
            t.index(['company_id', 'ledger_name', 'bill_name'], 'tally_bill_alloc_party_bill_idx');
        });
    }

    // ── BATCH ALLOCATIONS — batch / godown / expiry per item line ──
    if (!(await knex.schema.hasTable('tally_batch_allocations'))) {
        await childTable(knex, 'tally_batch_allocations', (t) => {
            t.string('item_name', 255).notNullable();
            t.string('batch_name', 255).nullable();
            t.string('godown', 255).nullable();
            t.string('destination_godown', 255).nullable();
            t.decimal('actual_qty', 18, 3).defaultTo(0);
            t.decimal('billed_qty', 18, 3).defaultTo(0);
            t.decimal('amount', 18, 2).defaultTo(0);
            t.date('manufactured_on').nullable();
            t.date('expires_on').nullable();
            t.string('tracking_no', 120).nullable();
            t.string('order_no', 120).nullable();
        });
        await knex.schema.alterTable('tally_batch_allocations', (t) => {
            t.index(['company_id', 'item_name'], 'tally_batch_alloc_item_idx');
        });
    }

    // ── COST CENTRE ALLOCATIONS ──────────────────────────────
    if (!(await knex.schema.hasTable('tally_cost_allocations'))) {
        await childTable(knex, 'tally_cost_allocations', (t) => {
            t.string('ledger_name', 255).nullable();
            t.string('cost_category', 255).nullable();
            t.string('cost_centre', 255).notNullable();
            t.decimal('amount', 18, 2).defaultTo(0);
        });
        await knex.schema.alterTable('tally_cost_allocations', (t) => {
            t.index(['company_id', 'cost_centre'], 'tally_cost_alloc_centre_idx');
        });
    }

    // ── BANK ALLOCATIONS — cheque details / bank reconciliation ──
    if (!(await knex.schema.hasTable('tally_bank_allocations'))) {
        await childTable(knex, 'tally_bank_allocations', (t) => {
            t.string('ledger_name', 255).nullable();
            t.string('instrument_no', 120).nullable();
            t.date('instrument_date').nullable();
            t.string('transaction_type', 60).nullable();
            t.string('bank_name', 255).nullable();
            t.string('payment_favouring', 255).nullable();
            t.string('unique_reference', 120).nullable();
            t.string('status', 60).nullable();
            t.date('bank_date').nullable();
        });
    }

    // ── GST rate details per line ────────────────────────────
    if (!(await knex.schema.hasTable('tally_voucher_gst_details'))) {
        await childTable(knex, 'tally_voucher_gst_details', (t) => {
            t.string('item_name', 255).nullable();
            t.string('ledger_name', 255).nullable();
            t.string('hsn_code', 30).nullable();
            t.decimal('taxable_value', 18, 2).defaultTo(0);
            t.decimal('rate', 8, 3).defaultTo(0);
            t.decimal('cgst', 18, 2).defaultTo(0);
            t.decimal('sgst', 18, 2).defaultTo(0);
            t.decimal('igst', 18, 2).defaultTo(0);
            t.decimal('cess', 18, 2).defaultTo(0);
        });
    }

    // ── Generic UDF bucket — anything Tally exposes that we have not
    //    modelled, kept rather than dropped. ──
    if (!(await knex.schema.hasTable('tally_voucher_udf'))) {
        await childTable(knex, 'tally_voucher_udf', (t) => {
            t.string('udf_name', 255).notNullable();
            t.string('udf_type', 60).nullable();
            t.text('value').nullable();
        });
    }
};

exports.down = async function down(knex) {
    // Children first — they FK to tally_vouchers.
    for (const t of ['tally_voucher_udf', 'tally_voucher_gst_details', 'tally_bank_allocations',
                     'tally_cost_allocations', 'tally_batch_allocations', 'tally_bill_allocations']) {
        await knex.schema.dropTableIfExists(t);
    }
    await knex.schema.dropTableIfExists('tally_vouchers');
};
