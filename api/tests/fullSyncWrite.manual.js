'use strict';

/**
 * api/tests/fullSyncWrite.manual.js
 *
 * END-TO-END WRITE CHECK for the Tally mirror — without Tally.
 *
 * Feeds /agent/import one payload shaped exactly the way agent/tally_connector.py
 * now produces it, then asserts that EVERY table the mirror is supposed to fill
 * actually received its row and that the values survived the trip. This is the
 * half that unit tests cannot cover: the parser tests prove the agent produces
 * the right dict, but nothing otherwise proves the controller writes it.
 *
 * It also runs the import TWICE, because a mirror that duplicates on re-import
 * is as broken as one that drops rows — the agent re-sends an AlterID window
 * whenever a cycle is interrupted.
 *
 * NOT part of `npm test`: it needs a live tenant database, and it writes (then
 * removes) rows in it. Run it deliberately:
 *
 *     node tests/fullSyncWrite.manual.js [--license 2] [--company 1]
 */

require('dotenv').config();

const assert = require('node:assert');
const { runWithTenant } = require('../config/db');
const { getKnexForLicense } = require('../config/tenantDb');
const AgentController = require('../Controllers/Agent/AgentController');

const P = 'ZZSYNC';                     // prefix: everything created here is removable
const GUID = `${P}-voucher-0001`;
const HIGH_ALTER = 999000000;           // above any real watermark, so nothing is skipped

