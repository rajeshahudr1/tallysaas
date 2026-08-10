'use strict';

/**
 * Helpers/voucherRegister.js
 *
 * ONE grouped-register implementation for every voucher family.
 *
 * The register screens (Sales, Purchase, Credit/Debit Note, Sales/Purchase
 * Order, Delivery/Receipt Note, Receipt, Payment) all offer the same thing:
 * the period's vouchers regrouped by Ledger, Ledger Group, Voucher Type,
 * Stock Item, Stock Group or Stock Category, with a Gross/Net basis. Only the
 * TABLES differ, so the families pass a config and share the SQL — otherwise
 * ten copies drift apart the first time one of them is fixed.
 *
 * Two groupings are HEADER-level (one row per voucher, so the header total
 * sums cleanly) and three are LINE-level (item rows, which also carry a
 * quantity). Voucher Type is header-level too.
 *
 * Party resolution, in order:
 *   1. the linked customer / supplier master, then
 *   2. a `ledger_name` column if the family has one, then
 *   3. the SYNCED voucher's counter-party ledger, taken as the largest
 *      posting by magnitude. Tally's `is_debit` flag is not consistently
 *      oriented across voucher classes in the pulled data, so magnitude is
 *      the reliable signal, not side.
 *
 * Stock lines come from the family's own items table and — for the two
 * families Tally mirrors into `tally_inventory_entries` (sales/purchase and
 * their return notes) — from that mirror, but only for vouchers that have no
 * cloud item rows, so a cloud voucher pushed to Tally is never counted twice.
 */

const GROUP_SPECS = {
    ledger:         { level: 'header', label: 'Ledger' },
    ledger_group:   { level: 'header', label: 'Ledger Group' },
    voucher_type:   { level: 'header', label: 'Voucher Type' },
    stock_item:     { level: 'line',   label: 'Stock Item' },
    stock_group:    { level: 'line',   label: 'Stock Group' },
    stock_category: { level: 'line',   label: 'Stock Category' },
};

const STOCK_GROUPS = ['stock_item', 'stock_group', 'stock_category'];

/**
 * @typedef {Object} RegisterConfig
 * @property {string}  table         e.g. 'sales_orders'
 * @property {string}  dateCol       e.g. 'order_date'
 * @property {string}  amountCol     'total' | 'amount'
 * @property {string}  partyCol      'customer_id' | 'supplier_id' | null
 * @property {string}  partyTable    'customers' | 'suppliers' | null
 * @property {string}  defaultType   label used when tally_voucher_type is null
 * @property {string}  [itemsTable]  e.g. 'sales_order_items' (omit → no stock views)
 * @property {string}  [itemsFk]     e.g. 'sales_order_id'
 * @property {string}  [ledgerNameCol] e.g. 'ledger_name'
 * @property {string}  [returnType]  voucher type that Net subtracts
 * @property {boolean} [tallyInventory] read tally_inventory_entries too
 * @property {number}  [tallyAmountSign] flip Tally's line amounts (purchase side)
 * @property {Object}  [where]       extra equality filters, e.g. { type: 'sales' }
 * @property {boolean} [approvalGate] apply the pending/draft/rejected exclusion
 */

/** Does this family offer the Stock groupings at all? */
function hasStock(cfg) {
    return !!(cfg.itemsTable && cfg.itemsFk);
}

/** The groupings a family actually supports, in display order. */
function groupsFor(cfg) {
    return Object.keys(GROUP_SPECS)
        .filter((k) => hasStock(cfg) || !STOCK_GROUPS.includes(k));
}

/**
 * Build the scope CTE: one row per voucher with its party name and Gross/Net
 * sign. Returns { sql, binds } — binds are in the order the SQL text uses.
 */
