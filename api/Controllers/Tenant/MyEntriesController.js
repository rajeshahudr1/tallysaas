'use strict';

/**
 * api/Controllers/Tenant/MyEntriesController.js
 *
 * "My Vouchers" — GET /my/vouchers. A single, read-only, company-scoped
 * roll-up of every voucher family the CURRENT user (req.user.sub) created,
 * newest first, paginated. Each family lives in its own table with its own
 * column names, so this is NOT one SQL query with a shared schema — it is a
 * `UNION ALL` of per-table subqueries that each project the SAME five
 * columns (kind, label, id/voucher_no/date/party/amount/status), built from
 * `VOUCHER_SOURCES` below.
 *
 * `payments`/`receipts` and sales/purchase `invoices` are really ONE
 * physical table each (discriminated by a `type` column) — see
 * PaymentController / InvoiceController — so they appear here as ONE source
 * per table (not one per voucher kind), with `kind`/`label` computed PER ROW
 * from that type column. `quotations`, `sales_orders`, `purchase_orders`,
 * `delivery_notes`, `receipt_notes` and `journals` are true 1:1 tables, so
 * their kind/label are fixed per source.
 *
 * Every subquery is scoped to `company_id = req.companyId`,
 * `created_by = req.user.sub` and `deleted_at IS NULL` — a user can only
 * ever see what THEY made, in THIS company, still live.
 */

const db = require('../../config/db').db;
const R  = require('../../Helpers/response');

const OOPS_MSG = 'Oops..Something went wrong. Please try again.';

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE     = 100;

/**
 * VOUCHER_SOURCES — one entry per underlying TABLE (see header comment for
 * why payments/invoices are single entries covering two voucher kinds each).
 * Every entry needs { table, label, dateColumn, noColumn } — `myEntries.test.js`
 * reads this shape directly. `build(qb, req)` returns the actual knex query
 * for that source, already projecting the common 8-column shape UNION ALL
 * needs: kind, label, id, voucher_no, date, party, amount, status.
 */