// One voucher carrying every child collection the mirror knows about, plus the
// masters that arrive alongside it.
function payload(companyId) {
    return {
        company_id: companyId,
        company_master: {
            guid: `${P}-company`, formal_name: `${P} Formal`, tan: 'BLRZ12345A',
            cin: 'U74999KA2020PTC000000', currency: 'INR',
            features: { ISINVENTORYON: 'Yes', ISBILLWISEON: 'Yes', ISCOSTCENTRESON: 'Yes' },
        },
        groups: [{ name: `${P} Group`, guid: `${P}-grp`, master_id: 8001, alterid: HIGH_ALTER,
                   parent: 'Primary', primary_group: 'Current Assets' }],
        ledgers: [{
            name: `${P} Acme`, guid: `${P}-led`, master_id: 8002, alterid: HIGH_ALTER,
            parent: 'Sundry Debtors', gstin: '27AABCU9603R1ZM',
            opening: '-5000', closing: '-16800',
            is_billwise: true, credit_period_days: 30,
            bank_details: [{ account_no: '50100123456', ifsc: 'HDFC0000123',
                             bank_name: 'HDFC Bank', branch: 'Indore', account_holder: `${P} Acme` }],
            opening_bills: [{ bill_name: `${P}-OPEN-1`, bill_date: '20250601',
                              amount: 5000, credit_period_days: 30 }],
        }, {
            // A creditor, so the customer/supplier classifier is exercised BOTH ways.
            name: `${P} Vendor`, guid: `${P}-sup`, master_id: 8005, alterid: HIGH_ALTER,
            parent: 'Sundry Creditors', gstin: '29AABCU9603R1ZM', opening: '2000',
        }],
        stock_items: [{
            name: `${P} Widget`, guid: `${P}-item`, master_id: 8003, alterid: HIGH_ALTER,
            parent: `${P} StockGroup`, unit: 'Nos', hsn: '73181500', gst_rate: 18,
            closing: '250', sales_price: 1000, purchase_price: 800,
            gst_slabs: [{ applicable_from: '20250701', hsn_code: '73181500',
                          taxability: 'Taxable', rate: 18, cgst: 9, sgst: 9, igst: 18, cess: 0 }],
            batches: [{ batch_name: 'B-OPEN-1', godown: `${P} Store`,
                        manufactured_on: '20251201', expires_on: '20261201', opening_qty: 40 }],
            price_list: [{ price_level: `${P} Wholesale`, applicable_from: '20260401',
                           from_qty: 1, to_qty: 100, rate: 950, discount: 5 }],
            bom: [{ component_item: `${P} Sole`, qty: 2, godown: `${P} Store` }],
        }],
        godowns: [{ name: `${P} Store`, guid: `${P}-gdn`, master_id: 8004, alterid: HIGH_ALTER,
                    parent: 'Primary', address: 'Plot 4', has_no_space: false, is_external: false }],
        masters: {
            unit: [{ name: `${P}Nos`, guid: `${P}-unit`, master_id: 8010, alterid: HIGH_ALTER,
                     is_simple: true, decimal_places: 2 }],
            stock_group: [{ name: `${P} StockGroup`, guid: `${P}-sg`, master_id: 8011,
                            alterid: HIGH_ALTER, parent: 'Primary' }],
            cost_category: [{ name: `${P} Branch`, guid: `${P}-cc`, master_id: 8012,
                              alterid: HIGH_ALTER, allocate_revenue: true }],
            cost_centre: [{ name: `${P} Indore`, guid: `${P}-cn`, master_id: 8013,
                            alterid: HIGH_ALTER, category: `${P} Branch` }],
            voucher_type: [{ name: `${P} Cash Sales`, guid: `${P}-vt`, master_id: 8014,
                             alterid: HIGH_ALTER, parent: 'Sales', numbering_method: 'Automatic',
                             affects_stock: true, is_active: true }],
            currency: [{ name: '₹', guid: `${P}-cur`, master_id: 8015, alterid: HIGH_ALTER,
                         symbol: '₹', formal_name: 'Indian Rupees', decimal_places: 2 }],
            employee: [{ name: `${P} Ram`, guid: `${P}-emp`, master_id: 8016, alterid: HIGH_ALTER,
                         employee_code: 'E-1', designation: 'Sales', date_of_joining: '20240401' }],
            stock_item_full: [{ name: `${P} Widget`, guid: `${P}-sif`, master_id: 8017,
                                alterid: HIGH_ALTER, parent: `${P} StockGroup`, base_units: `${P}Nos`,
                                hsn_code: '73181500', gst_rate: 18, is_batchwise: true,
                                closing_qty: 250, closing_value: 200000, costing_method: 'Avg. Cost' }],
            // The rest of the registry, so no master kind goes unverified.
            stock_category: [{ name: `${P} StockCat`, guid: `${P}-sc`, master_id: 8018,
                               alterid: HIGH_ALTER, parent: 'Primary' }],
            price_level: [{ name: `${P} Wholesale`, guid: `${P}-pl`, master_id: 8019,
                            alterid: HIGH_ALTER }],
            budget: [{ name: `${P} FY26`, guid: `${P}-bud`, master_id: 8020, alterid: HIGH_ALTER,
                       parent: 'Primary', period_from: '20260401', period_to: '20270331' }],
            gst_classification: [{ name: `${P} GSTClass`, guid: `${P}-gcl`, master_id: 8021,
                                   alterid: HIGH_ALTER, hsn_code: '73181500', rate: 18,
                                   taxability: 'Taxable', applicable_from: '20250701' }],
            tds_category: [{ name: `${P} TDS194C`, guid: `${P}-tds`, master_id: 8022,
                             alterid: HIGH_ALTER, section_number: '194C', payment_code: 'C' }],
            tcs_category: [{ name: `${P} TCS206C`, guid: `${P}-tcs`, master_id: 8023,
                             alterid: HIGH_ALTER, section_number: '206C', rate: 1 }],
            employee_group: [{ name: `${P} EmpGroup`, guid: `${P}-eg`, master_id: 8024,
                               alterid: HIGH_ALTER, parent: 'Primary' }],
            attendance_type: [{ name: `${P} Present`, guid: `${P}-att`, master_id: 8025,
                                alterid: HIGH_ALTER, attendance_period: 'Days',
                                production_type: 'Attendance' }],
            pay_head: [{ name: `${P} Basic`, guid: `${P}-ph`, master_id: 8026, alterid: HIGH_ALTER,
                         pay_head_type: 'Earnings for Employees', calculation_type: 'On Attendance',
                         affects_net_salary: true }],
        },
        vouchers: [{
            guid: GUID, master_id: 9001, alterid: HIGH_ALTER,
            vtype: `${P} Cash Sales`, vno: `${P}-S-1`, date: '20260401',
            effective_date: '20260401', party: `${P} Acme`, amount: 11800,
            reference: 'PO-77', reference_date: '20260320',
            narration: 'Being goods sold', party_gstin: '27AABCU9603R1ZM',
            place_of_supply: 'Maharashtra', state: 'Maharashtra', country: 'India',
            entered_by: 'admin', is_invoice: true, is_optional: false, is_cancelled: false,
            voucher_key: 'VK-1', is_post_dated: false, has_cashflow: true,
            dispatch_doc_no: 'DC-9', dispatch_through: 'Blue Dart',
            destination: 'Mumbai', vehicle_number: 'MH12AB1234', order_reference: 'PO-77',

            entries: [
                { ledger: `${P} Acme`, amount: -11800, is_debit: true, is_party_ledger: true },
                { ledger: `${P} Sales`, amount: 10000, is_debit: false, ledger_from_item: true },
                { ledger: `${P} CGST`, amount: 900, is_debit: false },
                { ledger: `${P} SGST`, amount: 900, is_debit: false },
            ],
            inventory: [{ item: `${P} Widget`, qty: 10, billed_qty: 10, actual_qty: 12,
                          rate: 1000, unit: 'Nos', amount: 10000, discount: 5,
                          godown: `${P} Store`, tracking_no: 'TRK-1', order_no: 'PO-77',
                          order_due_date: '20260410', is_deemed_positive: false }],
            bill_allocations: [{ ledger: `${P} Acme`, bill_name: `${P}-S-1`,
                                 bill_type: 'New Ref', amount: -11800, credit_period_days: 30 }],
            batch_allocations: [{ item: `${P} Widget`, batch_name: 'B-01', godown: `${P} Store`,
                                  billed_qty: 10, actual_qty: 12, amount: 10000,
                                  manufactured_on: '20260101', expires_on: '20270101',
                                  tracking_no: 'TRK-1', order_no: 'PO-77' }],
            cost_allocations: [{ ledger: `${P} Sales`, cost_category: `${P} Branch`,
                                 cost_centre: `${P} Indore`, amount: 10000 }],
            bank_allocations: [{ ledger: `${P} Acme`, instrument_no: '004411',
                                 instrument_date: '20260414', transaction_type: 'Cheque',
                                 bank_name: 'ICICI', payment_favouring: 'Devpuri',
                                 unique_reference: 'UTR-99881', status: 'Reconciled' }],
            gst_details: [{ item: `${P} Widget`, hsn_code: '73181500', taxable_value: 10000,
                            rate: 18, cgst: 900, sgst: 900, igst: 0, cess: 0 }],
            inventory_accounting: [{ item: `${P} Widget`, ledger: `${P} Sales`,
                                     amount: 10000, is_debit: false }],
            eway_bills: [{ ewb_number: '181234567890', ewb_date: '20260401',
                           valid_until: '20260403', status: 'Active',
                           transporter_name: 'Blue Dart', transporter_id: '27AAACB1234C1ZX',
                           vehicle_number: 'MH12AB1234', vehicle_type: 'Regular',
                           transport_mode: 'Road', doc_number: `${P}-S-1`, doc_date: '20260401',
                           distance_km: 120, from_place: 'Indore', from_state: 'Madhya Pradesh',
                           to_place: 'Mumbai', to_state: 'Maharashtra' }],
            einvoice: [{ irn: 'a'.repeat(64), ack_number: '112010036789',
                         ack_date: '20260401', signed_qr_code: 'eyJhbGciOi...',
                         status: 'Generated' }],
        },
        // Three more vouchers so the CLASSIFIER is exercised on every branch it
        // has: receipt → payments, journal → journals, and a type it recognises
        // as none of them (which must still reach tally_vouchers).
        {
            guid: `${P}-voucher-0002`, master_id: 9002, alterid: HIGH_ALTER,
            vtype: 'Receipt', vno: `${P}-R-1`, date: '20260415', party: `${P} Acme`,
            amount: 11800,
            entries: [{ ledger: `${P} Acme`, amount: 11800, is_debit: false },
                      { ledger: `${P} Cash`, amount: -11800, is_debit: true }],
            bill_allocations: [{ ledger: `${P} Acme`, bill_name: `${P}-S-1`,
                                 bill_type: 'Agst Ref', amount: 11800 }],
        },
        {
            guid: `${P}-voucher-0003`, master_id: 9003, alterid: HIGH_ALTER,
            vtype: 'Journal', vno: `${P}-J-1`, date: '20260420', amount: 500,
            entries: [{ ledger: `${P} Sales`, amount: -500, is_debit: true },
                      { ledger: `${P} Acme`, amount: 500, is_debit: false }],
        },
        {
            // Delivery Note: no invoice/payment/journal branch claims it, so it
            // used to be counted "unclassified" and stored nowhere. It must now
            // land in tally_vouchers like every other type.
            guid: `${P}-voucher-0004`, master_id: 9004, alterid: HIGH_ALTER,
            vtype: 'Delivery Note', vno: `${P}-DN-1`, date: '20260402',
            party: `${P} Acme`, amount: 10000,
            entries: [{ ledger: `${P} Acme`, amount: -10000, is_debit: true },
                      { ledger: `${P} Sales`, amount: 10000, is_debit: false }],
            inventory: [{ item: `${P} Widget`, qty: 10, billed_qty: 10, actual_qty: 10,
                          rate: 1000, amount: 10000, godown: `${P} Store` }],
        }],
        financial_reports: {
            [`${P}_trial_balance`]: { rows: [{ name: `${P} Acme`, debit: 16800, credit: 0 }],
                                      debit_total: 16800, credit_total: 16800 },
        },
    };
}

