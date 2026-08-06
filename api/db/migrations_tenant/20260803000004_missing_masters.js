'use strict';

/**
 * Tenant migration 004 — the masters Tally exposes that we never pulled.
 *
 * The integration fetched five collections (Company, Ledger, Group, StockItem,
 * Godown). Everything else Tally holds was invisible to the cloud:
 *
 *   • Units / Stock Groups / Stock Categories — stock items referenced them by
 *     NAME with nothing behind it (a stock group was flattened into `categories`
 *     and a unit was a bare string on `products`).
 *   • Cost Categories + Cost Centres — voucher cost allocations (migration 003)
 *     had nothing to join to.
 *   • Voucher Types — Tally lets a company define "Cash Sales", "Branch
 *     Transfer" etc. with their own numbering and behaviour; we only ever saw
 *     the name on a voucher.
 *   • Currencies, Price Lists, Budgets, BOM, GST/TDS/TCS classifications and the
 *     payroll masters — absent entirely.
 *   • Ledger bank details + opening bill-wise breakup — nested lists on the
 *     Ledger master that the flat FETCH could never carry.
 *
 * Every table follows the same identity contract as migration 001 so the
 * reconcile pass (delete-sync) works on them unchanged:
 *   (company_id, tally_guid) unique · tally_master_id · tally_alter_id ·
 *   deleted_at · extra jsonb overflow.
 */

