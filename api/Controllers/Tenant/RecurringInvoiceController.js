'use strict';

/**
 * api/Controllers/Tenant/RecurringInvoiceController.js
 *
 * Tenant CRUD for recurring-invoice templates (crudController factory, with a
 * LEFT JOIN to customers for a `customer` label) + a bespoke "generate now"
 * action that cuts one invoice immediately from a template.
 */

const crud = require('../../Helpers/crudController');
const db   = require('../../config/db').db;
const R    = require('../../Helpers/response');
const { generateNow } = require('../../Helpers/recurringInvoices');

const LIST_COLUMNS = ['recurring_invoices.*', 'customers.name as customer'];
const SEARCH_COLS  = ['recurring_invoices.title', 'customers.name'];

function baseQuery(database) {
    return database('recurring_invoices')
        .leftJoin('customers', 'customers.id', 'recurring_invoices.customer_id');
}

const UPDATABLE = [
    'customer_id', 'title', 'description', 'amount', 'gst_rate',
    'frequency', 'due_days', 'start_date', 'next_run_date', 'end_date', 'status',
];

function buildInsert(body) {
    return {
        customer_id:   body.customer_id,
        title:         body.title,
        description:   body.description,
        amount:        body.amount,
        gst_rate:      body.gst_rate,
        frequency:     body.frequency,
        due_days:      body.due_days,
        start_date:    body.start_date,
        next_run_date: body.start_date,   // first run = the start date
        end_date:      body.end_date,
        status:        body.status,
    };
}

function buildUpdate(body) {
    const patch = {};
    for (const k of UPDATABLE) {
        if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
    }
    return patch;
}

const controller = crud.build({
    table:       'recurring_invoices',
    notFound:    'Recurring invoice not found.',
    tenantCol:   'company_id',
    listColumns: LIST_COLUMNS,
    listOrder:   [['recurring_invoices.next_run_date', 'asc'], ['recurring_invoices.id', 'desc']],
    searchCols:  SEARCH_COLS,
    sortable: {
        customer:      'customers.name',
        amount:        'recurring_invoices.amount',
        next_run_date: 'recurring_invoices.next_run_date',
        title:         'recurring_invoices.title',
    },
    filters: {
        frequency: (qb, v) => qb.where('recurring_invoices.frequency', v),
    },
    baseQuery,
    buildInsert,
    buildUpdate,
});

/** POST /recurring-invoices/:id/generate — cut one invoice NOW from a template. */
async function generate(req, res) {
    try {
        const id = Number(req.params.id);
        const rec = await db('recurring_invoices')
            .where({ id, company_id: req.companyId }).whereNull('deleted_at').first();
        if (!rec) return R.errorResponse(res, 'Recurring invoice not found.', 404);
        rec.created_by = req.user ? req.user.sub : null;
        const inv = await generateNow(rec);
        return R.successResponse(res, { invoice_id: inv.id, invoice_no: inv.invoice_no },
            `Invoice ${inv.invoice_no} generated.`);
    } catch (err) {
        console.error('recurring.generate error:', err);
        return R.errorResponse(res, 'Oops..Something went wrong. Please try again.', 500);
    }
}

module.exports = { ...controller, generate };