// What must exist afterwards: table → [where, human label, assertions]
const EXPECTED = [
    ['tally_vouchers',        (q) => q.where('guid', GUID),          'voucher header'],
    ['tally_voucher_entries', (q) => q.where('voucher_guid', GUID),  'ledger entries (4)'],
    ['tally_inventory_entries', (q) => q.where('voucher_guid', GUID), 'inventory lines'],
    ['tally_bill_allocations', (q) => q.where('voucher_guid', GUID), 'bill allocations'],
    ['tally_batch_allocations', (q) => q.where('voucher_guid', GUID), 'batch allocations'],
    ['tally_cost_allocations', (q) => q.where('voucher_guid', GUID), 'cost centre allocations'],
    ['tally_bank_allocations', (q) => q.where('voucher_guid', GUID), 'bank allocations'],
    ['tally_voucher_gst_details', (q) => q.where('voucher_guid', GUID), 'GST breakup'],
    ['tally_inventory_accounting_allocations', (q) => q.where('voucher_guid', GUID), 'item → ledger link'],
    ['tally_eway_bills',      (q) => q.where('voucher_guid', GUID),  'e-Way Bills'],
    ['tally_einvoice_details', (q) => q.where('voucher_guid', GUID), 'e-Invoice / IRN'],
    ['tally_ledgers',         (q) => q.where('tally_guid', `${P}-led`), 'ledger master'],
    ['tally_groups',          (q) => q.where('tally_guid', `${P}-grp`), 'group master'],
    ['tally_ledger_bank_details', (q) => q.where('ledger_name', `${P} Acme`), 'ledger bank details'],
    ['tally_ledger_opening_bills', (q) => q.where('ledger_name', `${P} Acme`), 'opening bill-wise'],
    ['tally_stock_item_gst_rates', (q) => q.where('stock_item', `${P} Widget`), 'stock GST slabs'],
    ['tally_units',           (q) => q.where('tally_guid', `${P}-unit`), 'unit master'],
    ['tally_stock_groups',    (q) => q.where('tally_guid', `${P}-sg`), 'stock group master'],
    ['tally_cost_categories', (q) => q.where('tally_guid', `${P}-cc`), 'cost category master'],
    ['tally_cost_centres',    (q) => q.where('tally_guid', `${P}-cn`), 'cost centre master'],
    ['tally_voucher_types',   (q) => q.where('tally_guid', `${P}-vt`), 'voucher type master'],
    ['tally_currencies',      (q) => q.where('tally_guid', `${P}-cur`), 'currency master'],
    ['tally_employees',       (q) => q.where('tally_guid', `${P}-emp`), 'employee master'],
    ['tally_stock_items',     (q) => q.where('tally_guid', `${P}-sif`), 'stock item full mirror'],
    ['tally_stock_categories', (q) => q.where('tally_guid', `${P}-sc`), 'stock category master'],
    ['tally_price_levels',    (q) => q.where('tally_guid', `${P}-pl`), 'price level master'],
    ['tally_budgets',         (q) => q.where('tally_guid', `${P}-bud`), 'budget master'],
    ['tally_gst_classifications', (q) => q.where('tally_guid', `${P}-gcl`), 'GST classification'],
    ['tally_tds_categories',  (q) => q.where('tally_guid', `${P}-tds`), 'TDS category'],
    ['tally_tcs_categories',  (q) => q.where('tally_guid', `${P}-tcs`), 'TCS category'],
    ['tally_employee_groups', (q) => q.where('tally_guid', `${P}-eg`), 'employee group'],
    ['tally_attendance_types', (q) => q.where('tally_guid', `${P}-att`), 'attendance type'],
    ['tally_pay_heads',       (q) => q.where('tally_guid', `${P}-ph`), 'pay head'],
    ['customers',             (q) => q.where('tally_guid', `${P}-led`), 'customer (classified)'],
    ['suppliers',             (q) => q.where('tally_guid', `${P}-sup`), 'supplier (classified)'],
    ['products',              (q) => q.where('tally_guid', `${P}-item`), 'product'],
    ['locations',             (q) => q.where('tally_guid', `${P}-gdn`), 'location (godown)'],
    ['categories',            (q) => q.where('name', `${P} StockGroup`), 'category from stock group'],
    ['invoices',              (q) => q.where('tally_guid', GUID), 'invoice (sales classified)'],
    ['payments',              (q) => q.where('tally_guid', `${P}-voucher-0002`), 'payment (receipt classified)'],
    ['journals',              (q) => q.where('tally_guid', `${P}-voucher-0003`), 'journal classified'],
    ['tally_reports',         (q) => q.where('report_type', `${P}_trial_balance`), 'financial report'],
    ['tally_batches',         (q) => q.where('stock_item', `${P} Widget`), 'opening batches (nested)'],
    ['tally_price_lists',     (q) => q.where('stock_item', `${P} Widget`), 'price list rates (nested)'],
    ['tally_bom_components',  (q) => q.where('parent_item', `${P} Widget`), 'bill of materials (nested)'],
];