/** Create a master table with the standard identity contract. */
async function masterTable(knex, name, extend, { nameCol = true } = {}) {
    if (await knex.schema.hasTable(name)) return;
    await knex.schema.createTable(name, (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable();
        if (nameCol) t.string('name', 255).notNullable();
        t.string('tally_guid', 120).nullable();
        t.bigInteger('tally_master_id').nullable();
        t.bigInteger('tally_alter_id').defaultTo(0);
        extend(t);
        // Overflow bucket: a Tally tag we have not modelled is STORED, not lost,
        // so widening the mapping later never needs a re-pull.
        t.jsonb('extra').notNullable().defaultTo('{}');
        t.timestamp('deleted_at', { useTz: true }).nullable();
        t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
        t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

        t.index(['company_id'], `${name}_company_idx`);
        t.foreign('company_id').references('id').inTable('companies').onDelete('CASCADE');
    });
    if (nameCol) {
        await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${name}_name_uq
                        ON ${name} (company_id, name)`);
    }
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${name}_tally_guid_uq
                    ON ${name} (company_id, tally_guid) WHERE tally_guid IS NOT NULL`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${name}_tally_master_id_uq
                    ON ${name} (company_id, tally_master_id) WHERE tally_master_id IS NOT NULL`);
}

const TABLES = [
    // ── Inventory structure ──────────────────────────────────
    ['tally_units', (t) => {
        t.string('original_name', 255).nullable();
        t.boolean('is_simple').defaultTo(true);
        t.string('base_units', 255).nullable();
        t.string('additional_units', 255).nullable();
        // A compound unit ("Box of 12 Nos") is base + additional + conversion.
        t.decimal('conversion', 18, 6).nullable();
        t.integer('decimal_places').nullable();
    }],
    ['tally_stock_groups', (t) => {
        t.string('parent', 255).nullable();
        t.boolean('is_addable').defaultTo(false);
    }],
    ['tally_stock_categories', (t) => {
        t.string('parent', 255).nullable();
    }],
    // The proper StockItem mirror. `products` stays the CLOUD-side sellable
    // record (pricing, cloud-only items); this is Tally's master verbatim, with
    // the fields `products` has no column for.
    ['tally_stock_items', (t) => {
        t.string('parent', 255).nullable();              // stock group
        t.string('category', 255).nullable();
        t.string('base_units', 255).nullable();
        t.string('additional_units', 255).nullable();
        t.string('hsn_code', 30).nullable();
        t.decimal('gst_rate', 8, 3).defaultTo(0);
        t.string('costing_method', 60).nullable();
        t.string('valuation_method', 60).nullable();
        t.boolean('is_batchwise').defaultTo(false);
        t.boolean('has_mfg_date').defaultTo(false);
        t.boolean('is_perishable').defaultTo(false);
        t.boolean('is_cost_tracking').defaultTo(false);
        t.decimal('reorder_level', 18, 3).nullable();
        t.decimal('minimum_order_qty', 18, 3).nullable();
        t.decimal('opening_qty', 18, 3).defaultTo(0);
        t.decimal('opening_rate', 18, 4).defaultTo(0);
        t.decimal('opening_value', 18, 2).defaultTo(0);
        t.decimal('closing_qty', 18, 3).defaultTo(0);
        t.decimal('closing_rate', 18, 4).defaultTo(0);
        t.decimal('closing_value', 18, 2).defaultTo(0);
        t.decimal('standard_price', 18, 4).defaultTo(0);
        t.decimal('standard_cost', 18, 4).defaultTo(0);
    }],
    ['tally_batches', (t) => {
        t.string('stock_item', 255).nullable();
        t.string('godown', 255).nullable();
        t.date('manufactured_on').nullable();
        t.date('expires_on').nullable();
        t.decimal('opening_qty', 18, 3).defaultTo(0);
    }],

    // ── Costing ──────────────────────────────────────────────
    ['tally_cost_categories', (t) => {
        t.boolean('allocate_revenue').defaultTo(true);
        t.boolean('allocate_non_revenue').defaultTo(false);
    }],
    ['tally_cost_centres', (t) => {
        t.string('parent', 255).nullable();
        t.string('category', 255).nullable();
    }],

    // ── Accounting structure ─────────────────────────────────
    ['tally_currencies', (t) => {
        t.string('symbol', 20).nullable();
        t.string('formal_name', 120).nullable();
        t.string('mailing_name', 255).nullable();
        t.integer('decimal_places').nullable();
        t.boolean('is_suffixed').defaultTo(false);
        t.boolean('has_space').defaultTo(false);
        t.string('decimal_symbol', 40).nullable();
    }],
    ['tally_voucher_types', (t) => {
        t.string('parent', 255).nullable();              // the RESERVED base type
        t.string('numbering_method', 60).nullable();
        t.boolean('is_deemed_positive').defaultTo(false);
        t.boolean('affects_stock').defaultTo(false);
        t.boolean('use_for_pos').defaultTo(false);
        t.boolean('is_active').defaultTo(true);
    }],
    ['tally_budgets', (t) => {
        t.string('parent', 255).nullable();
        t.date('period_from').nullable();
        t.date('period_to').nullable();
    }],

    // ── Price lists ──────────────────────────────────────────
    ['tally_price_levels', () => { /* name + identity only */ }],
    ['tally_price_lists', (t) => {
        t.string('stock_item', 255).nullable();
        t.string('price_level', 255).nullable();
        t.date('applicable_from').nullable();
        t.decimal('from_qty', 18, 3).nullable();
        t.decimal('to_qty', 18, 3).nullable();
        t.decimal('rate', 18, 4).defaultTo(0);
        t.decimal('discount', 8, 3).defaultTo(0);
    }],
    ['tally_bom_components', (t) => {
        t.string('parent_item', 255).notNullable();
        t.string('component_item', 255).notNullable();
        t.decimal('qty', 18, 3).defaultTo(0);
        t.string('godown', 255).nullable();
    }],

    // ── Tax classifications ──────────────────────────────────
    ['tally_gst_classifications', (t) => {
        t.string('hsn_code', 30).nullable();
        t.decimal('rate', 8, 3).defaultTo(0);
        t.string('taxability', 60).nullable();
        t.date('applicable_from').nullable();
    }],
    ['tally_tds_categories', (t) => {
        t.string('section_number', 60).nullable();
        t.string('payment_code', 60).nullable();
    }],
    ['tally_tcs_categories', (t) => {
        t.string('section_number', 60).nullable();
        t.decimal('rate', 8, 3).defaultTo(0);
    }],

    // ── Payroll ──────────────────────────────────────────────
    ['tally_employee_groups', (t) => {
        t.string('parent', 255).nullable();
    }],
    ['tally_employees', (t) => {
        t.string('parent', 255).nullable();              // employee group
        t.string('employee_code', 60).nullable();
        t.string('designation', 255).nullable();
        t.date('date_of_joining').nullable();
        t.date('date_of_release').nullable();
        t.string('bank_name', 255).nullable();
        t.string('bank_account_no', 60).nullable();
        t.string('ifsc', 20).nullable();
        t.string('pan_number', 20).nullable();
        t.string('pf_account', 60).nullable();
        t.string('esi_number', 60).nullable();
    }],
    ['tally_attendance_types', (t) => {
        t.string('parent', 255).nullable();
        t.string('attendance_period', 60).nullable();
        t.string('production_type', 60).nullable();
    }],
    ['tally_pay_heads', (t) => {
        t.string('parent', 255).nullable();
        t.string('pay_head_type', 60).nullable();
        t.string('calculation_type', 60).nullable();
        t.string('calculation_period', 60).nullable();
        t.boolean('affects_net_salary').defaultTo(true);
    }],
];

exports.up = async function up(knex) {
    for (const [name, extend] of TABLES) {
        await masterTable(knex, name, extend);
    }

    // ── Ledger sub-lists. Keyed by the OWNING ledger rather than by their own
    //    identity (Tally gives these no GUID), so they are replace-by-ledger. ──
    if (!(await knex.schema.hasTable('tally_ledger_bank_details'))) {
        await knex.schema.createTable('tally_ledger_bank_details', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable();
            t.string('ledger_name', 255).notNullable();
            t.integer('line_no').notNullable().defaultTo(0);
            t.string('account_no', 60).nullable();
            t.string('ifsc', 20).nullable();
            t.string('bank_name', 255).nullable();
            t.string('branch', 255).nullable();
            t.string('account_holder', 255).nullable();
            t.jsonb('extra').notNullable().defaultTo('{}');
            t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
            t.unique(['company_id', 'ledger_name', 'line_no'], { indexName: 'tally_ledger_bank_uq' });
            t.foreign('company_id').references('id').inTable('companies').onDelete('CASCADE');
        });
    }

    // Opening bill-wise breakup. Without it, a party's opening balance is one
    // lump and ageing cannot see which OLD bills it is made of — so day-one
    // outstanding is wrong for every company that migrated mid-year.
    if (!(await knex.schema.hasTable('tally_ledger_opening_bills'))) {
        await knex.schema.createTable('tally_ledger_opening_bills', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable();
            t.string('ledger_name', 255).notNullable();
            t.integer('line_no').notNullable().defaultTo(0);
            t.string('bill_name', 255).nullable();
            t.date('bill_date').nullable();
            t.decimal('amount', 18, 2).defaultTo(0);
            t.integer('credit_period_days').nullable();
            t.date('due_date').nullable();
            t.jsonb('extra').notNullable().defaultTo('{}');
            t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
            t.unique(['company_id', 'ledger_name', 'line_no'], { indexName: 'tally_ledger_openbill_uq' });
            t.index(['company_id', 'ledger_name'], 'tally_ledger_openbill_party_idx');
            t.foreign('company_id').references('id').inTable('companies').onDelete('CASCADE');
        });
    }

    // Stock-item GST rate slabs (one row per applicable-from date).
    if (!(await knex.schema.hasTable('tally_stock_item_gst_rates'))) {
        await knex.schema.createTable('tally_stock_item_gst_rates', (t) => {
            t.bigIncrements('id').primary();
            t.bigInteger('company_id').notNullable();
            t.string('stock_item', 255).notNullable();
            t.integer('line_no').notNullable().defaultTo(0);
            t.date('applicable_from').nullable();
            t.string('hsn_code', 30).nullable();
            t.string('taxability', 60).nullable();
            t.decimal('rate', 8, 3).defaultTo(0);
            t.decimal('cgst', 8, 3).defaultTo(0);
            t.decimal('sgst', 8, 3).defaultTo(0);
            t.decimal('igst', 8, 3).defaultTo(0);
            t.decimal('cess', 8, 3).defaultTo(0);
            t.jsonb('extra').notNullable().defaultTo('{}');
            t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
            t.unique(['company_id', 'stock_item', 'line_no'], { indexName: 'tally_item_gst_uq' });
            t.foreign('company_id').references('id').inTable('companies').onDelete('CASCADE');
        });
    }

    // ── Company F11 feature flags + the extra registration numbers. They decide
    //    which optional collections are even worth pulling for a company. ──
    for (const [col, build] of [
        ['formal_name',    (t) => t.string('formal_name', 255).nullable()],
        ['tan_number',     (t) => t.string('tan_number', 20).nullable()],
        ['cin_number',     (t) => t.string('cin_number', 30).nullable()],
        ['currency',       (t) => t.string('currency', 20).nullable()],
        ['tally_features', (t) => t.jsonb('tally_features').notNullable().defaultTo('{}')],
    ]) {
        if (!(await knex.schema.hasColumn('companies', col))) {
            await knex.schema.alterTable('companies', build);
        }
    }
};

exports.down = async function down(knex) {
    for (const t of ['tally_stock_item_gst_rates', 'tally_ledger_opening_bills',
                     'tally_ledger_bank_details']) {
        await knex.schema.dropTableIfExists(t);
    }
    for (const [name] of [...TABLES].reverse()) {
        await knex.schema.dropTableIfExists(name);
    }
    await knex.schema.alterTable('companies', (t) => {
        t.dropColumn('formal_name'); t.dropColumn('tan_number'); t.dropColumn('cin_number');
        t.dropColumn('currency'); t.dropColumn('tally_features');
    }).catch(() => {});
};
