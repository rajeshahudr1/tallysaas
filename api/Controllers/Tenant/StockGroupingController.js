'use strict';

/**
 * Controllers/Tenant/StockGroupingController.js
 *
 * The Items screen's grouped views — closing stock and its value rolled up by
 * Stock Group, Stock Category or Godown, instead of item by item.
 *
 * Closing stock per item is the same figure the Items list shows: opening
 * stock plus everything received, less everything issued, with direction taken
 * from the VOUCHER (Tally writes an inventory quantity as a positive magnitude
 * on both sides). Value is closing quantity × the item's average purchase rate,
 * which is how Tally values stock at cost.
 *
 * Godown is the exception: a godown split only exists on the movement rows, so
 * that view reports the movement per godown rather than a per-item closing
 * balance — opening stock has no godown attached to it and cannot be split.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

const IN_TYPES  = "('Purchase','Receipt Note','Credit Note')";
const OUT_TYPES = "('Sales','Delivery Note','Debit Note')";

// Per-item movement, aggregated once. `i.type` is consulted alongside the Tally
// voucher-type string because custom sales classes (RETAIL CASH SALES and the
// like) do not call themselves "Sales".
const MOVEMENT = `
    select e.company_id, lower(e.item_name) as item_key,
           sum(case when coalesce(i.tally_voucher_type,'') in ${IN_TYPES}
                     or i.type = 'purchase' then e.qty else 0 end) as in_qty,
           sum(case when coalesce(i.tally_voucher_type,'') in ${IN_TYPES}
                     or i.type = 'purchase' then abs(e.amount) else 0 end) as in_amount,
           sum(case when coalesce(i.tally_voucher_type,'') in ${OUT_TYPES}
                     or i.type = 'sales' then e.qty else 0 end) as out_qty
      from tally_inventory_entries e
      join invoices i on i.company_id = e.company_id and i.tally_guid = e.voucher_guid
     where i.deleted_at is null
     group by e.company_id, lower(e.item_name)
`;

const GROUPINGS = {
    // An item filed under no category sits in Tally's root stock group.
    group:    { label: 'Stock Group',    expr: "coalesce(cat.name, 'Primary')" },
    // Tally keeps stock GROUP and stock CATEGORY as two independent
    // classifications; we sync only the group tree, so on a flat tree the
    // category view reports the same buckets as the group view.
    category: { label: 'Stock Category', expr: "coalesce(pcat.name, cat.name, 'Primary')" },
};

/**
 * GET /items/grouped?by=group|category|godown
 */
async function grouped(req, res) {
    const by = String(req.query.by || 'group').trim().toLowerCase();
    try {
        if (by === 'godown') return await byGodown(req, res);
        const spec = GROUPINGS[by];
        if (!spec) return R.errorResponse(res, 'Unknown grouping.', 422);

        const sql = `
            with mv as (${MOVEMENT})
            select ${spec.expr} as name,
                   count(p.id) as items,
                   sum(p.opening_stock + coalesce(mv.in_qty,0) - coalesce(mv.out_qty,0)) as closing_qty,
                   sum(
                     (p.opening_stock + coalesce(mv.in_qty,0) - coalesce(mv.out_qty,0))
                     * case when coalesce(mv.in_qty,0) > 0 then mv.in_amount / mv.in_qty
                            else p.purchase_price end
                   ) as closing_value
              from products p
              left join mv on mv.company_id = p.company_id and mv.item_key = lower(p.name)
              left join categories cat on cat.id = p.category_id
              left join categories pcat on pcat.id = cat.parent_id
             where p.company_id = ? and p.deleted_at is null
             group by ${spec.expr}
             order by ${spec.expr} asc
        `;
        const result = await db.raw(sql, [req.companyId]);
        return respond(res, result.rows, { by, label: spec.label });
    } catch (err) {
        console.error(`stockGrouping.grouped(${by}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

/**
 * Godown-wise MOVEMENT. Deliberately not a closing balance: opening stock is
 * recorded against the item, not against a godown, so splitting it would mean
 * inventing a distribution. Reporting the movement is the honest figure.
 */
async function byGodown(req, res) {
    const sql = `
        select coalesce(nullif(trim(e.godown), ''), '(No Godown)') as name,
               count(distinct e.item_name) as items,
               sum(case when coalesce(i.tally_voucher_type,'') in ${IN_TYPES}
                         or i.type = 'purchase' then e.qty else 0 end)
             - sum(case when coalesce(i.tally_voucher_type,'') in ${OUT_TYPES}
                         or i.type = 'sales' then e.qty else 0 end) as closing_qty,
               sum(case when coalesce(i.tally_voucher_type,'') in ${IN_TYPES}
                         or i.type = 'purchase' then abs(e.amount) else 0 end)
             - sum(case when coalesce(i.tally_voucher_type,'') in ${OUT_TYPES}
                         or i.type = 'sales' then abs(e.amount) else 0 end) as closing_value
          from tally_inventory_entries e
          join invoices i on i.company_id = e.company_id and i.tally_guid = e.voucher_guid
         where e.company_id = ? and i.deleted_at is null
         group by coalesce(nullif(trim(e.godown), ''), '(No Godown)')
         order by 1 asc
    `;
    const result = await db.raw(sql, [req.companyId]);
    return respond(res, result.rows, {
        by: 'godown', label: 'Godown',
        // Flagged so the UI can label the column honestly rather than calling
        // a movement figure a closing balance.
        movement_only: true,
    });
}

function respond(res, rows, meta) {
    const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const out = (rows || []).map((r) => ({
        name: r.name,
        items: Number(r.items) || 0,
        closing_qty: money(r.closing_qty),
        closing_value: money(r.closing_value),
    }));
    return R.successResponse(res, {
        data: out,
        meta: {
            ...meta,
            groups: out.length,
            total_qty: money(out.reduce((s, r) => s + r.closing_qty, 0)),
            total_value: money(out.reduce((s, r) => s + r.closing_value, 0)),
        },
    });
}

module.exports = { grouped };
