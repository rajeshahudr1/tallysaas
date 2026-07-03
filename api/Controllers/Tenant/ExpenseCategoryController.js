'use strict';

/**
 * api/Controllers/Tenant/ExpenseCategoryController.js
 *
 * Tenant CRUD for expense categories (Rent, Salaries, Utilities …) — a flat
 * per-company list, wired through the crudController factory (same as
 * CategoryController but without the parent tree). Company scoping, soft-delete,
 * pagination, search and the response envelope all live in the factory.
 */

const crud = require('../../Helpers/crudController');

const UPDATABLE = ['name', 'status'];

const controller = crud.build({
    table:       'expense_categories',
    notFound:    'Expense category not found.',
    tenantCol:   'company_id',
    listColumns: ['expense_categories.*'],
    listOrder:   [['expense_categories.id', 'desc']],
    searchCols:  ['expense_categories.name'],
    buildInsert: (body) => ({ name: body.name, status: body.status }),
    buildUpdate: (body) => {
        const patch = {};
        for (const k of UPDATABLE) {
            if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
        }
        return patch;
    },
});

module.exports = {
    list:    controller.list,
    get:     controller.get,
    create:  controller.create,
    update:  controller.update,
    destroy: controller.destroy,
};
