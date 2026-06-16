'use strict';

/* ───────────────────────────────────────────────────────────────
 * scripts/seed-demo.js — seed DEMO data across EVERY module for a
 * company, so the cloud->Tally push (and the Tally->cloud pull back)
 * can be round-trip tested end-to-end.
 *
 *   node scripts/seed-demo.js "Test"        # seed into existing company "Test"
 *
 * Every row is prefixed "DEMO " and re-running first deletes the prior
 * DEMO rows (idempotent). Masters are left UNSYNCED (is_tally_*=true,
 * tally_guid NULL) and vouchers status='pending_tally' so the agent's
 * /pending push picks them up. Nothing here touches Tally directly.
 * ─────────────────────────────────────────────────────────────── */

try { require('dotenv').config(); } catch (_) { /* env already set */ }
const { db } = require('../config/db');

const COMPANY_NAME = process.argv[2] || 'Test';
const P = 'DEMO ';                 // prefix marking seeded rows
const now = new Date();
// Voucher date: Tally Prime EDUCATIONAL only allows voucher entry on the 1st/2nd
// of a month, so use the 1st (on a LICENSED Tally any date works). Override with
// argv[3] if needed.
const today = process.argv[3] || '2026-06-01';
// Product unit: EDU rejects creating predefined unit symbols (Nos/Box/Kg) via
// XML ("DUPLICATE ORIGINAL NAME"); a custom unit name creates fine. On licensed
// Tally use the real unit. Override with argv[4].
const UNIT = process.argv[4] || 'DemoUnit';

