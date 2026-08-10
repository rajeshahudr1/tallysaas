'use strict';

/**
 * api/Helpers/stockMovement.js
 *
 * ONE definition of "how much of this item is on hand", shared by every screen
 * and every guard that needs it.
 *
 * This lives here because it did not, once: the Items screen computed closing
 * stock as opening + received − issued, while the sales-invoice stock guard
 * compared against products.opening_stock. Those are different numbers — a
 * synced item routinely opens at 0 and is very much on the shelf — so the
 * server could refuse an invoice for stock the screen was showing as
 * available, with no way for the user to reconcile the two.
 *
 * Direction comes from the VOUCHER, never from the sign of the quantity: Tally
 * records an inventory quantity as a positive magnitude on both sides.
 *   in  = Purchase, Receipt Note, Credit Note (a sales return coming BACK IN)
 *   out = Sales, Delivery Note, Debit Note (a purchase return going BACK OUT)
 * `i.type` is consulted as well because custom sales classes (RETAIL CASH
 * SALES and the like) do not call themselves "Sales".
 *
 * company_id is grouped and joined on rather than bound as a parameter: the
 * crud factory calls baseQuery() without the request, and a tenant database
 * can hold more than one company — dropping the company from the key would let
 * one company's movement leak into another's closing stock.
 */

const MOVEMENT_SUBQUERY = `
    select e.company_id, lower(e.item_name) as item_key,
           sum(case when coalesce(i.tally_voucher_type,'') in ('Purchase','Receipt Note','Credit Note')
                     or i.type = 'purchase' then e.qty else 0 end) as in_qty,
           sum(case when coalesce(i.tally_voucher_type,'') in ('Purchase','Receipt Note','Credit Note')
                     or i.type = 'purchase' then abs(e.amount) else 0 end) as in_amount,
           sum(case when coalesce(i.tally_voucher_type,'') in ('Sales','Delivery Note','Debit Note')
                     or i.type = 'sales' then e.qty else 0 end) as out_qty
      from tally_inventory_entries e
      join invoices i on i.company_id = e.company_id and i.tally_guid = e.voucher_guid
     where i.deleted_at is null
     group by e.company_id, lower(e.item_name)
`;

/**
 * Closing stock over the joined `mv` aggregate. `alias` is the products table's
 * alias at the call site ('products' in the list query, 'p' in the guard).
 */
function closingStockSql(alias = 'products') {
    return `(${alias}.opening_stock + coalesce(mv.in_qty, 0) - coalesce(mv.out_qty, 0))`;
}

/**
 * Average rate we actually paid. NULL (not 0) when the item has never been
 * purchased — a zero here would read as "we get it free".
 */
const AVG_PURCHASE_RATE_SQL =
    '(case when coalesce(mv.in_qty, 0) > 0 then mv.in_amount / mv.in_qty else null end)';

module.exports = { MOVEMENT_SUBQUERY, closingStockSql, AVG_PURCHASE_RATE_SQL };
