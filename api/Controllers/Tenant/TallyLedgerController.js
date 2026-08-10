'use strict';

/**
 * api/Controllers/Tenant/TallyLedgerController.js
 *
 * Read-only views over the synced Tally chart of accounts — the Cash & Bank
 * screens and the dashboard's CASH / BANK / PAYABLES drill-downs.
 *
 * Balances are NOT read from tally_ledgers.closing_balance (a single as-of-last-
 * sync snapshot). They are replayed from tally_voucher_entries, which the agent
 * mirrors in full, so any date range gives a real opening and closing — see
 * Helpers/ledgerBalance.js.
 *
 * These tables carry no location_id, so company_id is the only tenant scope —
 * but they DO carry deleted_at, and it is load-bearing: what Tally deletes is
 * soft-deleted here, never removed. Masters are filtered with whereNull, and
 * postings through Helpers/tallyScope.js (which also drops cancelled and
 * optional vouchers, exactly as Tally's own registers do).
 *
 * Exports { list, statement }.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');
const { BUCKETS, resolveBuckets, accountingBalance } = require('../../Helpers/ledgerGroups');
const PARTY_BUCKETS = ['payables', 'receivables'];
const { periodBalance, drCr, isoDay } = require('../../Helpers/ledgerBalance');
const { liveVoucherEntries, liveInventoryEntries } = require('../../Helpers/tallyScope');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';
const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE     = 100;

function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_PER_PAGE;
    if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;
    return { page, perPage };
}

// Validate a 'YYYY-MM-DD' query param → the string, or null.
function parseDate(v) {
    const s = String(v == null ? '' : v).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * The ledger names belonging to one bucket, or null for "no bucket filter".
 * Returns [] when the bucket exists but this company has no such groups — the
 * caller must then return an empty page, not the whole chart of accounts.
 */
async function ledgerNamesInBucket(companyId, bucket) {
    const groups = await db('tally_groups').where('company_id', companyId)
        .whereNull('deleted_at')
        .select('name', 'parent', 'primary_group');
    const bucketOf = resolveBuckets(groups);

    const groupNames = [];
    for (const [name, b] of bucketOf.entries()) if (b === bucket) groupNames.push(name);
    return { groupNames, bucketOf };
}

/**
 * GET /tally/ledgers — the company's ledgers, optionally narrowed to one bucket
 * (cash | bank | payables | receivables) and scoped to a date range.
 *
 * Response rows carry the PERIOD balance: { opening, debit, credit, closing }
 * plus the Dr/Cr split the screens print. `meta.total_balance` is the page-
 * independent sum the "Total Amount" header shows.
 */
