'use strict';

/**
 * 20260101000066_einvoice_enterprise.js
 *
 * e-Invoice + e-Way Bill — ENTERPRISE upgrade (Phase 1: schema foundation).
 * EXTENDS the existing flat `einvoices` table into a proper lifecycle model
 * (separate IRP + EWB status, provider/env, signed payloads, de-dup + idempotency)
 * and adds the supporting tables an enterprise GSP integration needs: per-call
 * API logs, per-action histories (cancellation / transport / validity), print
 * logs, an audit trail, encrypted GSP credentials, a per-GSTIN token cache,
 * per-license settings and a DB-backed retry/reconcile job queue.
 *
 * Fully additive. Existing einvoices rows keep working: the new status columns
 * back-fill from the legacy `status` in the controller, and every new table is
 * independent. PostgreSQL + Knex (NOT SQL Server — that was a template mismatch;
 * this integrates with the live Node/Postgres app).
 */

exports.up = async function up(knex) {
    // ── 1) Extend einvoices into the enterprise lifecycle model ───────────────
    await knex.schema.alterTable('einvoices', (t) => {
        t.text('provider').notNullable().defaultTo('nic');          // nic | cleartax | mastersindia | vayana | adequare | avalara
        t.text('env').notNullable().defaultTo('sandbox');           // sandbox | production
        t.string('gstin', 15);                                      // supplier GSTIN used to report
        t.text('doc_type').notNullable().defaultTo('INV');          // INV | CRN | DBN
        t.text('supply_type').notNullable().defaultTo('B2B');       // B2B | SEZWP | SEZWOP | EXPWP | EXPWOP | DEXP

        // Split lifecycle — the legacy single `status` can't express "IRN done,
        // e-way pending" (= Partially Generated). These two drive the real state.
        t.text('irp_status').notNullable().defaultTo('pending');    // pending | generating | generated | failed | cancelled
        t.text('ewb_status').notNullable().defaultTo('not_required');// not_required | pending | generating | part_a | generated | cancelled | expired | rejected

        t.text('signed_invoice');                                   // IRP-signed invoice JWT
        t.text('signed_qr');                                        // IRP-signed QR JWT (rendered as the QR image)
        t.string('idempotency_key', 64);                            // per generate attempt — kills double-IRN on retry/timeout
        t.string('dedup_hash', 80);                                 // supplierGSTIN|docType|docNo|FY — client-side duplicate guard
        t.text('ewb_part');                                         // A (Part-A only) | AB (with vehicle)
        t.text('transport_mode');                                   // 1 Road | 2 Rail | 3 Air | 4 Ship | 5 In-transit
        t.text('vehicle_type');                                     // R Regular | O Over-Dimensional Cargo
        t.timestamp('cancelled_at', { useTz: true });
        t.text('cancel_reason');
        t.jsonb('hsn_summary');                                     // computed HSN-wise rollup (for print + GSTR-1)
        t.jsonb('tax_summary');                                     // cgst/sgst/igst/cess rollup

        t.index('dedup_hash', 'idx_einvoices_dedup_hash');
        t.index(['company_id', 'irp_status'], 'idx_einvoices_company_irp');
        t.index(['company_id', 'ewb_status'], 'idx_einvoices_company_ewb');
    });

    // ── 2) Per-call API logs (both directions, masked) — the "API Logs" tab ───
    await knex.schema.createTable('einvoice_api_logs', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('einvoice_id').nullable().references('id').inTable('einvoices').onDelete('CASCADE');
        t.text('provider').notNullable();
        t.text('env').notNullable();
        t.text('action').notNullable();          // authenticate | generate_irn | cancel_irn | generate_ewb | update_vehicle | extend_validity | cancel_ewb | get_irn | pin_distance
        t.text('endpoint');
        t.integer('http_status');
        t.string('nic_status_code', 20);         // NIC application status / error code
        t.boolean('success').notNullable().defaultTo(false);
        t.integer('latency_ms');
        t.jsonb('request');                      // masked (no plaintext token/creds)
        t.jsonb('response');                     // masked
        t.text('error');
        t.bigInteger('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

        t.index(['company_id', 'einvoice_id'], 'idx_eapilogs_company_einvoice');
        t.index(['company_id', 'action'], 'idx_eapilogs_company_action');
        t.index('created_at', 'idx_eapilogs_created_at');
    });

    // ── 3) Transport history (Part-B / vehicle updates) ───────────────────────
    await knex.schema.createTable('einvoice_transport_history', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('einvoice_id').notNullable().references('id').inTable('einvoices').onDelete('CASCADE');
        t.string('ewb_no', 30);
        t.string('vehicle_no', 30);
        t.text('from_place');
        t.text('transport_mode');
        t.text('reason_code');                   // 1 Break Down | 2 Transshipment | 3 Others | 4 First Time
        t.text('remarks');
        t.bigInteger('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.index('einvoice_id', 'idx_etransport_einvoice');
    });

    // ── 4) Cancellation history (IRN + e-Way) ─────────────────────────────────
    await knex.schema.createTable('einvoice_cancellation_history', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('einvoice_id').notNullable().references('id').inTable('einvoices').onDelete('CASCADE');
        t.text('kind').notNullable();            // irn | ewb
        t.string('doc_ref', 128);                // IRN or EWB no cancelled
        t.text('reason_code');                   // IRN: 1 Dup | 2 Data entry | 3 Order cancelled | 4 Others
        t.text('remarks');
        t.bigInteger('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.index('einvoice_id', 'idx_ecancel_einvoice');
    });

    // ── 5) Validity-extension history (e-Way) ─────────────────────────────────
    await knex.schema.createTable('einvoice_validity_history', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('einvoice_id').notNullable().references('id').inTable('einvoices').onDelete('CASCADE');
        t.string('ewb_no', 30);
        t.timestamp('extended_until', { useTz: true });
        t.decimal('remaining_distance', 10, 2);
        t.text('reason_code');
        t.text('remarks');
        t.string('vehicle_no', 30);
        t.bigInteger('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.index('einvoice_id', 'idx_evalidity_einvoice');
    });

    // ── 6) Print logs (print / download / email / whatsapp) ───────────────────
    await knex.schema.createTable('einvoice_print_logs', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('einvoice_id').notNullable().references('id').inTable('einvoices').onDelete('CASCADE');
        t.text('template');                      // a4 | thermal
        t.text('doc_type');                      // invoice | einvoice | eway | combined
        t.text('channel');                       // print | download | email | whatsapp
        t.bigInteger('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.index('einvoice_id', 'idx_eprint_einvoice');
    });

    // ── 7) Audit trail (who did what) ─────────────────────────────────────────
    await knex.schema.createTable('einvoice_audit_logs', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('einvoice_id').nullable().references('id').inTable('einvoices').onDelete('CASCADE');
        t.text('action').notNullable();
        t.bigInteger('actor_id').nullable().references('id').inTable('users').onDelete('SET NULL');
        t.string('actor_name', 191);
        t.string('ip', 64);
        t.jsonb('before');
        t.jsonb('after');
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.index(['company_id', 'einvoice_id'], 'idx_eaudit_company_einvoice');
    });

    // ── 8) GSP credentials (ENCRYPTED at rest — AES-256-GCM in the app layer) ──
    await knex.schema.createTable('gsp_credentials', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('license_id').notNullable().references('id').inTable('licenses').onDelete('CASCADE');
        t.text('provider').notNullable();
        t.text('env').notNullable();
        t.string('gstin', 15);
        t.text('base_url');
        t.text('username');
        t.text('password_enc');                  // ciphertext (never plaintext)
        t.text('client_id_enc');
        t.text('client_secret_enc');
        t.text('api_key_enc');
        t.text('extra_enc');                     // any provider-specific extra creds (ciphertext JSON)
        t.boolean('active').notNullable().defaultTo(true);
        t.bigInteger('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
        t.timestamps(true, true);
        t.unique(['license_id', 'provider', 'env', 'gstin'], 'uq_gsp_cred_scope');
    });

    // ── 9) Token cache (per license/provider/env/GSTIN) ───────────────────────
    await knex.schema.createTable('gsp_tokens', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('license_id').notNullable().references('id').inTable('licenses').onDelete('CASCADE');
        t.text('provider').notNullable();
        t.text('env').notNullable();
        t.string('gstin', 15);
        t.text('auth_token');                    // NIC AuthToken
        t.text('sek');                           // NIC symmetric session key (encrypted)
        t.timestamp('expires_at', { useTz: true });
        t.timestamps(true, true);
        t.unique(['license_id', 'provider', 'env', 'gstin'], 'uq_gsp_token_scope');
    });

    // ── 10) Per-license e-Invoice settings ────────────────────────────────────
    await knex.schema.createTable('einvoice_settings', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('license_id').notNullable().references('id').inTable('licenses').onDelete('CASCADE');
        t.text('default_provider').notNullable().defaultTo('nic');
        t.text('env').notNullable().defaultTo('sandbox');
        t.boolean('auto_generate').notNullable().defaultTo(false);   // auto IRN on invoice approval
        t.boolean('auto_eway').notNullable().defaultTo(false);       // auto e-way when transport present
        t.boolean('auto_distance').notNullable().defaultTo(true);    // PIN-to-PIN distance from NIC
        t.bigInteger('updated_by').nullable().references('id').inTable('users').onDelete('SET NULL');
        t.timestamps(true, true);
        t.unique('license_id', 'uq_einvoice_settings_license');
    });

    // ── 11) DB-backed retry / reconcile job queue ─────────────────────────────
    await knex.schema.createTable('einvoice_jobs', (t) => {
        t.bigIncrements('id').primary();
        t.bigInteger('company_id').notNullable().references('id').inTable('companies').onDelete('CASCADE');
        t.bigInteger('einvoice_id').nullable().references('id').inTable('einvoices').onDelete('CASCADE');
        t.text('type').notNullable();            // generate_irn | generate_eway | reconcile_irn | expiry_scan
        t.text('status').notNullable().defaultTo('queued');  // queued | running | done | failed
        t.integer('attempts').notNullable().defaultTo(0);
        t.integer('max_attempts').notNullable().defaultTo(5);
        t.timestamp('next_run_at', { useTz: true }).defaultTo(knex.fn.now());
        t.text('last_error');
        t.jsonb('payload');
        t.timestamps(true, true);
        t.index(['status', 'next_run_at'], 'idx_einvoice_jobs_due');
    });
};

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('einvoice_jobs');
    await knex.schema.dropTableIfExists('einvoice_settings');
    await knex.schema.dropTableIfExists('gsp_tokens');
    await knex.schema.dropTableIfExists('gsp_credentials');
    await knex.schema.dropTableIfExists('einvoice_audit_logs');
    await knex.schema.dropTableIfExists('einvoice_print_logs');
    await knex.schema.dropTableIfExists('einvoice_validity_history');
    await knex.schema.dropTableIfExists('einvoice_cancellation_history');
    await knex.schema.dropTableIfExists('einvoice_transport_history');
    await knex.schema.dropTableIfExists('einvoice_api_logs');
    await knex.schema.alterTable('einvoices', (t) => {
        t.dropColumn('provider');
        t.dropColumn('env');
        t.dropColumn('gstin');
        t.dropColumn('doc_type');
        t.dropColumn('supply_type');
        t.dropColumn('irp_status');
        t.dropColumn('ewb_status');
        t.dropColumn('signed_invoice');
        t.dropColumn('signed_qr');
        t.dropColumn('idempotency_key');
        t.dropColumn('dedup_hash');
        t.dropColumn('ewb_part');
        t.dropColumn('transport_mode');
        t.dropColumn('vehicle_type');
        t.dropColumn('cancelled_at');
        t.dropColumn('cancel_reason');
        t.dropColumn('hsn_summary');
        t.dropColumn('tax_summary');
    });
};