function scopeSql(db, req, cfg, mode) {
    const T = cfg.table;
    const selectBinds = [];
    const whereBinds = [];
    const w = [];

    w.push(`${T}.company_id = ?`); whereBinds.push(req.companyId);
    w.push(`${T}.deleted_at is null`);
    for (const [k, v] of Object.entries(cfg.where || {})) {
        w.push(`${T}.${k} = ?`); whereBinds.push(v);
    }
    // Not every family carries a location (payments do not), so a
    // location-scoped user simply sees the whole company's vouchers there —
    // the same behaviour those screens already had.
    if (req.locationId != null && cfg.locationCol !== false) {
        w.push(`${T}.location_id = ?`); whereBinds.push(req.locationId);
    }
    if (req.isSalesman) { w.push(`${T}.created_by = ?`); whereBinds.push(req.user.sub); }
    if (req.isCustomerUser && cfg.partyCol === 'customer_id') {
        w.push(`${T}.customer_id = ?`); whereBinds.push(req.customerId);
    }
    if (req.query.date_from) { w.push(`${T}.${cfg.dateCol} >= ?`); whereBinds.push(req.query.date_from); }
    if (req.query.date_to)   { w.push(`${T}.${cfg.dateCol} <= ?`); whereBinds.push(req.query.date_to); }

    if (cfg.approvalGate) {
        const approval = String(req.query.approval || '').trim();
        if (approval === 'all') {
            /* no approval filter */
        } else if (approval) {
            w.push(`${T}.approval_status = ?`); whereBinds.push(approval);
        } else {
            w.push(`(${T}.approval_status not in ('pending','draft','rejected') or ${T}.approval_status is null)`);
        }
    }

    // The voucher-type column, where the family has one. `payments` does not,
    // so its type is read from the synced voucher header instead of being
    // hard-coded — a company whose receipts use custom Tally voucher classes
    // still sees those class names on the Voucher Type view.
    const typeCol = cfg.typeCol === undefined ? 'tally_voucher_type' : cfg.typeCol;
    const typeSql = typeCol
        ? `${T}.${typeCol}`
        : `(select tv.voucher_type from tally_vouchers tv
             where tv.company_id = ? and tv.guid = ${T}.tally_guid limit 1)`;

    // Gross drops the return vouchers; Net keeps them so `sgn` can subtract.
    let sgn = '1';
    if (cfg.returnType && typeCol) {
        if (mode === 'net') {
            sgn = `case when ${T}.${typeCol} = ? then -1 else 1 end`;
        } else {
            w.push(`(${T}.${typeCol} is null or ${T}.${typeCol} <> ?)`);
            whereBinds.push(cfg.returnType);
        }
    }

    // Party: master name → the family's own ledger_name column → the synced
    // voucher's largest posting.
    const partyBits = [];
    if (cfg.partyTable) partyBits.push('pm.name');
    if (cfg.ledgerNameCol) partyBits.push(`nullif(${T}.${cfg.ledgerNameCol}, '')`);
    partyBits.push(`(select e.ledger_name from tally_voucher_entries e
                      where e.company_id = ? and e.voucher_guid = ${T}.tally_guid
                      order by abs(e.amount) desc limit 1)`);
    const partyExpr = `coalesce(${partyBits.join(', ')}, '(No Ledger)')`;

    // SELECT-list binds run before the WHERE binds in the final statement, in
    // the order the text below uses them: voucher-type subquery (only when the
    // family has no type column), the default type, the party subquery, then
    // the Net sign.
    if (!typeCol) selectBinds.push(req.companyId);
    selectBinds.push(cfg.defaultType);
    selectBinds.push(req.companyId);
    if (cfg.returnType && typeCol && mode === 'net') selectBinds.push(cfg.returnType);

    const partyJoin = cfg.partyTable
        ? `left join ${cfg.partyTable} pm on pm.id = ${T}.${cfg.partyCol}`
        : '';

    const sql = `
        select
            ${T}.id,
            ${T}.${cfg.amountCol} as amount,
            ${T}.tally_guid,
            coalesce(${typeSql}, ?) as vch_type,
            ${partyExpr} as party,
            (${sgn}) as sgn
        from ${cfg.table}
        ${partyJoin}
        where ${w.join(' and ')}
    `;
    return { sql, binds: [...selectBinds, ...whereBinds] };
}

/**
 * Run one grouped view.
 * @returns {{ rows: Array, meta: Object }}
 */