// Tables the schema defines but NOTHING currently populates. Reported so the gap
// is visible rather than silently passing as "no rows, no problem": each is a
// NESTED list under another master (batches and price lists under a stock item,
// BOM components under its parent item), which the flat collection registry
// cannot express — they need their own extraction, like the ledger sub-lists.
const NO_WRITER_YET = [];

/**
 * Put tally_sync_state.master_alter_id back where it belongs.
 *
 * MUST run, or this script BREAKS the company it was pointed at: the fixtures
 * carry a deliberately huge AlterID (so the importer does not skip them as
 * "unchanged"), and the importer advances the watermark to whatever it saw. Left
 * at 999,000,000 no real master would ever exceed it, so every later sync would
 * silently skip every ledger, item and group — a live company would simply stop
 * receiving updates, with nothing in the logs to say why.
 *
 * The true watermark is the highest AlterID actually present in the mirrored
 * data, so it can be recomputed rather than guessed.
 */
async function restoreWatermark(db, companyId) {
    const led = await db('tally_ledgers').where('company_id', companyId).max('tally_alter_id as m').first();
    const grp = await db('tally_groups').where('company_id', companyId).max('tally_alter_id as m').first();
    const real = Math.max(Number((led && led.m) || 0), Number((grp && grp.m) || 0));
    await db('tally_sync_state').where('company_id', companyId)
        .update({ master_alter_id: real, updated_at: new Date() });
    return real;
}

