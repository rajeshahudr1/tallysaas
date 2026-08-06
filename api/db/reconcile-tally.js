'use strict';

/**
 * api/db/reconcile-tally.js
 *
 * Health check for the Tally mirror: does what the cloud CALCULATES equal what
 * Tally REPORTS? Run it after a sync, before trusting a month-end figure, or
 * whenever a number looks wrong.
 *
 * It answers three questions, cheapest first:
 *   1. Trial Balance — do total debits equal total credits? (whole-book)
 *   2. Vouchers      — does each voucher's own double entry balance?
 *   3. Ledgers       — does opening + Σ postings equal Tally's closing balance?
 *
 * A sync can succeed, log nothing and still leave the books wrong: a dropped
 * AlterID window, a voucher whose legs did not all parse, a ledger renamed
 * mid-sync. None of those raise an error, because every individual step worked.
 * This is what notices, and it names the ledger or voucher rather than saying
 * "the totals look off".
 *
 * CLI:
 *   node db/reconcile-tally.js                  # every licence, every company
 *   node db/reconcile-tally.js --license 2
 *   node db/reconcile-tally.js --license 2 --company 1 --verbose
 */

require('dotenv').config();

const { listTenantDbs, tenantKnex, databaseExists } = require('./migrate-tenants');
const { reconcileCompany } = require('../Helpers/tallyReconciliation');

const money = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });

async function reconcileLicence(dbName, { companyId = null, verbose = false, log = console.log } = {}) {
    const db = tenantKnex(dbName);
    const results = [];
    try {
        const q = db('companies').whereNull('deleted_at').select('id', 'name').orderBy('id');
        if (companyId) q.where('id', companyId);
        for (const co of await q) {
            const r = await reconcileCompany(db, co.id);
            const clean = r.trial_balance.ok && r.vouchers.ok && r.ledgers.ok;
            results.push({ company: co.name, ...r, clean });

            log(`\n  ${co.name}  ${clean ? '✓ clean' : '✗ discrepancies'}`);
            log(`    trial balance  Dr ${money(r.trial_balance.debit_total)}`
                + `  Cr ${money(r.trial_balance.credit_total)}`
                + `  diff ${money(r.trial_balance.difference)}`
                + `  ${r.trial_balance.ok ? '✓' : '✗'}`);
            log(`    vouchers       ${r.vouchers.checked} checked, ${r.vouchers.unbalanced} unbalanced`);
            log(`    ledgers        ${r.ledgers.checked} checked, ${r.ledgers.mismatched} mismatched`
                + `  (total ${money(r.ledgers.total_difference)})`);
            if (r.ledgers.unknown_ledgers.length) {
                log(`    ! ${r.ledgers.unknown_ledgers.length} ledger(s) have postings but NO master`);
            }

            const top = verbose ? Infinity : 10;
            for (const m of r.ledgers.mismatches.slice(0, top)) {
                log(`      ${m.ledger.slice(0, 38).padEnd(40)}`
                    + ` tally ${money(m.reported).padStart(16)}`
                    + ` cloud ${money(m.derived).padStart(16)}`
                    + ` diff ${money(m.difference)}`);
            }
            for (const v of r.vouchers.vouchers.slice(0, top)) {
                log(`      voucher ${String(v.voucher_type || '?')} ${String(v.voucher_no || v.guid)}`
                    + ` — ${v.reason} (${money(v.difference)})`);
            }
            for (const u of r.ledgers.unknown_ledgers.slice(0, top)) {
                log(`      no master: ${u.ledger} (movement ${money(u.movement)})`);
            }

            const vt = r.voucher_types;
            if (vt.unavailable) {
                log(`    voucher types  — ${vt.unavailable}`);
            } else {
                log(`    voucher types  ${vt.types.length} defined in Tally,`
                    + ` ${vt.types.filter((t) => t.synced > 0).length} with synced vouchers`);
                // A defined-but-empty type is NOT automatically a defect — plenty
                // of companies never raise a Sales Order. It is the list to eyeball.
                for (const m of vt.missing.slice(0, top)) {
                    log(`      no vouchers synced for "${m.name}"${m.parent ? ` (${m.parent})` : ''}`);
                }
                for (const s of vt.synced_only.slice(0, top)) {
                    log(`      ! "${s.name}" has ${s.synced} voucher(s) but NO type master`);
                }
            }
        }
    } finally { await db.destroy().catch(() => {}); }
    return results;
}

module.exports = { reconcileLicence };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i].startsWith('--')) args[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    }
    const licenseId = args.license != null && args.license !== true ? Number(args.license) : null;
    const companyId = args.company != null && args.company !== true ? Number(args.company) : null;

    (async () => {
        let dirty = 0;
        for (const t of await listTenantDbs({ licenseId })) {
            if (!(await databaseExists(t.dbName))) continue;
            console.log(`\n→ licence ${t.licenseId} "${t.holder}" (${t.dbName})`);
            const res = await reconcileLicence(t.dbName, { companyId, verbose: !!args.verbose });
            dirty += res.filter((r) => !r.clean).length;
        }
        // Non-zero exit so this can gate a deploy or fire an alert from cron.
        console.log(dirty ? `\n✗ ${dirty} company(ies) have discrepancies` : '\n✓ all companies reconcile');
        process.exit(dirty ? 1 : 0);
    })().catch((e) => { console.error('✗ reconcile failed:', e.message); process.exit(2); });
}
