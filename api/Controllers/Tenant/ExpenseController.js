'use strict';

/**
 * api/Controllers/Tenant/ExpenseController.js
 *
 * Tenant CRUD for recorded business expenses, wired through the crudController
 * factory. A LEFT JOIN to expense_categories adds a friendly `category` label to
 * list/get rows. Company scoping, soft-delete, pagination, search, history and
 * the response envelope all live in the factory.
 */

const crud = require('../../Helpers/crudController');

const LIST_COLUMNS = ['expenses.*', 'expense_categories.name as category'];
const SEARCH_COLS  = ['expenses.vendor', 'expenses.reference', 'expense_categories.name'];

function baseQuery(database) {
    return database('expenses')
        .leftJoin('expense_categories', 'expense_categories.id', 'expenses.category_id');
}

const UPDATABLE = ['category_id', 'vendor', 'expense_date', 'amount', 'payment_mode', 'reference', 'notes', 'status'];

function buildInsert(body) {
    return {
        category_id:  body.category_id,
        vendor:       body.vendor,
        expense_date: body.expense_date,
        amount:       body.amount,
        payment_mode: body.payment_mode,
        reference:    body.reference,
        notes:        body.notes,
        status:       body.status,
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
    table:       'expenses',
    notFound:    'Expense not found.',
    tenantCol:   'company_id',
    listColumns: LIST_COLUMNS,
    listOrder:   [['expenses.expense_date', 'desc'], ['expenses.id', 'desc']],
    searchCols:  SEARCH_COLS,
    // Extra sortable UI keys (name/status/created_at sort by default).
    sortable: {
        category:     'expense_categories.name',
        amount:       'expenses.amount',
        expense_date: 'expenses.expense_date',
        vendor:       'expenses.vendor',
    },
    // Filter dropdowns (?category=... / ?payment_mode=...) → WHERE.
    filters: {
        category:     (qb, v) => qb.where('expense_categories.name', v),
        payment_mode: (qb, v) => qb.where('expenses.payment_mode', v),
    },
    baseQuery,
    buildInsert,
    buildUpdate,
});

module.exports = {
    list:    controller.list,
    get:     controller.get,
    create:  controller.create,
    update:  controller.update,
    destroy: controller.destroy,
};
