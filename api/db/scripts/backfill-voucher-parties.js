'use strict';

/**
 * db/scripts/backfill-voucher-parties.js
 *
 * Attaches already-synced receipts / payments / invoices to their customer or
 * supplier, for the rows the sync imported with a NULL party FK.
 *
 * Why they are NULL: Tally leaves PARTYLEDGERNAME empty on most receipt and
 * payment vouchers, so the importer had no name to match. AgentController now
 * falls back to the voucher's own postings, but that only helps vouchers
 * pulled from here on — an already-imported voucher is skipped on re-pull
 * (dedup is by GUID), so the historical rows stay unlinked forever without a
 * backfill.
 *
 * Why it matters: a receipt that is not attached to a customer can never
 * settle that customer's bills, so Receivables reports every invoice as fully
 * outstanding and Avg Pay Days is blank for everyone.
 *
 * The party is read from tally_voucher_entries (the full double-entry mirror
 * the sync always stores) using the same side-preference-then-either rule the
 * importer uses.
 *
 * Usage:
 *   node db/scripts/backfill-voucher-parties.js <database> [--commit]
 *   node db/scripts/backfill-voucher-parties.js tally_lic_2          # dry run
 *   node db/scripts/backfill-voucher-parties.js tally_lic_2 --commit # apply
 *
 * Dry run by default: prints what it WOULD link and changes nothing.
 */

require('dotenv').config();
const path = require('path');

const base = require(path.join(__dirname, '..', '..', 'knexfile.js'))[process.env.NODE_ENV || 'development'];

const database = process.argv[2];
const commit = process.argv.includes('--commit');

if (!database) {
    console.error('Usage: node db/scripts/backfill-voucher-parties.js <database> [--commit]');
    process.exit(1);
}

const knex = require('knex')({ ...base, connection: { ...base.connection, database } });

// Round-off postings are a balancing entry, never a party.
const isRound = (name) => /round/i.test(String(name || ''));

/**
 * Pick the party ledger for one voucher from its postings.
 * `wantDebit` is the side the party normally sits on; the other side is tried
 * too, because Tally's is_debit flag is not consistently oriented across
 * voucher classes in the pulled data.
 */
function partyCandidates(entries, wantDebit) {
    const side = (want) => entries
        .filter((e) => !!e.is_debit === want && !isRound(e.ledger_name))
        .sort((a, b) => Math.abs(Number(b.amount) || 0) - Math.abs(Number(a.amount) || 0));
    return [...side(wantDebit), ...side(!wantDebit)];
}

async function backfill(table, where, partyCol, masterTable, wantDebit, label) {
    const rows = await knex(table)
        .where(where)
        .whereNull(partyCol)
        .whereNull('deleted_at')
        .whereNotNull('tally_guid')
        .select('id', 'tally_guid');

    if (!rows.length) {
        console.log(`  ${label}: nothing to link`);
        return { scanned: 0, linked: 0 };
    }

    // Party masters, keyed by lowercased name — one read, then pure matching.
    const masters = await knex(masterTable).whereNull('deleted_at').select('id', 'name');
    const byName = new Map(masters.map((m) => [String(m.name).trim().toLowerCase(), m.id]));

    const guids = rows.map((r) => r.tally_guid);
    const entries = await knex('tally_voucher_entries')
        .whereIn('voucher_guid', guids)
        .select('voucher_guid', 'ledger_name', 'amount', 'is_debit');

    const byGuid = new Map();
    for (const e of entries) {
        if (!byGuid.has(e.voucher_guid)) byGuid.set(e.voucher_guid, []);
        byGuid.get(e.voucher_guid).push(e);
    }

    let linked = 0;
    const updates = [];
    for (const r of rows) {
        const list = byGuid.get(r.tally_guid) || [];
        for (const e of partyCandidates(list, wantDebit)) {
            const id = byName.get(String(e.ledger_name).trim().toLowerCase());
            if (id != null) {
                updates.push({ id: r.id, partyId: id, ledger: e.ledger_name });
                linked += 1;
                break;
            }
        }
    }

    console.log(`  ${label}: ${rows.length} unlinked, ${linked} resolvable`);
    for (const u of updates.slice(0, 3)) {
        console.log(`      e.g. ${table}#${u.id} → ${u.ledger}`);
    }

    if (commit && updates.length) {
        // Chunked so a large tenant does not build one enormous statement.
        for (let i = 0; i < updates.length; i += 500) {
            const chunk = updates.slice(i, i + 500);
            await knex.transaction(async (trx) => {
                for (const u of chunk) {
                    const patch = { [partyCol]: u.partyId, updated_at: new Date() };
                    if (table === 'payments') {
                        patch.party_type = partyCol === 'customer_id' ? 'customer' : 'supplier';
                    }
                    await trx(table).where({ id: u.id }).update(patch);
                }
            });
        }
        console.log(`      → ${updates.length} rows updated`);
    }

    return { scanned: rows.length, linked };
}

(async () => {
    console.log(`\nBackfilling voucher parties in ${database}${commit ? '' : '  (DRY RUN — pass --commit to apply)'}\n`);

    const companies = await knex('companies').select('id', 'name');
    let totalLinked = 0;

    for (const c of companies) {
        console.log(`company #${c.id} — ${c.name}`);
        const jobs = [
            ['payments', { company_id: c.id, type: 'receipt' }, 'customer_id', 'customers', false, 'receipts'],
            ['payments', { company_id: c.id, type: 'payment' }, 'supplier_id', 'suppliers', true, 'payments'],
            ['invoices', { company_id: c.id, type: 'sales' }, 'customer_id', 'customers', true, 'sales invoices'],
            ['invoices', { company_id: c.id, type: 'purchase' }, 'supplier_id', 'suppliers', false, 'purchase invoices'],
        ];
        for (const [table, where, col, master, wantDebit, label] of jobs) {
            const r = await backfill(table, where, col, master, wantDebit, label);
            totalLinked += r.linked;
        }
        console.log('');
    }

    console.log(commit
        ? `Done — ${totalLinked} vouchers linked.`
        : `Dry run complete — ${totalLinked} vouchers would be linked. Re-run with --commit to apply.`);
    await knex.destroy();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
