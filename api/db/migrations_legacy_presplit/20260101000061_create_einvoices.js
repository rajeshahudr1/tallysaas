'use strict';

/**
 * 20260101000061_create_einvoices.js
 *
 * e-Invoice (GST IRN) + e-Way Bill — one row per sales invoice. GSP-READY: the
 * IRP payload is built + stored; IRN/QR/ack + e-way fields are filled either by
 * a future GSP API call OR manually (paste from the GST portal). Status tracks
 * pending → generated → cancelled | failed.
 *
 * Also seeds a first-class 'einvoice' RBAC module (per-license gated like the
 * other new modules).
 */

exports.up = async function up(knex) {
    await knex.schema.createTable('einvoices', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable()
            .references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('invoice_id').notNullable()
            .references('id').inTable('invoices').onDelete('CASCADE');

        // e-invoice (IRN)
        t.string('irn', 128);
        t.string('ack_no', 40);
        t.timestamp('ack_date', { useTz: true });
        t.text('qr_code');                     // signed QR payload string

        // e-way bill
        t.string('ewb_no', 30);
        t.date('ewb_date');
        t.timestamp('ewb_valid_until', { useTz: true });
        t.string('transporter', 191);
        t.string('transporter_id', 40);
        t.string('vehicle_no', 30);
        t.decimal('distance_km', 10, 2);

        // status + the IRP payload built from the invoice
        t.text('status').notNullable().defaultTo('pending');   // pending | generated | cancelled | failed
        t.jsonb('payload');
        t.text('error');
        t.timestamp('generated_at', { useTz: true });

        t.bigInteger('created_by').nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.timestamps(true, true);
        t.timestamp('deleted_at', { useTz: true }).nullable();

        t.unique('invoice_id', 'uq_einvoices_invoice');        // one e-invoice per invoice
        t.index(['company_id', 'status'], 'idx_einvoices_company_status');
    });

    // ── First-class 'einvoice' RBAC module ─────────────────────────────────────
    const ACTIONS = ['view', 'create', 'edit', 'delete', 'export'];
    const permIds = [];
    for (const action of ACTIONS) {
        const slug = `einvoice.${action}`;
        let row = await knex('permissions').where('slug', slug).first('id');
        if (!row) {
            const [ins] = await knex('permissions').insert({ module: 'einvoice', action, slug }).returning('id');
            row = ins;
        }
        permIds.push(row.id);
    }
    const adminRoles = await knex('roles').whereNull('company_id').whereIn('slug', ['super-admin', 'company-admin']).select('id');
    for (const r of adminRoles) {
        for (const pid of permIds) {
            await knex('role_permissions').insert({ role_id: r.id, permission_id: pid }).onConflict(['role_id', 'permission_id']).ignore();
        }
    }
    const explicitLics = await knex('license_permissions').distinct('license_id').pluck('license_id');
    for (const lid of explicitLics) {
        for (const pid of permIds) {
            const exists = await knex('license_permissions').where({ license_id: lid, permission_id: pid }).first('license_id');
            if (!exists) await knex('license_permissions').insert({ license_id: lid, permission_id: pid });
        }
    }
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('einvoices');
};