async function list(req, res) {
    try {
        const companyId = req.companyId;
        const { page, perPage } = parsePagination(req.query);
        const group  = String(req.query.group  || '').trim().toLowerCase();
        const search = String(req.query.search || '').trim();
        const from   = parseDate(req.query.from);
        const to     = parseDate(req.query.to);

        // whereNull('deleted_at') — a ledger deleted in Tally is soft-deleted by
        // the reconcile pass, never removed. Every read path has to exclude it or
        // the mirror keeps showing accounts that no longer exist in the books.
        let qb = db('tally_ledgers').where('company_id', companyId).whereNull('deleted_at');
        let bucketOf = null;

        if (BUCKETS.includes(group)) {
            const r = await ledgerNamesInBucket(companyId, group);
            bucketOf = r.bucketOf;
            qb = r.groupNames.length ? qb.whereIn('parent', r.groupNames) : qb.whereRaw('1 = 0');
        }

        if (search) {
            const like = `%${search}%`;
            qb = qb.where((b) => b.where('name', 'ilike', like).orWhere('parent', 'ilike', like));
        }

        const totalRow = await qb.clone().clearSelect().clearOrder().count('id as c').first();
        const total = Number(totalRow ? totalRow.c : 0);

        // ALL matching ledgers (not just this page) — the header total has to
        // cover the whole selection, and the balance replay needs their names.
        const allRows = await qb.clone().clearOrder()
            .select('id', 'name', 'parent', 'opening_balance', 'closing_balance');
        const names = allRows.map((r) => r.name);

        // One grouped read of every posting for those ledgers, bucketed by
        // ledger name — far cheaper than a query per ledger.
        const entriesBy = new Map();
        if (names.length) {
            const entries = await liveVoucherEntries(db, companyId)
                .whereIn('e.ledger_name', names)
                .select('e.ledger_name', 'e.voucher_date', 'e.amount', 'e.is_debit');
            for (const e of entries) {
                if (!entriesBy.has(e.ledger_name)) entriesBy.set(e.ledger_name, []);
                entriesBy.get(e.ledger_name).push(e);
            }
        }

        const balanceOf = new Map();
        let totalBalance = 0;
        for (const r of allRows) {
            const bal = periodBalance({
                // accountingBalance() flips Tally's inverted stored sign, so a
                // cash ledger opens Dr rather than Cr.
                opening: accountingBalance(r.opening_balance),
                entries: entriesBy.get(r.name) || [],
                from, to,
            });
            balanceOf.set(r.name, bal);
            totalBalance += bal.closing;
        }

        // Page AFTER computing the header total, biggest balance first — the
        // reference orders its Cash/Bank lists by size, not alphabetically.
        const paged = allRows
            .slice()
            .sort((a, b) => Math.abs(balanceOf.get(b.name).closing) - Math.abs(balanceOf.get(a.name).closing))
            .slice((page - 1) * perPage, page * perPage);

        const data = paged.map((r) => {
            const bal  = balanceOf.get(r.name);
            const shown = drCr(bal.closing);
            return {
                id:      r.id,
                name:    r.name,
                parent:  r.parent || '',
                bucket:  bucketOf ? (bucketOf.get(r.parent) || '') : '',
                opening: bal.opening,
                debit:   bal.debit,
                credit:  bal.credit,
                closing: bal.closing,
                balance: shown.amount,
                dc:      shown.dc,
            };
        });

        const totalShown = drCr(totalBalance);
        return R.successResponse(res, {
            data,
            meta: {
                total, page, per_page: perPage,
                range: (from && to) ? { from, to } : null,
                total_balance: totalBalance,
                total_amount:  totalShown.amount,
                total_dc:      totalShown.dc,
            },
        });
    } catch (err) {
        console.error('tallyLedgers.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /tally/ledgers/:name/statement — one ledger's voucher-wise statement for
 * a date range, with the opening/closing pair the footer prints.
 *
 * Query: from, to, voucher_type ('' = all), page, per_page.
 */
async function statement(req, res) {
    try {
        const companyId = req.companyId;
        const name = String(req.params.name || '').trim();
        if (!name) return R.errorResponse(res, 'Ledger not found.', 404);

        const { page, perPage } = parsePagination(req.query);
        const from  = parseDate(req.query.from);
        const to    = parseDate(req.query.to);
        const vType = String(req.query.voucher_type || '').trim();

        const ledger = await db('tally_ledgers')
            .where('company_id', companyId).whereNull('deleted_at')
            .whereRaw('lower(name) = ?', [name.toLowerCase()])
            .first('id', 'name', 'parent', 'opening_balance', 'closing_balance',
                'gstin', 'gst_reg_type', 'state', 'address', 'contact', 'email',
                'bank_name', 'bank_acc_no', 'ifsc');
        if (!ledger) return R.errorResponse(res, 'Ledger not found.', 404);

        // Every posting on this ledger — the opening replay needs the ones
        // BEFORE the range too, so the range filter is applied in memory.
        // `counter_ledger` is the OTHER side of each voucher — the party a bank
        // or cash row actually moved money with, which is the column that makes
        // a statement readable. It is taken as the largest posting on the same
        // voucher that is not this ledger and not a round-off balancing entry;
        // `v.party_ledger` alone will not do, because Tally leaves it empty on
        // most receipt and payment vouchers.
        const allEntries = await liveVoucherEntries(db, companyId)
            .whereRaw('lower(e.ledger_name) = ?', [ledger.name.toLowerCase()])
            .select('e.voucher_guid', 'e.voucher_no', 'e.voucher_type', 'e.voucher_date',
                'e.amount', 'e.is_debit')
            .select('v.reference as reference_no')
            .select(db.raw(`coalesce(
                nullif(v.party_ledger, ''),
                (select o.ledger_name from tally_voucher_entries o
                  where o.company_id = e.company_id
                    and o.voucher_guid = e.voucher_guid
                    and lower(o.ledger_name) <> lower(e.ledger_name)
                    and o.ledger_name !~* 'round'
                  order by abs(o.amount) desc limit 1)
            ) as counter_ledger`));

        const balance = periodBalance({
            opening: accountingBalance(ledger.opening_balance),
            entries: allEntries, from, to,
        });

        // The rows the table shows: in-range, optionally one voucher type.
        // isoDay() normalises pg's Date objects — comparing String(Date) against
        // 'YYYY-MM-DD' silently matches nothing.
        const withinRange = (e) => {
            const d = isoDay(e.voucher_date);
            if (from && d && d < from) return false;
            if (to   && d && d > to)   return false;
            return true;
        };

        const inRange = allEntries
            .filter((e) => withinRange(e)
                && (!vType || String(e.voucher_type || '') === vType))
            .sort((a, b) => isoDay(b.voucher_date).localeCompare(isoDay(a.voucher_date)));

        // The voucher-type filter's own options come from the UNFILTERED range,
        // so choosing one never empties the dropdown that produced it.
        const types = [...new Set(allEntries.filter(withinRange)
            .map((e) => e.voucher_type)
            .filter(Boolean))].sort();

        const rows = inRange.slice((page - 1) * perPage, page * perPage).map((e) => {
            const mag = Math.abs(Number(e.amount || 0));
            return {
                voucher_guid: e.voucher_guid,
                voucher_no:   e.voucher_no || '',
                voucher_type: e.voucher_type || '',
                voucher_date: e.voucher_date,
                counter_ledger: e.counter_ledger || '',
                reference_no: e.reference_no || '',
                amount:       mag,
                dc:           e.is_debit ? 'Dr' : 'Cr',
            };
        });

        const open = drCr(balance.opening);
        const close = drCr(balance.closing);

        return R.successResponse(res, {
            ledger: {
                name:   ledger.name,
                parent: ledger.parent || '',
                gstin:  ledger.gstin || '',
                gst_reg_type: ledger.gst_reg_type || '',
                state:  ledger.state || '',
                address: ledger.address || '',
                contact: ledger.contact || '',
                email:  ledger.email || '',
                bank_name: ledger.bank_name || '',
                bank_acc_no: ledger.bank_acc_no || '',
                ifsc: ledger.ifsc || '',
            },
            balance: {
                opening: balance.opening, closing: balance.closing,
                debit: balance.debit, credit: balance.credit,
                opening_amount: open.amount, opening_dc: open.dc,
                closing_amount: close.amount, closing_dc: close.dc,
            },
            voucher_types: types,
            data: rows,
            meta: {
                total: inRange.length, page, per_page: perPage,
                range: (from && to) ? { from, to } : null,
            },
        });
    } catch (err) {
        console.error('tallyLedgers.statement error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /tally/vouchers/:guid — one Tally-origin voucher: its complete double
 * entry plus any item movement.
 *
 * READ-ONLY by design. These rows are mirrored FROM Tally; we do not own them,
 * so there is no edit path here — offering one would imply changes flow back,
 * which they do not. A voucher that ALSO exists as a cloud invoice is reported
 * via `invoice_id` so the web tier can send the user to the editable view
 * instead.
 */
async function voucher(req, res) {
    try {
        const companyId = req.companyId;
        const guid = String(req.params.guid || '').trim();
        if (!guid) return R.errorResponse(res, 'Voucher not found.', 404);

        const [entries, items, asInvoice] = await Promise.all([
            // Scoped, so a voucher deleted/cancelled in Tally 404s here instead of
            // rendering a detail page for a document that no longer exists.
            liveVoucherEntries(db, companyId).where('e.voucher_guid', guid)
                .select('e.ledger_name', 'e.amount', 'e.is_debit', 'e.voucher_no',
                    'e.voucher_type', 'e.voucher_date')
                .orderBy('e.id', 'asc'),
            liveInventoryEntries(db, companyId).where('e.voucher_guid', guid)
                .select('e.item_name', 'e.qty', 'e.rate', 'e.amount', 'e.godown')
                .orderBy('e.id', 'asc'),
            db('invoices').where({ company_id: companyId, tally_guid: guid })
                .whereNull('deleted_at').first('id', 'type'),
        ]);

        if (!entries.length) return R.errorResponse(res, 'Voucher not found.', 404);

        const head = entries[0];

        // Dr and Cr are both positive columns; the stored sign is Tally's and
        // is not used here (see Helpers/ledgerBalance for why).
        const rows = entries.map((e) => ({
            ledger: e.ledger_name,
            amount: Math.abs(Number(e.amount || 0)),
            dc:     e.is_debit ? 'Dr' : 'Cr',
        }));
        const totalDebit  = rows.filter((r) => r.dc === 'Dr').reduce((s, r) => s + r.amount, 0);
        const totalCredit = rows.filter((r) => r.dc === 'Cr').reduce((s, r) => s + r.amount, 0);

        // The party line: the biggest entry that is not a tax / round-off
        // ledger. Tally has no explicit party field on the entry rows.
        const NON_PARTY = /gst|round|cess|tax|discount/i;
        const party = rows.filter((r) => !NON_PARTY.test(r.ledger))
            .sort((a, b) => b.amount - a.amount)[0];

        return R.successResponse(res, {
            voucher: {
                guid,
                voucher_no:   head.voucher_no || '',
                voucher_type: head.voucher_type || '',
                voucher_date: head.voucher_date,
                party:        party ? party.ledger : '',
                total_debit:  totalDebit,
                total_credit: totalCredit,
            },
            entries: rows,
            items: items.map((it, i) => ({
                sr:     i + 1,
                name:   it.item_name,
                qty:    Number(it.qty || 0),
                rate:   Number(it.rate || 0),
                amount: Math.abs(Number(it.amount || 0)),
                godown: it.godown || '',
            })),
            // Non-null when this voucher also exists as an editable cloud invoice.
            invoice: asInvoice ? { id: asInvoice.id, type: asInvoice.type } : null,
        });
    } catch (err) {
        console.error('tallyLedgers.voucher error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /tally/ledgers/sales-options — the company's SALES ledgers (Tally group
 * "Sales Accounts") as lightweight {id,name} options for the Quotation
 * form's "Ledger Type" combobox. Deliberately NOT the bucketed list() path —
 * sales ledgers are not one of the cash/bank/payables/receivables reserved
 * buckets in ledgerGroups.js, so this reads tally_ledgers.parent directly.
 */
async function salesLedgerOptions(req, res) {
    try {
        const companyId = req.companyId;
        const rows = await db('tally_ledgers')
            .where('company_id', companyId).whereNull('deleted_at')
            .whereRaw('lower(parent) = ?', ['sales accounts'])
            .orderBy('name', 'asc')
            .select('id', 'name', 'parent', 'tax_type', 'tax_classification');
        return R.successResponse(res, { data: rows });
    } catch (err) {
        console.error('tallyLedgers.salesLedgerOptions error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /tally/price-levels — the company's Tally price levels, as options for
 * the voucher forms' "Price Level" picker.
 *
 * A price level is Tally's per-customer-tier rate card ("Wholesale",
 * "Retail"). Choosing one on a voucher is what makes the line rate come out
 * as that tier's rate rather than the item's standard price. Empty when the
 * company does not use price levels — which is not an error, just a company
 * that prices everyone the same.
 */
async function priceLevelOptions(req, res) {
    try {
        const rows = await db('tally_price_levels')
            .where('company_id', req.companyId).whereNull('deleted_at')
            .orderBy('name', 'asc')
            .select('id', 'name');
        return R.successResponse(res, { data: rows });
    } catch (err) {
        console.error('tallyLedgers.priceLevelOptions error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /tally/price-list?level=&item= — the rate a price level sets.
 *
 * Returns the matching price-list rows so the form can apply a tier rate when
 * an item is picked. Filtered by level and/or item; the caller decides which
 * of the two it knows.
 */
async function priceListRates(req, res) {
    try {
        const level = String(req.query.level || '').trim();
        const item  = String(req.query.item || '').trim();
        let qb = db('tally_price_lists')
            .where('company_id', req.companyId).whereNull('deleted_at');
        if (level) qb = qb.whereRaw('lower(price_level) = ?', [level.toLowerCase()]);
        if (item)  qb = qb.whereRaw('lower(stock_item) = ?', [item.toLowerCase()]);
        const rows = await qb
            .orderBy('stock_item', 'asc').orderBy('from_qty', 'asc')
            .select('stock_item', 'price_level', 'from_qty', 'to_qty', 'rate', 'discount');
        return R.successResponse(res, {
            data: rows.map((r) => ({
                stock_item: r.stock_item,
                price_level: r.price_level,
                // A slab applies from from_qty up to to_qty; nulls mean the
                // slab is open-ended on that side.
                from_qty: r.from_qty != null ? Number(r.from_qty) : null,
                to_qty: r.to_qty != null ? Number(r.to_qty) : null,
                rate: r.rate != null ? Number(r.rate) : null,
                discount: r.discount != null ? Number(r.discount) : null,
            })),
        });
    } catch (err) {
        console.error('tallyLedgers.priceListRates error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /tally/ledger-groups — party-eligible Tally groups (the Sundry Debtors /
 * Sundry Creditors ancestry) as {id,name,parent} options for the customer
 * form's "Ledger Group" dropdown. Reuses ledgerGroups.js's parent-chain walk
 * (resolveBuckets) — the same classification the Cash & Bank screens use —
 * rather than inventing a second definition of "party group". No group sync
 * yet → empty data, not a 500.
 */
async function ledgerGroupOptions(req, res) {
    try {
        const companyId = req.companyId;
        const groups = await db('tally_groups').where('company_id', companyId)
            .whereNull('deleted_at')
            .select('id', 'name', 'parent', 'primary_group');
        const bucketOf = resolveBuckets(groups);
        const data = groups
            .filter((g) => PARTY_BUCKETS.includes(bucketOf.get(g.name)))
            .map((g) => ({ id: g.id, name: g.name, parent: g.parent || '' }))
            .sort((a, b) => a.name.localeCompare(b.name));
        return R.successResponse(res, { data });
    } catch (err) {
        console.error('tallyLedgers.ledgerGroupOptions error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * GET /tally/ledgers/purchase-options — the company's PURCHASE ledgers (Tally
 * group "Purchase Accounts") as lightweight {id,name} options for the
 * Purchase Order form's "Ledger Type" combobox. Same shape/pattern as
 * salesLedgerOptions above, just the other group name — not one of the
 * bucketed list() path's reserved buckets either, so this reads
 * tally_ledgers.parent directly too.
 */
async function purchaseLedgerOptions(req, res) {
    try {
        const companyId = req.companyId;
        const rows = await db('tally_ledgers')
            .where('company_id', companyId).whereNull('deleted_at')
            .whereRaw('lower(parent) = ?', ['purchase accounts'])
            .orderBy('name', 'asc')
            .select('id', 'name', 'parent', 'tax_type', 'tax_classification');
        return R.successResponse(res, { data: rows });
    } catch (err) {
        console.error('tallyLedgers.purchaseLedgerOptions error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = {
    list, statement, voucher,
    salesLedgerOptions, ledgerGroupOptions, purchaseLedgerOptions,
    priceLevelOptions, priceListRates,
};