async function main() {
    const company = await db('companies').whereRaw('lower(name)=?', [COMPANY_NAME.toLowerCase()])
        .whereNull('deleted_at').orderBy('id', 'desc').first('id', 'name', 'license_id');
    if (!company) { console.error(`Company "${COMPANY_NAME}" not found in cloud.`); process.exit(1); }
    const cid = company.id;
    console.log(`Seeding DEMO data into "${company.name}" (id ${cid}, license ${company.license_id})`);

    // ── 0) wipe prior DEMO rows (child → parent) so re-runs stay clean ──
    const demoInv = (await db('invoices').where('company_id', cid).where('invoice_no', 'like', P + '%').select('id')).map((r) => r.id);
    if (demoInv.length) await db('invoice_items').whereIn('invoice_id', demoInv).del();
    await db('invoices').where('company_id', cid).where('invoice_no', 'like', P + '%').del();
    await db('payments').where('company_id', cid).where('voucher_no', 'like', P + '%').del();
    await db('journals').where('company_id', cid).where('voucher_no', 'like', P + '%').del();
    for (const t of ['products', 'customers', 'suppliers', 'categories', 'locations']) {
        await db(t).where('company_id', cid).where('name', 'like', P + '%').del();
    }

    const counts = {};
    const ins = async (table, rows) => {
        const ids = [];
        for (const r of rows) { const [row] = await db(table).insert(r).returning('id'); ids.push(row.id || row); }
        counts[table] = (counts[table] || 0) + ids.length;
        return ids;
    };

    // ── 1) Masters (unsynced → push-eligible) ──
    const custIds = await ins('customers', [1, 2, 3].map((n) => ({
        company_id: cid, name: `${P}Customer ${n}`, status: 'Active', is_tally_ledger: true,
        tally_guid: null, gst_number: null, opening_balance: 1000 * n, created_at: now, updated_at: now,
    })));
    const supIds = await ins('suppliers', [1, 2].map((n) => ({
        company_id: cid, name: `${P}Supplier ${n}`, status: 'Active', is_tally_ledger: true,
        tally_guid: null, gst_number: null, opening_balance: 500 * n, created_at: now, updated_at: now,
    })));
    // Fresh names (the original DEMO Category/Location names were poisoned in
    // Tally by earlier buggy PARENT=Primary push attempts). Override via argv[5].
    const TAG = process.argv[5] || 'V2';
    await ins('categories', [1, 2].map((n) => ({
        company_id: cid, name: `${P}Grp ${TAG} ${n}`, status: 'Active', created_at: now, updated_at: now,
    })));
    await ins('locations', [1, 2].map((n) => ({
        company_id: cid, name: `${P}Whse ${TAG} ${n}`, status: 'Active', is_tally_godown: true,
        tally_guid: null, created_at: now, updated_at: now,
    })));
    const prodIds = await ins('products', [1, 2, 3].map((n) => ({
        company_id: cid, name: `${P}Product ${n}`, status: 'Active', is_tally_item: true, tally_guid: null,
        unit: UNIT, hsn_code: `1000${n}`, opening_stock: 10 * n, purchase_price: 50 * n, sales_price: 80 * n,
        gst_rate: 18, created_at: now, updated_at: now,
    })));

    // ── 2) Sales invoices (+items) → push as sales vouchers ──
    let inv = 0;
    const mkInvoice = async (type, no, partyId, lines) => {
        const taxable = lines.reduce((a, l) => a + l.qty * l.rate, 0);
        const tax = Math.round(taxable * 0.18 * 100) / 100;
        const total = taxable + tax;
        const [row] = await db('invoices').insert({
            company_id: cid, type, invoice_no: `${P}${type === 'sales' ? 'S' : 'P'}${no}`,
            [type === 'sales' ? 'customer_id' : 'supplier_id']: partyId,
            invoice_date: today, subtotal: taxable, discount: 0, taxable,
            cgst: tax / 2, sgst: tax / 2, igst: 0, tax_amount: tax, round_off: 0, total,
            status: 'pending_tally', created_at: now, updated_at: now,
        }).returning('id');
        const iid = row.id || row;
        for (const l of lines) {
            const lt = l.qty * l.rate, lg = Math.round(lt * 0.18 * 100) / 100;
            await db('invoice_items').insert({
                company_id: cid, invoice_id: iid, product_id: l.pid, description: l.name,
                hsn: '10001', quantity: l.qty, unit: 'Nos', rate: l.rate, discount_pct: 0,
                taxable: lt, gst_rate: 18, gst_amount: lg, amount: lt + lg, created_at: now,
            });
        }
        counts.invoices = (counts.invoices || 0) + 1;
        counts.invoice_items = (counts.invoice_items || 0) + lines.length;
    };
    await mkInvoice('sales', 1, custIds[0], [{ pid: prodIds[0], name: `${P}Product 1`, qty: 2, rate: 80 }]);
    await mkInvoice('sales', 2, custIds[1], [{ pid: prodIds[1], name: `${P}Product 2`, qty: 1, rate: 160 }, { pid: prodIds[2], name: `${P}Product 3`, qty: 3, rate: 240 }]);
    await mkInvoice('purchase', 1, supIds[0], [{ pid: prodIds[0], name: `${P}Product 1`, qty: 5, rate: 50 }]);

    // ── 3) Payments + receipts → push as payment/receipt vouchers ──
    await ins('payments', [
        { company_id: cid, type: 'receipt', voucher_no: `${P}R1`, party_type: 'customer', customer_id: custIds[0], payment_date: today, mode: 'Cash', amount: 2000, status: 'pending_tally', created_at: now, updated_at: now },
        { company_id: cid, type: 'receipt', voucher_no: `${P}R2`, party_type: 'customer', customer_id: custIds[1], payment_date: today, mode: 'Bank', amount: 3000, status: 'pending_tally', created_at: now, updated_at: now },
        { company_id: cid, type: 'payment', voucher_no: `${P}P1`, party_type: 'supplier', supplier_id: supIds[0], payment_date: today, mode: 'Cash', amount: 1500, status: 'pending_tally', created_at: now, updated_at: now },
    ]);

    // ── 4) Journals → push as journal vouchers ──
    await ins('journals', [
        { company_id: cid, voucher_no: `${P}J1`, vch_type: 'Journal', journal_date: today, dr_ledger: `${P}Customer 1`, cr_ledger: `${P}Customer 2`, amount: 1000, narration: 'DEMO journal 1', status: 'pending_tally', created_at: now, updated_at: now },
        { company_id: cid, voucher_no: `${P}J2`, vch_type: 'Journal', journal_date: today, dr_ledger: `${P}Supplier 1`, cr_ledger: `${P}Customer 1`, amount: 500, narration: 'DEMO journal 2', status: 'pending_tally', created_at: now, updated_at: now },
    ]);

    console.log('Seeded:', JSON.stringify(counts));
    console.log('All masters UNSYNCED + vouchers pending_tally → ready for cloud→Tally push.');
    await db.destroy();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