async function groupedRegister(db, req, cfg) {
    const by = String(req.query.by || '').trim().toLowerCase();
    const spec = GROUP_SPECS[by];
    if (!spec) { const e = new Error('Unknown grouping.'); e.status = 422; throw e; }
    if (STOCK_GROUPS.includes(by) && !hasStock(cfg)) {
        const e = new Error('This register has no stock lines.'); e.status = 422; throw e;
    }
    const mode = String(req.query.mode || 'gross').trim().toLowerCase() === 'net' ? 'net' : 'gross';

    const scope = scopeSql(db, req, cfg, mode);
    let binds = [...scope.binds];
    let sql;

    if (spec.level === 'header') {
        let keyExpr;
        let extraJoin = '';
        if (by === 'ledger') {
            keyExpr = 'v.party';
        } else if (by === 'ledger_group') {
            // The TALLY ledger master carries the real group. `customer_groups`
            // is a cloud-only table the sync never fills, so reading it here
            // would report every voucher as "(No Group)".
            extraJoin = 'left join tally_ledgers tl on tl.company_id = ? and lower(tl.name) = lower(v.party)';
            keyExpr = "coalesce(tl.parent, '(No Group)')";
        } else {
            keyExpr = 'v.vch_type';
        }
        sql = `
            with v as (${scope.sql})
            select ${keyExpr} as name,
                   sum(v.amount * v.sgn) as amount,
                   null::numeric as qty,
                   count(v.id) as count
            from v ${extraJoin}
            group by ${keyExpr}
            order by ${keyExpr} asc
        `;
        if (by === 'ledger_group') binds = [...binds, req.companyId];
    } else {
        const IT = cfg.itemsTable;
        const FK = cfg.itemsFk;
        // Cloud item rows always count. Tally's mirror is added only for the
        // families Tally actually mirrors, and only for vouchers with no cloud
        // rows — otherwise a pushed-then-repulled voucher counts twice.
        //
        // Tally signs an inventory line by stock DIRECTION (a sale is an
        // outflow, positive; a purchase an inflow, negative), so a purchase
        // register flips them to read positive. Its return lines carry a
        // negative amount but a POSITIVE qty, so amount is taken as-is and
        // only qty is signed — multiplying the amount by sgn would flip a
        // return back to positive and make Net read higher than Gross.
        const tallySign = cfg.tallyAmountSign === -1 ? -1 : 1;
        const tallyBranch = cfg.tallyInventory ? `
            union all
            select v.id, e.item_name as item,
                   (e.qty * v.sgn) as qty,
                   (e.amount * ${tallySign}) as amount
              from v
              join tally_inventory_entries e
                on e.company_id = ? and e.voucher_guid = v.tally_guid
             where not exists (select 1 from ${IT} it where it.${FK} = v.id)
        ` : '';
        const linesSql = `
            select v.id,
                   coalesce(p.name, it.description) as item,
                   (it.quantity * v.sgn) as qty,
                   (it.amount * v.sgn) as amount
              from v
              join ${IT} it on it.${FK} = v.id
              left join products p on p.id = it.product_id
            ${tallyBranch}
        `;

        let keyExpr;
        let extraJoin = '';
        if (by === 'stock_item') {
            keyExpr = "coalesce(l.item, '(No Item)')";
        } else if (by === 'stock_group') {
            // Tally's stock groups sync into `categories`; a synced line only
            // carries the item NAME, so the product master is matched by name.
            // An item in no group is filed under Tally's root group "Primary".
            extraJoin = `
                left join products p2 on p2.company_id = ? and lower(p2.name) = lower(l.item)
                left join categories cat on cat.id = p2.category_id`;
            keyExpr = "coalesce(cat.name, 'Primary')";
        } else {
            // Tally keeps stock GROUP and stock CATEGORY as two independent
            // classifications; we sync only the group tree, so on a flat tree
            // category reads the same as group.
            extraJoin = `
                left join products p2 on p2.company_id = ? and lower(p2.name) = lower(l.item)
                left join categories cat on cat.id = p2.category_id
                left join categories pcat on pcat.id = cat.parent_id`;
            keyExpr = "coalesce(pcat.name, cat.name, 'Primary')";
        }

        sql = `
            with v as (${scope.sql}), l as (${linesSql})
            select ${keyExpr} as name,
                   sum(l.amount) as amount,
                   sum(l.qty) as qty,
                   count(distinct l.id) as count
            from l ${extraJoin}
            group by ${keyExpr}
            order by ${keyExpr} asc
        `;
        if (cfg.tallyInventory) binds = [...binds, req.companyId];
        if (by !== 'stock_item') binds = [...binds, req.companyId];
    }

    const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const result = await db.raw(sql, binds);
    const rows = (result.rows || []).map((r) => ({
        name: r.name,
        amount: money(r.amount),
        qty: spec.level === 'line' ? Math.round((Number(r.qty) || 0) * 100) / 100 : null,
        count: Number(r.count) || 0,
    }));

    return {
        rows,
        meta: {
            by, mode, label: spec.label, level: spec.level,
            grand_total: money(rows.reduce((s, r) => s + r.amount, 0)),
            groups: rows.length,
            has_qty: spec.level === 'line',
            has_stock: hasStock(cfg),
            // Grouped views are reconstructed from the vouchers themselves; a
            // Month register may instead prefer Tally's own register snapshot,
            // so the two can differ slightly on historical months.
            source: 'cloud',
        },
    };
}

module.exports = { GROUP_SPECS, STOCK_GROUPS, groupedRegister, groupsFor, hasStock };