const VOUCHER_SOURCES = [
    {
        table: 'quotations', label: 'Quotation', dateColumn: 'quotation_date', noColumn: 'quotation_no',
        build(req) {
            return db('quotations')
                .leftJoin('customers', 'customers.id', 'quotations.customer_id')
                .where('quotations.company_id', req.companyId)
                .where('quotations.created_by', req.user.sub)
                .whereNull('quotations.deleted_at')
                .select(
                    db.raw("'quotation' as kind"), db.raw("'Quotation' as label"),
                    'quotations.id as id', 'quotations.quotation_no as voucher_no',
                    'quotations.quotation_date as date', 'customers.name as party',
                    'quotations.total as amount', 'quotations.quote_status as status',
                );
        },
    },
    {
        table: 'sales_orders', label: 'Sales Order', dateColumn: 'order_date', noColumn: 'order_no',
        build(req) {
            return db('sales_orders')
                .leftJoin('customers', 'customers.id', 'sales_orders.customer_id')
                .where('sales_orders.company_id', req.companyId)
                .where('sales_orders.created_by', req.user.sub)
                .whereNull('sales_orders.deleted_at')
                .select(
                    db.raw("'sales_order' as kind"), db.raw("'Sales Order' as label"),
                    'sales_orders.id as id', 'sales_orders.order_no as voucher_no',
                    'sales_orders.order_date as date', 'customers.name as party',
                    'sales_orders.total as amount', 'sales_orders.order_status as status',
                );
        },
    },
    {
        table: 'purchase_orders', label: 'Purchase Order', dateColumn: 'order_date', noColumn: 'order_no',
        build(req) {
            return db('purchase_orders')
                .leftJoin('suppliers', 'suppliers.id', 'purchase_orders.supplier_id')
                .where('purchase_orders.company_id', req.companyId)
                .where('purchase_orders.created_by', req.user.sub)
                .whereNull('purchase_orders.deleted_at')
                .select(
                    db.raw("'purchase_order' as kind"), db.raw("'Purchase Order' as label"),
                    'purchase_orders.id as id', 'purchase_orders.order_no as voucher_no',
                    'purchase_orders.order_date as date', 'suppliers.name as party',
                    'purchase_orders.total as amount', 'purchase_orders.order_status as status',
                );
        },
    },
    {
        table: 'delivery_notes', label: 'Delivery Note', dateColumn: 'note_date', noColumn: 'note_no',
        build(req) {
            return db('delivery_notes')
                .leftJoin('customers', 'customers.id', 'delivery_notes.customer_id')
                .where('delivery_notes.company_id', req.companyId)
                .where('delivery_notes.created_by', req.user.sub)
                .whereNull('delivery_notes.deleted_at')
                .select(
                    db.raw("'delivery_note' as kind"), db.raw("'Delivery Note' as label"),
                    'delivery_notes.id as id', 'delivery_notes.note_no as voucher_no',
                    'delivery_notes.note_date as date', 'customers.name as party',
                    'delivery_notes.total as amount', 'delivery_notes.delivery_status as status',
                );
        },
    },
    {
        table: 'receipt_notes', label: 'Receipt Note', dateColumn: 'note_date', noColumn: 'note_no',
        build(req) {
            return db('receipt_notes')
                .leftJoin('suppliers', 'suppliers.id', 'receipt_notes.supplier_id')
                .where('receipt_notes.company_id', req.companyId)
                .where('receipt_notes.created_by', req.user.sub)
                .whereNull('receipt_notes.deleted_at')
                .select(
                    db.raw("'receipt_note' as kind"), db.raw("'Receipt Note' as label"),
                    'receipt_notes.id as id', 'receipt_notes.note_no as voucher_no',
                    'receipt_notes.note_date as date', 'suppliers.name as party',
                    'receipt_notes.total as amount', 'receipt_notes.receipt_status as status',
                );
        },
    },
    {
        // Covers BOTH voucher kinds this table holds (type = 'sales'|'purchase') —
        // see the header comment. kind/label are computed PER ROW from `type`.
        table: 'invoices', label: 'Invoice', dateColumn: 'invoice_date', noColumn: 'invoice_no',
        build(req) {
            return db('invoices')
                .leftJoin('customers', 'customers.id', 'invoices.customer_id')
                .leftJoin('suppliers', 'suppliers.id', 'invoices.supplier_id')
                .where('invoices.company_id', req.companyId)
                .where('invoices.created_by', req.user.sub)
                .whereNull('invoices.deleted_at')
                .select(
                    db.raw("case when invoices.type = 'sales' then 'sales_invoice' else 'purchase_invoice' end as kind"),
                    db.raw("case when invoices.type = 'sales' then 'Sales Invoice' else 'Purchase Invoice' end as label"),
                    'invoices.id as id', 'invoices.invoice_no as voucher_no',
                    'invoices.invoice_date as date',
                    db.raw('coalesce(customers.name, suppliers.name) as party'),
                    'invoices.total as amount', 'invoices.status as status',
                );
        },
    },
    {
        // Covers BOTH voucher kinds this table holds (type = 'payment'|'receipt').
        table: 'payments', label: 'Payment', dateColumn: 'payment_date', noColumn: 'voucher_no',
        build(req) {
            return db('payments')
                .leftJoin('suppliers', 'suppliers.id', 'payments.supplier_id')
                .leftJoin('customers', 'customers.id', 'payments.customer_id')
                .where('payments.company_id', req.companyId)
                .where('payments.created_by', req.user.sub)
                .whereNull('payments.deleted_at')
                .select(
                    db.raw("case when payments.type = 'receipt' then 'receipt_voucher' else 'payment_voucher' end as kind"),
                    db.raw("case when payments.type = 'receipt' then 'Receipt' else 'Payment' end as label"),
                    'payments.id as id', 'payments.voucher_no as voucher_no',
                    'payments.payment_date as date',
                    db.raw('coalesce(suppliers.name, customers.name) as party'),
                    'payments.amount as amount', 'payments.status as status',
                );
        },
    },
    {
        table: 'journals', label: 'Journal', dateColumn: 'journal_date', noColumn: 'voucher_no',
        build(req) {
            return db('journals')
                .where('journals.company_id', req.companyId)
                .where('journals.created_by', req.user.sub)
                .whereNull('journals.deleted_at')
                .select(
                    db.raw("'journal' as kind"), db.raw("coalesce(journals.vch_type, 'Journal') as label"),
                    'journals.id as id', 'journals.voucher_no as voucher_no',
                    'journals.journal_date as date',
                    db.raw("(journals.dr_ledger || ' / ' || journals.cr_ledger) as party"),
                    'journals.amount as amount', 'journals.status as status',
                );
        },
    },
];

function parsePagination(query) {
    let page    = parseInt(query.page, 10);
    let perPage = parseInt(query.per_page, 10);
    if (!Number.isInteger(page)    || page    < 1) page    = 1;
    if (!Number.isInteger(perPage) || perPage < 1) perPage = DEFAULT_PER_PAGE;
    if (perPage > MAX_PER_PAGE) perPage = MAX_PER_PAGE;
    return { page, perPage };
}

/** GET /my/vouchers — this user's own vouchers across every family, newest first. */
async function list(req, res) {
    if (!req.user || !req.user.sub) return R.errorResponse(res, OOPS_MSG, 500);
    try {
        const { page, perPage } = parsePagination(req.query);

        const subqueries = VOUCHER_SOURCES.map((s) => s.build(req));
        const [first, ...rest] = subqueries;
        const unioned = rest.reduce((qb, sq) => qb.unionAll(sq), first);

        // Wrap the UNION ALL as a subquery so we can count / order / paginate
        // over the combined result set in one place.
        const totalRow = await db.count('* as c').from(unioned.as('u')).first();
        const total = Number(totalRow ? totalRow.c : 0);

        const rows = await db.select('*').from(unioned.as('u'))
            .orderBy('date', 'desc').orderBy('id', 'desc')
            .limit(perPage).offset((page - 1) * perPage);

        return R.successResponse(res, { data: rows, meta: { total, page, per_page: perPage } });
    } catch (err) {
        console.error('myEntries.list error:', err);
        return R.errorResponse(res, OOPS_MSG, 500);
    }
}

module.exports = { list, VOUCHER_SOURCES };