async function cleanup(db) {
    // Children before parents; tally_vouchers cascades its own child rows.
    for (const t of ['tally_ledger_bank_details', 'tally_ledger_opening_bills',
                     'tally_stock_item_gst_rates']) {
        await db(t).where('ledger_name', `${P} Acme`).del().catch(() => {});
        await db(t).where('stock_item', `${P} Widget`).del().catch(() => {});
    }
    for (const t of ['tally_batches', 'tally_price_lists']) {
        await db(t).where('stock_item', `${P} Widget`).del().catch(() => {});
    }
    await db('tally_bom_components').where('parent_item', `${P} Widget`).del().catch(() => {});
    await db('tally_voucher_entries').where('voucher_guid', 'like', `${P}-%`).del().catch(() => {});
    await db('tally_inventory_entries').where('voucher_guid', 'like', `${P}-%`).del().catch(() => {});
    await db('tally_vouchers').where('guid', 'like', `${P}-%`).del().catch(() => {});  // cascades children
    await db('payments').where('tally_guid', 'like', `${P}-%`).del().catch(() => {});
    await db('journals').where('tally_guid', 'like', `${P}-%`).del().catch(() => {});
    await db('tally_reports').where('report_type', 'like', `${P}%`).del().catch(() => {});
    for (const t of ['tally_units', 'tally_stock_groups', 'tally_stock_categories',
                     'tally_cost_categories', 'tally_cost_centres', 'tally_voucher_types',
                     'tally_currencies', 'tally_employees', 'tally_stock_items',
                     'tally_ledgers', 'tally_groups']) {
        await db(t).where('tally_guid', 'like', `${P}-%`).del().catch(() => {});
    }
    for (const t of ['customers', 'suppliers', 'products', 'locations']) {
        await db(t).where('tally_guid', 'like', `${P}-%`).del().catch(() => {});
    }
    await db('invoices').where('tally_guid', GUID).del().catch(() => {});
    await db('categories').where('name', `${P} StockGroup`).del().catch(() => {});
    await db('record_history').where('note', 'Tally sync')
        .where('created_at', '>', new Date(Date.now() - 600000)).del().catch(() => {});
    await db('tally_sync_logs').where('message', 'like', `%${P}%`).del().catch(() => {});
}

