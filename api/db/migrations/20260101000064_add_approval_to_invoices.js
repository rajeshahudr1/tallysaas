'use strict';

/**
 * 20260101000064_add_approval_to_invoices.js
 *
 * Field-sales approval workflow (SFA Phase 1). A salesman who cuts an invoice in
 * the field creates it as approval_status='pending'; a company admin then
 * Approves it (→ it counts as a real invoice AND becomes eligible for Tally
 * sync) or Rejects it with a reason. Admin / web-created invoices default to
 * 'approved', so ALL existing rows + the current behaviour are unchanged (they
 * keep counting + syncing exactly as before — the default backfills every row).
 *
 * The Tally sync-gate (AgentController pending-vouchers query) additionally
 * requires approval_status='approved', so a pending/rejected field invoice never
 * reaches Tally until an admin approves it.
 *
 *   approval_status : 'pending' | 'approved' | 'rejected'   (default 'approved')
 *   approved_by     : user who approved (FK users, SET NULL)
 *   approved_at     : when it was approved
 *   rejected_reason : why it was rejected (shown back to the salesman)
 */

exports.up = async function (knex) {
    await knex.schema.alterTable('invoices', (t) => {
        t.text('approval_status').notNullable().defaultTo('approved');
        t.bigInteger('approved_by')
            .nullable()
            .references('id').inTable('users')
            .onDelete('SET NULL');
        t.timestamp('approved_at', { useTz: true }).nullable();
        t.text('rejected_reason').nullable();

        t.index(['company_id', 'approval_status'], 'idx_invoices_company_approval');
    });
};

exports.down = async function (knex) {
    await knex.schema.alterTable('invoices', (t) => {
        t.dropIndex(['company_id', 'approval_status'], 'idx_invoices_company_approval');
        t.dropColumn('rejected_reason');
        t.dropColumn('approved_at');
        t.dropColumn('approved_by');
        t.dropColumn('approval_status');
    });
};
