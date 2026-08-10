'use strict';

/**
 * Controllers/Tenant/PartyItemsController.js
 *
 * "Items Sold" / "Items Purchased" for ONE party — what this customer has
 * bought from us, or what we have bought from this supplier, rolled up per
 * stock item. Reached from the party detail page.
 *
 * Lines come from the same two places the grouped registers read: the cloud's
 * own `invoice_items`, and Tally's `tally_inventory_entries` mirror for
 * vouchers that have no cloud item rows — so a voucher pushed to Tally and
 * pulled back is never counted twice.
 *
 * Read-only.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

const SIDES = {
    sold:      { partyCol: 'customer_id', invoiceType: 'sales',    returnType: 'Credit Note' },
    purchased: { partyCol: 'supplier_id', invoiceType: 'purchase', returnType: 'Debit Note' },
};

/**
 * GET /parties/:id/items?direction=sold|purchased&from=&to=
 *
 * Returns one row per item: quantity, value, the number of vouchers it
 * appeared on, and the last date it moved.
 */
async function partyItems(req, res) {
    const partyId = Number(req.params.id);
    const direction = String(req.query.direction || 'sold').trim().toLowerCase();
    const side = SIDES[direction];
    if (!side) return R.errorResponse(res, 'Unknown direction.', 422);
    if (!Number.isInteger(partyId) || partyId <= 0) {
        return R.errorResponse(res, 'Invalid party.', 422);
    }

    try {
        const companyId = req.companyId;
        const binds = [];
        const w = [];
        w.push('i.company_id = ?');   binds.push(companyId);
        w.push('i.type = ?');         binds.push(side.invoiceType);
        w.push(`i.${side.partyCol} = ?`); binds.push(partyId);
        w.push('i.deleted_at is null');
        // Returns are EXCLUDED, not netted: "Items Sold" answers what this
        // party took, and a register that quietly subtracts returns from it
        // reads as though the goods never shipped.
        w.push('(i.tally_voucher_type is null or i.tally_voucher_type <> ?)');
        binds.push(side.returnType);
        if (req.locationId != null) { w.push('i.location_id = ?'); binds.push(req.locationId); }
        if (req.query.from) { w.push('i.invoice_date >= ?'); binds.push(req.query.from); }
        if (req.query.to)   { w.push('i.invoice_date <= ?'); binds.push(req.query.to); }

        // Tally signs an inventory line by stock direction — a purchase is an
        // inflow and comes through negative — so the purchase side is flipped
        // to read positive, the same rule the purchase register uses.
        const tallySign = direction === 'purchased' ? -1 : 1;

        const sql = `
            with v as (
                select i.id, i.tally_guid, i.invoice_date
                  from invoices i
                 where ${w.join(' and ')}
            ), l as (
                select v.id, v.invoice_date,
                       coalesce(p.name, it.description) as item,
                       it.quantity as qty, it.amount as amount, it.unit as unit
                  from v
                  join invoice_items it on it.invoice_id = v.id
                  left join products p on p.id = it.product_id
                union all
                select v.id, v.invoice_date, e.item_name as item,
                       e.qty as qty, (e.amount * ${tallySign}) as amount, null as unit
                  from v
                  join tally_inventory_entries e
                    on e.company_id = ? and e.voucher_guid = v.tally_guid
                 where not exists (select 1 from invoice_items ii where ii.invoice_id = v.id)
            )
            select coalesce(l.item, '(No Item)') as name,
                   max(l.unit) as unit,
                   sum(l.qty) as qty,
                   sum(l.amount) as amount,
                   count(distinct l.id) as vouchers,
                   max(l.invoice_date) as last_date
              from l
             group by coalesce(l.item, '(No Item)')
             order by sum(l.amount) desc
        `;

        const result = await db.raw(sql, [...binds, companyId]);
        const money = (x) => Math.round((Number(x) || 0) * 100) / 100;
        const rows = (result.rows || []).map((r) => ({
            name: r.name,
            unit: r.unit || '',
            qty: money(r.qty),
            amount: money(r.amount),
            vouchers: Number(r.vouchers) || 0,
            last_date: r.last_date,
        }));

        return R.successResponse(res, {
            data: rows,
            meta: {
                direction,
                items: rows.length,
                total_qty: money(rows.reduce((s, r) => s + r.qty, 0)),
                total_amount: money(rows.reduce((s, r) => s + r.amount, 0)),
            },
        });
    } catch (err) {
        console.error(`partyItems(${direction}) error:`, err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { partyItems };