(async () => {
    const argv = process.argv.slice(2);
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    }
    const licenseId = Number(args.license || 2);
    // This driver runs the REAL controller path, so it must connect exactly as
    // the API does — through the licence's own restricted role, not the admin
    // login. index.js does this at boot; a standalone run has to do it itself.
    await require('../config/tenantCredentials').load();
    const db = getKnexForLicense(licenseId);
    let failures = 0;
    let companyId = null;

    try {
        const co = args.company
            ? await db('companies').where('id', Number(args.company)).first('id', 'name')
            : await db('companies').whereNull('deleted_at').orderBy('id').first('id', 'name');
        if (!co) throw new Error('no company in this licence');
        companyId = co.id;
        console.log(`Licence ${licenseId} · company "${co.name}" (id ${co.id})\n`);

        await cleanup(db);   // a previous aborted run must not skew the counts
        // Also reset the watermark UP FRONT: an aborted earlier run may have left
        // it high, which would make the importer skip these fixtures entirely and
        // report every table as empty.
        await restoreWatermark(db, co.id);

        const call = (body) => new Promise((resolve) => runWithTenant(db, () =>
            AgentController.importFromTally({ license: { id: licenseId }, body },
                { status() { return this; }, json(b) { resolve(b); return this; } })));

        const first = await call(payload(co.id));
        if (first.status !== 200) throw new Error(`import rejected: ${first.msg}`);
        // Twice — a mirror that duplicates on re-import is as broken as one that drops.
        const second = await call(payload(co.id));
        if (second.status !== 200) throw new Error(`re-import rejected: ${second.msg}`);

        console.log('WRITE CHECK — every table the mirror should fill:');
        for (const [table, where, label] of EXPECTED) {
            if (!(await db.schema.hasTable(table))) {
                console.log(`  ✗ ${table.padEnd(42)} TABLE MISSING`); failures += 1; continue;
            }
            const rows = await where(db(table));
            const ok = rows.length > 0;
            if (!ok) failures += 1;
            console.log(`  ${ok ? '✓' : '✗'} ${table.padEnd(42)} ${String(rows.length).padStart(3)} row(s)  ${label}`);
        }

        console.log('\nNOT POPULATED — table exists, nothing writes to it yet:');
        for (const [table, why] of NO_WRITER_YET) {
            const exists = await db.schema.hasTable(table);
            console.log(`  · ${table.padEnd(42)} ${exists ? '' : '(table missing) '}${why}`);
        }

        console.log('\nVALUE CHECK — did the values survive the trip?');
        const v = await db('tally_vouchers').where('guid', GUID).first();
        const checks = [
            ['narration', v.narration, 'Being goods sold'],
            ['party gstin', v.party_gstin, '27AABCU9603R1ZM'],
            ['reference', v.reference, 'PO-77'],
            ['vehicle number', v.vehicle_number, 'MH12AB1234'],
            ['is_invoice', v.is_invoice, true],
        ];
        const ymd = (d) => (d instanceof Date
            ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
            : String(d).slice(0, 10));
        const inv = await db('tally_inventory_entries').where('voucher_guid', GUID).first();
        checks.push(['billed qty', Number(inv.billed_qty), 10]);
        // actual ≠ billed is the whole point of storing both (shortage / free issue).
        checks.push(['actual qty', Number(inv.actual_qty), 12]);
        checks.push(['discount', Number(inv.discount), 5]);
        checks.push(['godown', inv.godown, `${P} Store`]);
        checks.push(['tracking no', inv.tracking_no, 'TRK-1']);

        const bill = await db('tally_bill_allocations').where('voucher_guid', GUID).first();
        checks.push(['bill type', bill.bill_type, 'New Ref']);
        // Derived from bill date + credit period — the basis of ageing.
        // pg hands back a Date, so format it rather than slicing its toString().
        checks.push(['derived due date', ymd(bill.due_date), '2026-05-01']);

        const ewb = await db('tally_eway_bills').where('voucher_guid', GUID).first();
        checks.push(['EWB number', ewb.ewb_number, '181234567890']);
        checks.push(['transporter', ewb.transporter_name, 'Blue Dart']);
        checks.push(['distance km', Number(ewb.distance_km), 120]);

        const einv = await db('tally_einvoice_details').where('voucher_guid', GUID).first();
        checks.push(['IRN length', einv.irn.length, 64]);
        checks.push(['ack number', einv.ack_number, '112010036789']);

        const bank = await db('tally_ledger_bank_details').where('ledger_name', `${P} Acme`).first();
        checks.push(['party IFSC', bank.ifsc, 'HDFC0000123']);
        const ob = await db('tally_ledger_opening_bills').where('ledger_name', `${P} Acme`).first();
        checks.push(['opening bill', ob.bill_name, `${P}-OPEN-1`]);
        const batch = await db('tally_batches').where('stock_item', `${P} Widget`).first();
        checks.push(['opening batch qty', Number(batch.opening_qty), 40]);
        checks.push(['batch expiry', ymd(batch.expires_on), '2026-12-01']);
        const price = await db('tally_price_lists').where('stock_item', `${P} Widget`).first();
        checks.push(['price list rate', Number(price.rate), 950]);
        const bom = await db('tally_bom_components').where('parent_item', `${P} Widget`).first();
        checks.push(['BOM component', bom.component_item, `${P} Sole`]);
        const slab = await db('tally_stock_item_gst_rates').where('stock_item', `${P} Widget`).first();
        checks.push(['GST slab cgst', Number(slab.cgst), 9]);
        const comp = await db('companies').where('id', co.id).first('tally_features');
        const feats = typeof comp.tally_features === 'string'
            ? JSON.parse(comp.tally_features) : comp.tally_features;
        checks.push(['F11 ISBILLWISEON', feats.ISBILLWISEON, 'Yes']);

        for (const [label, got, want] of checks) {
            const ok = String(got) === String(want);
            if (!ok) failures += 1;
            console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(20)} ${String(got)}${ok ? '' : `   (expected ${want})`}`);
        }

        console.log('\nIDEMPOTENCY — imported twice, so no table may hold duplicates:');
        for (const [table, where, label] of EXPECTED) {
            if (!(await db.schema.hasTable(table))) continue;
            const rows = await where(db(table));
            const expected = table === 'tally_voucher_entries' ? 4 : 1;
            const ok = rows.length === expected;
            if (!ok) failures += 1;
            if (!ok) console.log(`  ✗ ${table.padEnd(42)} ${rows.length} rows (expected ${expected})  ${label}`);
        }
        if (!failures) console.log('  ✓ no duplicates anywhere');

        console.log('\nDOUBLE ENTRY — every imported voucher must balance:');
        const guids = await db('tally_vouchers').where('guid', 'like', `${P}-%`).pluck('guid');
        for (const g of guids) {
            const legs = await db('tally_voucher_entries').where('voucher_guid', g)
                .select('amount', 'is_debit');
            const net = legs.reduce((s, e) => s + (e.is_debit ? Math.abs(e.amount) : -Math.abs(e.amount)), 0);
            const balanced = Math.abs(net) < 0.01;
            if (!balanced) failures += 1;
            console.log(`  ${balanced ? '✓' : '✗'} ${g.padEnd(24)} ${legs.length} legs, net ${net.toFixed(2)}`);
        }

        console.log('\nEVERY VOUCHER TYPE IS MIRRORED — including ones no branch classifies:');
        for (const g of [`${P}-voucher-0004`]) {
            const v = await db('tally_vouchers').where('guid', g).first('voucher_type');
            const ok = !!v;
            if (!ok) failures += 1;
            console.log(`  ${ok ? '✓' : '✗'} ${g} → ${v ? v.voucher_type : 'NOT STORED'}`
                + ' (previously counted "unclassified" and dropped)');
        }
    } finally {
        await cleanup(db);
        if (companyId) {
            const wm = await restoreWatermark(db, companyId).catch(() => null);
            if (wm != null) console.log(`\n(sync watermark restored to ${wm})`);
        }
        await db.destroy().catch(() => {});
    }

    console.log(failures ? `\n✗ ${failures} check(s) FAILED` : '\n✓ ALL CHECKS PASSED — every table is written correctly');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('✗ run failed:', e); process.exit(2); });
